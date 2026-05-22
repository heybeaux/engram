/**
 * Unit tests for CoN answer extraction (open question #2).
 *
 * The reading model (Opus 4.7) is expected to return a JSON envelope:
 * { "notes": [...], "answer": "..." }
 *
 * This test suite verifies the extractor handles:
 * - Clean JSON responses
 * - Markdown-fenced JSON responses
 * - JSON embedded in prose
 * - Partial/malformed JSON (fallback to last paragraph)
 * - Empty responses
 */

import { extractConAnswer } from '../src/recall';

describe('extractConAnswer — clean JSON envelope', () => {
  it('extracts answer from clean JSON', () => {
    const raw = JSON.stringify({
      notes: [
        { memory_id: 'm1', note: 'relevant because it mentions Python' },
      ],
      answer: 'Python',
    });
    expect(extractConAnswer(raw)).toBe('Python');
  });

  it('extracts answer from JSON with notes array', () => {
    const raw = JSON.stringify({
      notes: [
        { memory_id: 'abc', note: 'partially relevant' },
        { memory_id: 'def', note: 'not relevant' },
      ],
      answer: 'The user prefers dark mode.',
    });
    expect(extractConAnswer(raw)).toBe('The user prefers dark mode.');
  });

  it('trims whitespace from extracted answer', () => {
    const raw = JSON.stringify({ notes: [], answer: '  Mochi  ' });
    expect(extractConAnswer(raw)).toBe('Mochi');
  });
});

describe('extractConAnswer — markdown fenced JSON', () => {
  it('handles ```json fence', () => {
    const raw = '```json\n{"notes": [], "answer": "Austin"}\n```';
    expect(extractConAnswer(raw)).toBe('Austin');
  });

  it('handles plain ``` fence', () => {
    const raw = '```\n{"notes": [], "answer": "Python"}\n```';
    expect(extractConAnswer(raw)).toBe('Python');
  });

  it('handles fenced JSON with surrounding prose', () => {
    const raw = `Here is my analysis:

\`\`\`json
{
  "notes": [{"memory_id": "x1", "note": "relevant — mentions Austin"}],
  "answer": "Austin, Texas"
}
\`\`\`

Hope that helps!`;
    expect(extractConAnswer(raw)).toBe('Austin, Texas');
  });
});

describe('extractConAnswer — embedded JSON in prose', () => {
  it('extracts answer field from JSON object in prose', () => {
    const raw = 'Based on my analysis: {"notes": [], "answer": "three years ago"} That is the final answer.';
    expect(extractConAnswer(raw)).toBe('three years ago');
  });
});

describe('extractConAnswer — fallback to last paragraph', () => {
  it('falls back to last paragraph when JSON is invalid', () => {
    const raw = 'Some analysis here.\n\nThis is the answer: Python is the preferred language.';
    const result = extractConAnswer(raw);
    expect(result).toBe('This is the answer: Python is the preferred language.');
  });

  it('falls back to single paragraph when no JSON', () => {
    const raw = 'The user prefers Python for backend development.';
    expect(extractConAnswer(raw)).toBe('The user prefers Python for backend development.');
  });
});

describe('extractConAnswer — edge cases', () => {
  it('returns empty string for empty input', () => {
    expect(extractConAnswer('')).toBe('');
    expect(extractConAnswer('   ')).toBe('');
  });

  it('handles JSON with no answer field gracefully', () => {
    const raw = JSON.stringify({ notes: [{ memory_id: 'x', note: 'relevant' }] });
    // No "answer" field — should fall back to last paragraph (the raw text itself)
    const result = extractConAnswer(raw);
    expect(typeof result).toBe('string');
  });

  it('handles JSON answer field as number (coerces gracefully)', () => {
    // The answer field should be a string but if it's not, don't crash
    const raw = '{"notes": [], "answer": 42}';
    // answer is not a string — fallback behaviour
    const result = extractConAnswer(raw);
    expect(typeof result).toBe('string');
  });
});
