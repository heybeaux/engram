/**
 * Dataset loader for LongMemEval.
 *
 * Supports two sources:
 *  1. Local fixture file (smoke-20.json) — always available, used for CI/smoke runs.
 *  2. HuggingFace dataset download — HF_TOKEN (or HUGGINGFACE_TOKEN) used if set.
 *
 * Full subset is loaded from the cleaned mirror:
 *   xiaowu0162/longmemeval-cleaned -> longmemeval_s_cleaned.json (~500 questions).
 * The cleaned mirror is public; token is optional but improves rate limits.
 *
 * No silent fallback to smoke fixture on HTTP errors — failures throw.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import type { LongMemEvalQuestion, LmeDataset, LmeCategory, RunConfig, RoundEntry } from './types';

const FIXTURE_PATH =
  process.env.LONGMEMEVAL_FIXTURE_PATH ??
  path.join(__dirname, '..', 'fixtures', 'smoke-20.json');

/**
 * Load dataset according to run config.
 * - subset=smoke: always load from fixture file
 * - subset=full: try HuggingFace, fall back to fixture with a warning
 */
export async function loadDataset(config: Pick<RunConfig, 'subset' | 'limit' | 'category'>): Promise<LongMemEvalQuestion[]> {
  let questions: LongMemEvalQuestion[];

  if (config.subset === 'smoke') {
    questions = loadFixture();
  } else {
    // No silent fallback: a 404/auth failure on the full subset must surface
    // loudly so the harness doesn't quietly run a 20-question smoke set
    // against benchmarks expecting 500.
    questions = await fetchFromHuggingFace();
  }

  if (config.category) {
    questions = questions.filter(q => q.category === config.category);
  }

  if (config.limit !== undefined && config.limit > 0) {
    questions = questions.slice(0, config.limit);
  }

  return questions;
}

/** Load the local smoke-20 fixture. */
export function loadFixture(fixturePath: string = FIXTURE_PATH): LongMemEvalQuestion[] {
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Smoke fixture not found at: ${fixturePath}`);
  }
  const raw = fs.readFileSync(fixturePath, 'utf-8');
  const data = JSON.parse(raw) as { questions: LongMemEvalQuestion[] } | LongMemEvalQuestion[];
  const questions = Array.isArray(data) ? data : data.questions;
  validateQuestions(questions);
  return questions;
}

/**
 * Download the LongMemEval "S" subset from the cleaned HuggingFace mirror.
 * HF_TOKEN / HUGGINGFACE_TOKEN are optional (the cleaned dataset is public)
 * but recommended to avoid rate limits.
 */
export async function fetchFromHuggingFace(): Promise<LongMemEvalQuestion[]> {
  const token = process.env.HF_TOKEN ?? process.env.HUGGINGFACE_TOKEN;

  const url =
    'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json';

  // Cache to disk so resume/restart doesn't re-download.
  const cacheDir = path.join(__dirname, '..', 'data');
  const cachePath = path.join(cacheDir, 'longmemeval_s_cleaned.json');
  let raw: string;

  if (fs.existsSync(cachePath)) {
    console.log(`[loader] Using cached dataset: ${cachePath}`);
    raw = fs.readFileSync(cachePath, 'utf-8');
  } else {
    console.log(
      `[loader] Downloading longmemeval_s_cleaned.json from HuggingFace${token ? ' (authenticated)' : ' (anonymous)'}...`,
    );
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    raw = await httpGet(url, headers, 600_000);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(cachePath, raw, 'utf-8');
    console.log(`[loader] Dataset cached to ${cachePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Failed to parse LongMemEval JSON from HuggingFace');
  }

  const rawItems: unknown[] = Array.isArray(parsed)
    ? parsed
    : (parsed as LmeDataset).questions;

  // Normalize HuggingFace format to LongMemEvalQuestion
  // Real dataset uses: question_type, haystack_sessions (array of session arrays), answer
  // Smoke fixture uses: category, session_history (flat array), answer
  const CATEGORY_MAP: Record<string, LmeCategory> = {
    'single-session-user': 'single-session-user',
    'single-session-assistant': 'single-session-assistant',
    'single-session-preference': 'single-session-preference',
    'multi-session': 'multi-session-user',
    'multi-session-user': 'multi-session-user',
    'temporal-reasoning': 'temporal-reasoning-ability',
    'temporal-reasoning-ability': 'temporal-reasoning-ability',
    'knowledge-update': 'knowledge-update',
  };

  const questions: LongMemEvalQuestion[] = (rawItems as any[]).map((item: any) => {
    // If already in normalized format (smoke fixture), normalize answer and pass through
    if (Array.isArray(item.session_history)) {
      const ans = item.answer ?? '';
      return {
        ...item,
        answer: typeof ans === 'string' ? ans : String(ans),
      } as LongMemEvalQuestion;
    }
    // Normalize HuggingFace format
    const questionType: string = item.question_type ?? item.category ?? 'single-session-user';
    const category: LmeCategory = CATEGORY_MAP[questionType] ?? 'single-session-user';
    // Combine haystack_sessions into a single session_history, weaving in
    // session-boundary markers (with session-level dates when available) so
    // multi-session structure and temporal anchors survive flat ingestion.
    const sessions: RoundEntry[][] = Array.isArray(item.haystack_sessions)
      ? item.haystack_sessions
      : [];
    const sessionDates: string[] = Array.isArray(item.haystack_dates)
      ? item.haystack_dates
      : [];
    const session_history: RoundEntry[] = buildSessionHistory(sessions, sessionDates);
    // Normalize answer to string — integer answers crash judge's .trim()
    const rawAnswer = item.answer ?? '';
    const answer = typeof rawAnswer === 'string' ? rawAnswer : String(rawAnswer);
    return {
      question_id: item.question_id,
      question: item.question,
      answer,
      category,
      session_history,
      sessions: sessions.length > 1 ? sessions : undefined,
      question_date: item.question_date ?? undefined,
    } as LongMemEvalQuestion;
  });

  validateQuestions(questions);
  // Sanity-check: cleaned "S" subset is ~500 questions. Warn (not throw) on
  // drift so a future dataset revision doesn't hard-break the harness.
  if (questions.length < 400 || questions.length > 600) {
    console.warn(
      `[loader] Expected ~500 questions for "S" subset, got ${questions.length}. ` +
        `Mirror may have changed.`,
    );
  }
  return questions;
}

