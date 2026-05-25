/**
 * Per-question ingest for the LongMemEval eval harness.
 *
 * Each question gets an isolated (agentId, userId, sessionId) so that
 * recall is scoped to just that question's session history — no cross-question
 * contamination in the DB.
 *
 * Uses bulkTextImport with granularity:"ROUND" (S1 / HEY-573).
 */

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
 * Reconstruct the isolated identity used by LongMemEval without reingesting.
 * This is safe because recall accepts either the internal Session CUID or the
 * stable externalId (`lme-<question_id>`) for session filtering.
 */
export function reuseIngestResult(questionId: string): IngestResult {
  const scopedId = `lme-${questionId}`;
  return {
    questionId,
    sessionId: scopedId,
    userId: scopedId,
    agentId: scopedId,
    memoryIds: [],
    chunks: 0,
  };
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

  const memories = buildRoundMemories(question.session_history);

  const body = {
    memories,
    context: {
      sessionId,
    },
    agentId,
  };

  const url = `${config.apiBase}/v1/memories/bulk`;
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

  const data = await response.json() as { created: number; chunks: number; memoryIds: string[]; sessionId?: string };

  return {
    questionId: question.question_id,
    // Use the CUID returned by the server (resolvedSessionId) so recall queries
    // can filter by sessions.id FK directly. Fall back to external string if
    // server is running an older build that doesn't return sessionId.
    sessionId: data.sessionId ?? sessionId,
    userId,
    agentId,
    memoryIds: data.memoryIds ?? [],
    chunks: data.chunks ?? data.created ?? 0,
  };
}

export function buildRoundMemories(
  rounds: LongMemEvalQuestion['session_history'],
): Array<{
  raw: string;
  layer: 'SESSION';
  sessionPosition: number;
  sourceTimestamp?: string;
  sourceTurnIndex: number;
}> {
  const memories: Array<{
    raw: string;
    layer: 'SESSION';
    sessionPosition: number;
    sourceTimestamp?: string;
    sourceTurnIndex: number;
  }> = [];

  let currentRound: string[] = [];
  let currentTimestamp: string | undefined;
  let position = 0;

  const flush = () => {
    if (currentRound.length === 0) return;
    memories.push({
      raw: currentRound.join('\n\n'),
      layer: 'SESSION',
      sessionPosition: position,
      sourceTimestamp: currentTimestamp,
      sourceTurnIndex: position,
    });
    position++;
    currentRound = [];
    currentTimestamp = undefined;
  };

  for (const round of rounds) {
    const label =
      round.role === 'user'
        ? 'User'
        : round.role === 'assistant'
          ? 'Assistant'
          : 'System';

    if (label === 'User' && currentRound.length > 0) {
      flush();
    }

    currentRound.push(`${label}: ${round.content}`);
    currentTimestamp ??= round.timestamp;
  }

  flush();
  return memories;
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

/** fetch with basic retry on 429 / 5xx */
async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
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
