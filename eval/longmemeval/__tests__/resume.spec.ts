/**
 * Unit tests for the resume/checkpoint layer (S5 / HEY-579).
 *
 * Validates that:
 *  - JSONL written by the runner can be reloaded into QuestionResult[]
 *  - A resume set built from the JSONL contains the expected questionIds
 *  - Scoring from a JSONL-derived result list produces a correct summary
 *  - Malformed lines fail loudly with file:line context
 *  - Blank lines and missing files are handled gracefully
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildSummary, loadResultsFromJsonl } from '../src/scorer';
import type { QuestionResult } from '../src/types';

function makeResult(id: string, correct: boolean): QuestionResult {
  return {
    questionId: id,
    question: `Q ${id}`,
    expected: 'gold',
    predicted: correct ? 'gold' : 'wrong',
    correct,
    category: 'single-session-user',
    latencyMs: 1234,
    judgeReasoning: 'because',
    timestamp: '2026-05-22T19:00:00.000Z',
  };
}

function writeJsonl(filepath: string, results: QuestionResult[]) {
  const body = results.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(filepath, body, 'utf-8');
}

describe('loadResultsFromJsonl', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lme-resume-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns [] when the file does not exist', () => {
    const missing = path.join(tmpDir, 'nope.jsonl');
    expect(loadResultsFromJsonl(missing)).toEqual([]);
  });

  it('parses one QuestionResult per line', () => {
    const file = path.join(tmpDir, 'results.jsonl');
    const fixtures = [
      makeResult('q1', true),
      makeResult('q2', false),
      makeResult('q3', true),
      makeResult('q4', true),
      makeResult('q5', false),
    ];
    writeJsonl(file, fixtures);

    const loaded = loadResultsFromJsonl(file);
    expect(loaded).toHaveLength(5);
    expect(loaded.map(r => r.questionId)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    expect(loaded[0].correct).toBe(true);
    expect(loaded[1].correct).toBe(false);
  });

  it('skips blank lines (including trailing newline)', () => {
    const file = path.join(tmpDir, 'blank.jsonl');
    const body =
      JSON.stringify(makeResult('q1', true)) +
      '\n\n' +
      JSON.stringify(makeResult('q2', false)) +
      '\n\n\n';
    fs.writeFileSync(file, body, 'utf-8');

    const loaded = loadResultsFromJsonl(file);
    expect(loaded).toHaveLength(2);
    expect(loaded.map(r => r.questionId)).toEqual(['q1', 'q2']);
  });

  it('throws with file:line context on malformed JSON', () => {
    const file = path.join(tmpDir, 'broken.jsonl');
    const body =
      JSON.stringify(makeResult('q1', true)) +
      '\n' +
      '{not valid json\n' +
      JSON.stringify(makeResult('q3', true)) +
      '\n';
    fs.writeFileSync(file, body, 'utf-8');

    expect(() => loadResultsFromJsonl(file)).toThrow(/broken\.jsonl:2/);
  });
});

describe('resume set construction', () => {
  it('builds a Set<string> of completed question_ids that filters the dataset', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lme-resume-'));
    try {
      const file = path.join(tmpDir, 'partial.jsonl');
      const prior = [
        makeResult('q1', true),
        makeResult('q2', false),
        makeResult('q3', true),
        makeResult('q4', true),
        makeResult('q5', false),
      ];
      writeJsonl(file, prior);

      const completed = new Set(loadResultsFromJsonl(file).map(r => r.questionId));
      expect(completed.size).toBe(5);
      ['q1', 'q2', 'q3', 'q4', 'q5'].forEach(id => expect(completed.has(id)).toBe(true));

      // Pretend the full dataset is q1..q10 — remaining should be q6..q10
      const dataset = Array.from({ length: 10 }, (_, i) => ({ question_id: `q${i + 1}` }));
      const remaining = dataset.filter(q => !completed.has(q.question_id));
      expect(remaining.map(q => q.question_id)).toEqual(['q6', 'q7', 'q8', 'q9', 'q10']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('buildSummary from JSONL', () => {
  it('produces a correct summary when results are loaded from disk', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lme-resume-'));
    try {
      const file = path.join(tmpDir, 'final.jsonl');
      const prior = [
        makeResult('q1', true),
        makeResult('q2', false),
        makeResult('q3', true),
        makeResult('q4', true),
        makeResult('q5', false),
      ];
      writeJsonl(file, prior);

      const loaded = loadResultsFromJsonl(file);
      const summary = buildSummary(loaded, 'smoke');

      expect(summary.totalQuestions).toBe(5);
      expect(summary.correctCount).toBe(3);
      expect(summary.accuracy).toBeCloseTo(0.6);
      expect(summary.byCategory['single-session-user']).toEqual({
        total: 5,
        correct: 3,
        accuracy: 0.6,
      });
      expect(summary.questions.map(q => q.questionId)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
