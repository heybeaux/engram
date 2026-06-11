/**
 * Unit tests for the batch-ingest phase.
 *
 * Validates that:
 *  - The ingest manifest makes the phase resumable (already-ingested IDs skipped)
 *  - Torn/blank manifest lines are tolerated
 *  - batchIngest ingests only pending questions and appends to the manifest
 *  - Concurrency never double-ingests a question
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { batchIngest, loadIngestManifest } from '../src/ingest';
import type { LongMemEvalQuestion } from '../src/types';

function makeQuestion(id: string): LongMemEvalQuestion {
  return {
    question_id: id,
    question: `Q ${id}`,
    answer: 'gold',
    category: 'single-session-user',
    session_history: [{ role: 'user', content: `hello from ${id}` }],
  };
}

describe('loadIngestManifest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lme-manifest-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty set for missing file', () => {
    expect(loadIngestManifest(path.join(tmpDir, 'nope.jsonl')).size).toBe(0);
  });

  it('loads questionIds and tolerates torn/blank lines', () => {
    const manifestPath = path.join(tmpDir, 'm.ingest.jsonl');
    fs.writeFileSync(
      manifestPath,
      '{"questionId":"a","chunks":3,"timestamp":"t"}\n' +
        '\n' +
        '{"questionId":"b","chunks":1,"timestamp":"t"}\n' +
        '{"questionId":"c","chu', // torn line from a crash
      'utf-8',
    );
    const ids = loadIngestManifest(manifestPath);
    expect(ids).toEqual(new Set(['a', 'b']));
  });
});

describe('batchIngest', () => {
  let tmpDir: string;
  let fetchSpy: jest.SpyInstance;
  const ingestedIds: string[] = [];

  const config = { apiBase: 'http://test', apiKey: 'k' };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lme-batch-'));
    ingestedIds.length = 0;
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      ingestedIds.push(headers['X-AM-User-ID']);
      return new Response(JSON.stringify({ created: 1, chunks: 1, memoryIds: ['m1'] }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ingests all pending questions and records them in the manifest', async () => {
    const manifestPath = path.join(tmpDir, 'run.ingest.jsonl');
    const questions = ['q1', 'q2', 'q3'].map(makeQuestion);

    const { ingested, skipped } = await batchIngest(questions, config, manifestPath, 2);

    expect(ingested).toBe(3);
    expect(skipped).toBe(0);
    expect(loadIngestManifest(manifestPath)).toEqual(new Set(['q1', 'q2', 'q3']));
    expect(new Set(ingestedIds)).toEqual(new Set(['lme-q1', 'lme-q2', 'lme-q3']));
    expect(ingestedIds.length).toBe(3); // no double-ingest under concurrency
  });

  it('skips questions already in the manifest on resume', async () => {
    const manifestPath = path.join(tmpDir, 'run.ingest.jsonl');
    fs.writeFileSync(manifestPath, '{"questionId":"q1","chunks":1,"timestamp":"t"}\n', 'utf-8');
    const questions = ['q1', 'q2'].map(makeQuestion);

    const { ingested, skipped } = await batchIngest(questions, config, manifestPath, 4);

    expect(ingested).toBe(1);
    expect(skipped).toBe(1);
    expect(ingestedIds).toEqual(['lme-q2']);
    expect(loadIngestManifest(manifestPath)).toEqual(new Set(['q1', 'q2']));
  });
});
