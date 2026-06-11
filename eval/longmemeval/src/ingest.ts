/**
 * Per-question ingest for the LongMemEval eval harness.
 *
 * Each question gets an isolated (agentId, userId, sessionId) so that
 * recall is scoped to just that question's session history — no cross-question
 * contamination in the DB.
 *
 * Uses bulkTextImport with granularity:"ROUND" (S1 / HEY-573).
 */

import * as fs from 'fs';
import type { LongMemEvalQuestion, RunConfig } from './types';
import { historyToTranscript } from './loader';

export interface IngestResult {
  questionId: string;
  sessionId: string;
  userId: string;
  agentId: string;
  memoryIds: string[];
  chunks: number;
}

/**
 * Ingest a single question's session history into Engram.
 *
 * Creates an isolated (userId, agentId, sessionId) scoped to this question
 * so recall can filter by sessionId without cross-question bleed.
 */
export async function ingestQuestion(
  question: LongMemEvalQuestion,
  config: Pick<RunConfig, 'apiBase' | 'apiKey'>,
): Promise<IngestResult> {
  const agentId = `lme-${question.question_id}`;
  const userId = `lme-${question.question_id}`;
  const sessionId = `lme-${question.question_id}`;

  const transcript = historyToTranscript(question.session_history);

  const body = {
    text: transcript,
    granularity: 'ROUND',
    layer: 'SESSION',
    context: {
      sessionId,
    },
  };

  const url = `${config.apiBase}/v1/memories/bulk/text`;
  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AM-API-Key': config.apiKey,
      'X-AM-User-ID': userId,
      'X-AM-Agent-ID': agentId,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ingest failed for ${question.question_id}: HTTP ${response.status} — ${text}`);
  }

  const data = await response.json() as { created: number; chunks: number; memoryIds: string[] };

  return {
    questionId: question.question_id,
    sessionId,
    userId,
    agentId,
    memoryIds: data.memoryIds ?? [],
    chunks: data.chunks ?? data.created ?? 0,
  };
}

/**
 * Ingest all questions, sequentially to avoid overwhelming the embedding queue.
 * Returns a map of questionId → IngestResult.
 */
export async function ingestAll(
  questions: LongMemEvalQuestion[],
  config: Pick<RunConfig, 'apiBase' | 'apiKey'>,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, IngestResult>> {
  const results = new Map<string, IngestResult>();
  let done = 0;

  for (const question of questions) {
    const result = await ingestQuestion(question, config);
    results.set(question.question_id, result);
    done++;
    onProgress?.(done, questions.length);
  }

  return results;
}

interface IngestManifestEntry {
  questionId: string;
  chunks: number;
  timestamp: string;
}

/**
 * Load the set of already-ingested question IDs from an ingest manifest JSONL.
 * The manifest makes the batch-ingest phase resumable: re-running never
 * double-ingests a session (which would duplicate memories in the DB).
 */
export function loadIngestManifest(manifestPath: string): Set<string> {
  if (!fs.existsSync(manifestPath)) return new Set();
  const ids = new Set<string>();
  for (const line of fs.readFileSync(manifestPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as IngestManifestEntry;
      if (entry.questionId) ids.add(entry.questionId);
    } catch {
      // skip torn line from a crash mid-append
    }
  }
  return ids;
}

function appendManifestEntry(manifestPath: string, entry: IngestManifestEntry): void {
  fs.appendFileSync(manifestPath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Batch-ingest all questions up front with bounded concurrency, recording each
 * success to a manifest JSONL so the phase is resumable. Questions already in
 * the manifest are skipped. Throws on first failure (manifest preserves progress).
 */
export async function batchIngest(
  questions: LongMemEvalQuestion[],
  config: Pick<RunConfig, 'apiBase' | 'apiKey'>,
  manifestPath: string,
  concurrency = 4,
  onProgress?: (done: number, total: number) => void,
): Promise<{ ingested: number; skipped: number }> {
  const already = loadIngestManifest(manifestPath);
  const pending = questions.filter(q => !already.has(q.question_id));
  const skipped = questions.length - pending.length;

  let done = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      const question = pending[next++];
      const result = await ingestQuestion(question, config);
      appendManifestEntry(manifestPath, {
        questionId: question.question_id,
        chunks: result.chunks,
        timestamp: new Date().toISOString(),
      });
      done++;
      onProgress?.(done, pending.length);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, pending.length)) }, worker);
  await Promise.all(workers);

  return { ingested: done, skipped };
}

/**
 * Poll until the async embedding queue has drained for the given sessions.
 *
 * Probes each session with its own question text via /v1/memories/query
 * (vector search only hits once embeddings land). Probing the LAST-ingested
 * sessions is sufficient: the queue is FIFO, so if the tail is searchable the
 * head is too. Returns false on timeout.
 */
export async function waitForEmbeddingDrain(
  probes: Array<{ questionId: string; query: string }>,
  config: Pick<RunConfig, 'apiBase' | 'apiKey'>,
  timeoutMs = 180_000,
  pollMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const remaining = new Map(probes.map(p => [p.questionId, p.query]));

  while (remaining.size > 0 && Date.now() < deadline) {
    for (const [questionId, query] of [...remaining]) {
      const id = `lme-${questionId}`;
      const res = await fetchWithRetry(`${config.apiBase}/v1/memories/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AM-API-Key': config.apiKey,
          'X-AM-User-ID': id,
          'X-AM-Agent-ID': id,
        },
        body: JSON.stringify({ query, sessionId: id, limit: 1 }),
      });
      if (res.ok) {
        const data = await res.json() as { memories?: unknown[] };
        if ((data.memories?.length ?? 0) > 0) {
          remaining.delete(questionId);
        }
      }
    }
    if (remaining.size > 0) {
      await sleep(pollMs);
    }
  }

  return remaining.size === 0;
}

/** fetch with basic retry on 429 / network errors. Shared with recall.ts. */
export async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '5', 10);
        await sleep(retryAfter * 1000);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries - 1) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  throw lastError ?? new Error(`Failed to fetch ${url} after ${maxRetries} attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
