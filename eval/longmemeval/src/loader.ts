/**
 * Dataset loader for LongMemEval.
 *
 * Supports two sources:
 *  1. Local fixture file (smoke-20.json) — always available, used for CI/smoke runs.
 *  2. HuggingFace dataset download — requires HUGGINGFACE_TOKEN env var.
 *
 * The full LongMemEval dataset is at: xiaowu0162/longmemeval on HuggingFace.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import type { LongMemEvalQuestion, LmeDataset, LmeCategory, RunConfig } from './types';

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
    try {
      questions = await fetchFromHuggingFace();
    } catch (err) {
      console.warn(`[loader] HuggingFace download failed: ${(err as Error).message}`);
      console.warn('[loader] Falling back to smoke-20 fixture.');
      questions = loadFixture();
    }
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
 * Attempt to download the LongMemEval dataset from HuggingFace.
 * Requires HUGGINGFACE_TOKEN env var.
 */
export async function fetchFromHuggingFace(): Promise<LongMemEvalQuestion[]> {
  const token = process.env.HUGGINGFACE_TOKEN;
  if (!token) {
    throw new Error('HUGGINGFACE_TOKEN env var not set — cannot download full dataset');
  }

  // HuggingFace datasets API endpoint for the parquet/JSON files
  const url = 'https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s.json';

  const raw = await httpGet(url, { Authorization: `Bearer ${token}` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Failed to parse LongMemEval JSON from HuggingFace');
  }

  const questions: LongMemEvalQuestion[] = Array.isArray(parsed)
    ? (parsed as LongMemEvalQuestion[])
    : (parsed as LmeDataset).questions;

  validateQuestions(questions);
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
function httpGet(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        httpGet(res.headers.location, headers).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}
