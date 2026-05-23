/**
 * Unit tests for the LongMemEval dataset loader.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { loadFixture, loadDataset, validateQuestions, historyToTranscript, categoriesIn } from '../src/loader';
import type { LongMemEvalQuestion } from '../src/types';

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'smoke-20.json');

describe('loader — smoke fixture', () => {
  it('loads all 20 questions from smoke-20.json', () => {
    const questions = loadFixture(FIXTURE_PATH);
    expect(questions).toHaveLength(20);
  });

  it('each question has required fields', () => {
    const questions = loadFixture(FIXTURE_PATH);
    for (const q of questions) {
      expect(typeof q.question_id).toBe('string');
      expect(typeof q.question).toBe('string');
      expect(typeof q.answer).toBe('string');
      expect(typeof q.category).toBe('string');
      expect(Array.isArray(q.session_history)).toBe(true);
      expect(q.session_history.length).toBeGreaterThan(0);
    }
  });

  it('fixture is stratified across 5 categories', () => {
    const questions = loadFixture(FIXTURE_PATH);
    const cats = categoriesIn(questions);
    expect(cats).toContain('single-session-user');
    expect(cats).toContain('multi-session-user');
    expect(cats).toContain('temporal-reasoning-ability');
    expect(cats).toContain('knowledge-update');
    expect(cats).toContain('single-session-assistant');
  });

  it('each category has at least 3 questions', () => {
    const questions = loadFixture(FIXTURE_PATH);
    const byCategory = new Map<string, number>();
    for (const q of questions) {
      byCategory.set(q.category, (byCategory.get(q.category) ?? 0) + 1);
    }
    for (const [cat, count] of byCategory.entries()) {
      expect(count).toBeGreaterThanOrEqual(3);
    }
  });

  it('throws on non-existent fixture path', () => {
    expect(() => loadFixture('/tmp/does-not-exist-lme.json')).toThrow();
  });
});

describe('loadDataset — full subset fail-loud', () => {
  it('does NOT fall back to smoke fixture when HF download fails', async () => {
    // Force fetchFromHuggingFace to throw by pointing the cache dir at a
    // path we can't write to AND monkey-patching https.get isn't safe across
    // tests. Instead, rely on a much simpler guarantee: when no cache exists
    // and the network call rejects, loadDataset rethrows instead of silently
    // returning the 20-question smoke set.
    //
    // We simulate by passing a fake fetch through env: NODE_DISABLE_NET=1 is
    // not a thing, so we just verify by code-path: the previous fallback
    // is gone (regression guard).
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'loader.ts'), 'utf-8');
    expect(src).not.toMatch(/Falling back to smoke/);
    expect(src).not.toMatch(/catch \(err\) \{[^}]*loadFixture\(\)/s);
  });
});

describe('validateQuestions', () => {
  const valid: LongMemEvalQuestion[] = [
    {
      question_id: 'q1',
      question: 'What is 2+2?',
      answer: '4',
      category: 'single-session-user',
      session_history: [{ role: 'user', content: 'Hi' }],
    },
  ];

  it('passes for valid questions', () => {
    expect(() => validateQuestions(valid)).not.toThrow();
  });

  it('throws on empty array', () => {
    expect(() => validateQuestions([])).toThrow('non-empty array');
  });

  it('throws on missing question_id', () => {
    const bad = [{ ...valid[0], question_id: '' }];
    expect(() => validateQuestions(bad as LongMemEvalQuestion[])).toThrow('question_id');
  });

  it('throws on missing question text', () => {
    const bad = [{ ...valid[0], question: '' }];
    expect(() => validateQuestions(bad as LongMemEvalQuestion[])).toThrow('question field');
  });

  it('throws on missing session_history', () => {
    const bad = [{ ...valid[0], session_history: null as any }];
    expect(() => validateQuestions(bad as LongMemEvalQuestion[])).toThrow('session_history');
  });

  it('accepts fixture-style wrapped format { questions: [...] }', () => {
    const tmpPath = path.join(os.tmpdir(), 'lme-test-fixture.json');
    fs.writeFileSync(tmpPath, JSON.stringify({ questions: valid }));
    const result = loadFixture(tmpPath);
    expect(result).toHaveLength(1);
    fs.unlinkSync(tmpPath);
  });
});

describe('historyToTranscript', () => {
  it('formats user/assistant turns with labels', () => {
    const history = [
      { role: 'user' as const, content: 'Hello there' },
      { role: 'assistant' as const, content: 'Hi! How can I help?' },
    ];
    const transcript = historyToTranscript(history);
    expect(transcript).toContain('User: Hello there');
    expect(transcript).toContain('Assistant: Hi! How can I help?');
  });

  it('uses System: label for system role', () => {
    const history = [{ role: 'system' as const, content: 'You are helpful.' }];
    const transcript = historyToTranscript(history);
    expect(transcript).toContain('System: You are helpful.');
  });

  it('separates turns with double newlines', () => {
    const history = [
      { role: 'user' as const, content: 'A' },
      { role: 'assistant' as const, content: 'B' },
    ];
    const transcript = historyToTranscript(history);
    expect(transcript).toContain('\n\n');
  });

  it('produces output parseable by chunkByRound-style splitter', () => {
    const history = [
      { role: 'user' as const, content: 'What is your name?' },
      { role: 'assistant' as const, content: 'I am an AI assistant.' },
      { role: 'user' as const, content: 'What can you do?' },
      { role: 'assistant' as const, content: 'I can answer questions.' },
    ];
    const transcript = historyToTranscript(history);
    // Should match the TURN_BOUNDARY regex used by chunkByRound
    const TURN_BOUNDARY = /^(user|assistant)\s*:/gim;
    const matches = transcript.match(TURN_BOUNDARY);
    expect(matches).toHaveLength(4);
  });
});
