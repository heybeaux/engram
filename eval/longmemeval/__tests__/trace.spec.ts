import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evidenceCoverage, matchEvidence, traceMemories } from '../src/trace';
import { extractEvidenceTurns, filterByQuestionIds, parseQuestionIds } from '../src/loader';
import { buildClaudeCliArgs, parseClaudeCliOutput, resolveTransport } from '../src/llm';
import { buildReaderUserMessage } from '../src/recall';
import type { EvidenceTurn, LongMemEvalQuestion } from '../src/types';

const turn = (content: string, sessionIndex = 0): EvidenceTurn => ({
  sessionId: `s${sessionIndex}`,
  sessionIndex,
  turnIndex: 0,
  role: 'user',
  content,
});

describe('matchEvidence', () => {
  const longTurn =
    'I just submitted my master thesis on May 15th after months of work, and I am finally done with the program.';

  it('matches a memory that contains the evidence turn (with label and date prefix)', () => {
    const fact = `User: [2023/05/15 (Mon) 10:00] ${longTurn}\n\nAssistant: Congratulations!`;
    expect(matchEvidence(fact, [turn(longTurn)])).toEqual([0]);
  });

  it('ignores whitespace and case differences', () => {
    const fact = longTurn.toUpperCase().replace(/ /g, '   ');
    expect(matchEvidence(fact, [turn(longTurn)])).toEqual([0]);
  });

  it('matches a memory that is a chunk of a longer evidence turn', () => {
    const big = `${longTurn} ${'filler text '.repeat(40)}`;
    expect(matchEvidence(big.slice(150, 300), [turn(big)])).toEqual([0]);
  });

  it('does not match unrelated memories or tiny fragments', () => {
    expect(matchEvidence('User: I like hiking in the mountains on weekends.', [turn(longTurn)])).toEqual([]);
    expect(matchEvidence('thesis', [turn(longTurn)])).toEqual([]);
  });

  it('returns every matching evidence index', () => {
    const other = 'My undergraduate degree was completed in January, right after the winter term ended.';
    expect(matchEvidence(`${longTurn} ${other}`, [turn(longTurn), turn(other, 1)])).toEqual([0, 1]);
  });
});

describe('traceMemories / evidenceCoverage', () => {
  const evidence = [
    turn('I repotted the snake plant last Saturday, it had outgrown the old clay pot completely.'),
    turn('The new job started on March 3rd and the commute is about forty minutes each way.', 1),
  ];
  const memories = [
    { id: 'a', fact: 'User: unrelated chat about recipes and cooking dinner tonight', confidence: 0.9 },
    { id: 'b', fact: `User: ${evidence[1].content}`, confidence: 0.8, timestamp: 't', memory_type: 'EVENT' },
  ];

  it('assigns 1-based ranks and keeps scores', () => {
    const traced = traceMemories(memories, evidence);
    expect(traced.map(m => [m.rank, m.id, m.score])).toEqual([[1, 'a', 0.9], [2, 'b', 0.8]]);
    expect(traced[1].evidenceTurnMatches).toEqual([1]);
    expect(traced[1].memoryType).toBe('EVENT');
  });

  it('reports partial coverage and the first evidence rank', () => {
    expect(evidenceCoverage(traceMemories(memories, evidence), evidence.length)).toEqual({
      evidenceTurns: 2,
      evidenceTurnsRetrieved: 1,
      firstEvidenceRank: 2,
      allEvidenceRetrieved: false,
    });
  });

  it('reports no coverage when nothing matched', () => {
    expect(evidenceCoverage(traceMemories(memories.slice(0, 1), evidence), 2)).toMatchObject({
      evidenceTurnsRetrieved: 0,
      firstEvidenceRank: null,
    });
  });
});

describe('loader question-id filter and evidence turns', () => {
  const q = (id: string): LongMemEvalQuestion => ({
    question_id: id,
    question: 'q',
    answer: 'a',
    category: 'knowledge-update',
    session_history: [],
  });

  it('keeps dataset order and throws on unknown IDs', () => {
    const qs = [q('a'), q('b'), q('c')];
    expect(filterByQuestionIds(qs, ['c', 'a']).map(x => x.question_id)).toEqual(['a', 'c']);
    expect(() => filterByQuestionIds(qs, ['a', 'zz'])).toThrow('zz');
  });

  it('parses inline and file ID lists, de-duplicated', () => {
    expect(parseQuestionIds('x, y,x')).toEqual(['x', 'y']);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lme-ids-')), 'ids.txt');
    fs.writeFileSync(file, 'one\ntwo\n\nthree\n');
    expect(parseQuestionIds(file)).toEqual(['one', 'two', 'three']);
  });

  it('extracts has_answer turns with session id, index and date', () => {
    const sessions = [
      [{ role: 'user' as const, content: 'noise' }],
      [
        { role: 'user' as const, content: 'evidence', has_answer: true },
        { role: 'assistant' as const, content: 'reply' },
      ],
    ];
    expect(extractEvidenceTurns(sessions, ['s1', 's2'], ['d1', 'd2'])).toEqual([
      { sessionId: 's2', sessionIndex: 1, sessionDate: 'd2', turnIndex: 0, role: 'user', content: 'evidence' },
    ]);
  });
});

describe('llm transport', () => {
  it('resolves transports and rejects unknown values', () => {
    expect(resolveTransport(undefined)).toBe('api');
    expect(resolveTransport('claude-cli')).toBe('claude-cli');
    expect(() => resolveTransport('openai')).toThrow('Unknown');
  });

  it('builds a tool-less, settings-less claude -p call with the system prompt replaced', () => {
    const args = buildClaudeCliArgs('claude-opus-4-7', '/tmp/sys.txt');
    expect(args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--no-session-persistence']));
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-7');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--system-prompt-file') + 1]).toBe('/tmp/sys.txt');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('parses CLI JSON output and surfaces errors', () => {
    expect(parseClaudeCliOutput('{"result":"{\\"answer\\":\\"3\\"}","is_error":false}')).toBe('{"answer":"3"}');
    expect(() => parseClaudeCliOutput('{"result":"limit hit","is_error":true,"subtype":"error"}')).toThrow('limit hit');
    expect(() => parseClaudeCliOutput('not json')).toThrow('non-JSON');
  });
});

describe('buildReaderUserMessage', () => {
  it('embeds the question and hint before the JSON envelope instructions', () => {
    const msg = buildReaderUserMessage('How many?', '\n\nHINT');
    expect(msg.startsWith('Answer the following question based on the memories above.\n\nQuestion: How many?\n\nHINT\n\n')).toBe(true);
    expect(msg.endsWith('JSON only, no markdown.')).toBe(true);
  });
});
