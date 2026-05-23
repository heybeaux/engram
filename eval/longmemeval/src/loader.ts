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

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'smoke-20.json');

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
    'single-session-preference': 'single-session-user', // treat as single-session-user
    'multi-session': 'multi-session-user',
    'multi-session-user': 'multi-session-user',
    'temporal-reasoning': 'temporal-reasoning-ability',
    'temporal-reasoning-ability': 'temporal-reasoning-ability',
    'knowledge-update': 'knowledge-update',
  };

  const questions: LongMemEvalQuestion[] = (rawItems as any[]).map((item: any) => {
    // If already in normalized format (smoke fixture), pass through
    if (Array.isArray(item.session_history)) {
      return item as LongMemEvalQuestion;
    }
    // Normalize HuggingFace format
    const questionType: string = item.question_type ?? item.category ?? 'single-session-user';
    const category: LmeCategory = CATEGORY_MAP[questionType] ?? 'single-session-user';
    // Flatten all haystack_sessions into a single session_history
    const sessions: RoundEntry[][] = Array.isArray(item.haystack_sessions)
      ? item.haystack_sessions
      : [];
    const session_history: RoundEntry[] = sessions.flat();
    return {
      question_id: item.question_id,
      question: item.question,
      answer: item.answer ?? '',
      category,
      session_history,
      sessions: sessions.length > 1 ? sessions : undefined,
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
 * Format a session history into a text transcript for bulkTextImport.
 * Uses "User: / Assistant:" format that chunkByRound() recognises.
 */
export function historyToTranscript(rounds: LongMemEvalQuestion['session_history']): string {
  return rounds
    .map(r => {
      const label = r.role === 'user' ? 'User' : r.role === 'assistant' ? 'Assistant' : 'System';
      return `${label}: ${r.content}`;
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
