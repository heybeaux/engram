/**
 * Unit tests for the LongMemEval scorer.
 */

import { buildSummary, computeByCategory, formatSummary, checkThresholds } from '../src/scorer';
import type { QuestionResult } from '../src/types';

function makeResult(overrides: Partial<QuestionResult> = {}): QuestionResult {
  return {
    questionId: 'q1',
    question: 'What is the user\'s name?',
    expected: 'Alice',
    predicted: 'Alice',
    correct: true,
    category: 'single-session-user',
    latencyMs: 500,
    ...overrides,
  };
}

describe('computeByCategory', () => {
  it('groups results correctly by category', () => {
    const results: QuestionResult[] = [
      makeResult({ category: 'single-session-user', correct: true }),
      makeResult({ category: 'single-session-user', correct: false }),
      makeResult({ category: 'temporal-reasoning-ability', correct: true }),
    ];
    const by = computeByCategory(results);
    expect(by['single-session-user'].total).toBe(2);
    expect(by['single-session-user'].correct).toBe(1);
    expect(by['single-session-user'].accuracy).toBe(0.5);
    expect(by['temporal-reasoning-ability'].total).toBe(1);
    expect(by['temporal-reasoning-ability'].correct).toBe(1);
    expect(by['temporal-reasoning-ability'].accuracy).toBe(1.0);
  });

  it('returns empty object for empty results', () => {
    expect(computeByCategory([])).toEqual({});
  });

  it('handles 100% accuracy', () => {
    const results = [makeResult({ correct: true }), makeResult({ correct: true })];
    const by = computeByCategory(results);
    expect(by['single-session-user'].accuracy).toBe(1.0);
  });

  it('handles 0% accuracy', () => {
    const results = [makeResult({ correct: false }), makeResult({ correct: false })];
    const by = computeByCategory(results);
    expect(by['single-session-user'].accuracy).toBe(0.0);
  });
});

describe('buildSummary', () => {
  it('computes correct aggregate accuracy', () => {
    const results = [
      makeResult({ correct: true }),
      makeResult({ correct: true }),
      makeResult({ correct: false }),
      makeResult({ correct: false }),
    ];
    const summary = buildSummary(results, 'smoke');
    expect(summary.totalQuestions).toBe(4);
    expect(summary.correctCount).toBe(2);
    expect(summary.accuracy).toBe(0.5);
  });

  it('sets subset and runAt fields', () => {
    const summary = buildSummary([makeResult()], 'smoke');
    expect(summary.subset).toBe('smoke');
    expect(typeof summary.runAt).toBe('string');
    expect(new Date(summary.runAt).getTime()).not.toBeNaN();
  });

  it('includes all questions in the output', () => {
    const results = [
      makeResult({ questionId: 'q1' }),
      makeResult({ questionId: 'q2' }),
    ];
    const summary = buildSummary(results, 'smoke');
    expect(summary.questions).toHaveLength(2);
    expect(summary.questions.map(q => q.questionId)).toContain('q1');
    expect(summary.questions.map(q => q.questionId)).toContain('q2');
  });

  it('handles empty results', () => {
    const summary = buildSummary([], 'smoke');
    expect(summary.totalQuestions).toBe(0);
    expect(summary.correctCount).toBe(0);
    expect(summary.accuracy).toBe(0);
    expect(summary.byCategory).toEqual({});
  });

  it('produces valid JSON output', () => {
    const summary = buildSummary([makeResult()], 'smoke');
    expect(() => JSON.stringify(summary)).not.toThrow();
    const roundTrip = JSON.parse(JSON.stringify(summary));
    expect(roundTrip.accuracy).toBe(1.0);
  });
});

describe('formatSummary', () => {
  it('includes key stats in output', () => {
    const summary = buildSummary([makeResult({ correct: true })], 'smoke');
    const formatted = formatSummary(summary);
    expect(formatted).toContain('100.0%');
    expect(formatted).toContain('smoke');
    expect(formatted).toContain('single-session-user');
  });
});

describe('checkThresholds', () => {
  it('returns no failures for valid run', () => {
    const summary = buildSummary([makeResult()], 'smoke');
    expect(checkThresholds(summary)).toHaveLength(0);
  });

  it('flags empty question set', () => {
    const summary = buildSummary([], 'smoke');
    const failures = checkThresholds(summary);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toContain('No questions');
  });
});