/** Minimal validation to catch malformed fixture data early. */
export function validateQuestions(questions: LongMemEvalQuestion[]): void {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('Dataset must be a non-empty array of questions');
  }
  for (const q of questions) {
    if (!q.question_id || typeof q.question_id !== 'string') {
      throw new Error(`Question missing question_id: ${JSON.stringify(q)}`);
    }
    if (!q.question || typeof q.question !== 'string') {
      throw new Error(`Question ${q.question_id} missing question field`);
    }
    if (!Array.isArray(q.session_history)) {
      throw new Error(`Question ${q.question_id} missing session_history array`);
    }
  }
}

/**
 * Combine per-session round arrays into a single history, inserting a
 * synthetic session-boundary marker before each session.
 *
 * Markers are inserted when there is more than one session (multi-session
 * questions) OR when a session-level date is available (temporal anchor for
 * temporal-reasoning questions). Single undated sessions stay marker-free.
 *
 * When a session-level date is available it is also propagated onto each
 * round that lacks its own timestamp. This matters because ROUND chunking
 * stores chunks individually and the recall API's memory `timestamp` is
 * ingest-time createdAt (identical for every chunk of a question) — the
 * in-text date is the only conversation-time signal retrieval can surface.
 */
export function buildSessionHistory(
  sessions: RoundEntry[][],
  sessionDates: string[] = [],
): RoundEntry[] {
  const history: RoundEntry[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const date = sessionDates[i];
    if (sessions.length > 1 || date) {
      history.push({
        role: 'system',
        content: `--- Session ${i + 1}${date ? ` (${date})` : ''} ---`,
        marker: true,
      });
    }
    for (const round of sessions[i]) {
      history.push(
        date && !round.timestamp ? { ...round, timestamp: date } : round,
      );
    }
  }
  return history;
}

/**
 * Format a session history into a text transcript for bulkTextImport.
 * Uses "User: / Assistant:" format that chunkByRound() recognises.
 *
 * Round timestamps (when present) are written immediately after the speaker
 * label — `User: [<timestamp>] <content>` — so temporal facts survive
 * ingestion. The timestamp must come AFTER the label: chunkByRound() splits
 * on /^(user|assistant)\s*:/ at line start, so a leading "[ts] " prefix
 * would prevent round splitting and merge the whole transcript into one chunk.
 *
 * Session-boundary markers are emitted verbatim with no label.
 */
export function historyToTranscript(rounds: LongMemEvalQuestion['session_history']): string {
  return rounds
    .map(r => {
      if (r.marker) {
        return r.content;
      }
      const label = r.role === 'user' ? 'User' : r.role === 'assistant' ? 'Assistant' : 'System';
      const stamp = r.timestamp ? `[${r.timestamp}] ` : '';
      return `${label}: ${stamp}${r.content}`;
    })
    .join('\n\n');
}

/** Get the distinct categories in a question set. */
export function categoriesIn(questions: LongMemEvalQuestion[]): LmeCategory[] {
  return [...new Set(questions.map(q => q.category))] as LmeCategory[];
}

/** Simple HTTPS GET helper. */
function httpGet(url: string, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        httpGet(res.headers.location, headers, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        const errChunks: Buffer[] = [];
        res.on('data', (c: Buffer) => errChunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(errChunks).toString('utf-8').slice(0, 500);
          reject(new Error(`HTTP ${res.statusCode} from ${url}${body ? ` — ${body}` : ''}`));
        });
        res.on('error', reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}
