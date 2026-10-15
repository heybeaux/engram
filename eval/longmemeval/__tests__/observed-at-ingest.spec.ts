import { ingestQuestion, lmeDateToIso, splitSessionSegments } from '../src/ingest';
import { buildSessionHistory } from '../src/loader';
import type { LongMemEvalQuestion, RoundEntry } from '../src/types';

const sessions: RoundEntry[][] = [
  [
    { role: 'user', content: 'a1' },
    { role: 'assistant', content: 'a2' },
  ],
  [
    { role: 'user', content: 'b1' },
    { role: 'assistant', content: 'b2' },
  ],
];
const dates = ['2023/05/30 (Tue) 23:40', '2023/06/02 (Fri) 08:05'];

function makeQuestion(): LongMemEvalQuestion {
  return {
    question_id: 'q1',
    question: 'q',
    answer: 'a',
    category: 'temporal-reasoning-ability',
    session_history: buildSessionHistory(sessions, dates),
  };
}

describe('lmeDateToIso', () => {
  it('converts the dataset format to ISO UTC', () => {
    expect(lmeDateToIso('2023/05/30 (Tue) 23:40')).toBe('2023-05-30T23:40:00.000Z');
  });
  it('accepts a date without a time', () => {
    expect(lmeDateToIso('2023/05/30')).toBe('2023-05-30T00:00:00.000Z');
  });
  it('returns undefined for junk or missing input', () => {
    expect(lmeDateToIso(undefined)).toBeUndefined();
    expect(lmeDateToIso('last tuesday')).toBeUndefined();
    expect(lmeDateToIso('2023/13/45 (Tue) 99:99')).toBeUndefined();
  });
});

describe('splitSessionSegments', () => {
  it('yields one dated segment per session and carries each marker on the previous segment', () => {
    const segs = splitSessionSegments(makeQuestion().session_history);
    expect(segs.map(s => s.observedAt)).toEqual([
      '2023-05-30T23:40:00.000Z',
      '2023-06-02T08:05:00.000Z',
    ]);
    expect(segs[0].rounds.map(r => r.content)).toEqual([
      '--- Session 1 (2023/05/30 (Tue) 23:40) ---',
      'a1',
      'a2',
      '--- Session 2 (2023/06/02 (Fri) 08:05) ---',
    ]);
    expect(segs[1].rounds.map(r => r.content)).toEqual(['b1', 'b2']);
  });

  it('concatenated segments reproduce the original history', () => {
    const h = makeQuestion().session_history;
    expect(splitSessionSegments(h).flatMap(s => s.rounds)).toEqual(h);
  });

  it('leaves observedAt undefined for an undated flat history', () => {
    const segs = splitSessionSegments([{ role: 'user', content: 'hi' }]);
    expect(segs).toHaveLength(1);
    expect(segs[0].observedAt).toBeUndefined();
  });
});

describe('ingestQuestion observedAt flag (LME_OBSERVED_AT)', () => {
  let fetchSpy: jest.SpyInstance;
  const config = { apiBase: 'http://x', apiKey: 'k' };

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ created: 2, chunks: 2, memoryIds: ['m1', 'm2'] }), { status: 201 }),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.LME_OBSERVED_AT;
  });

  it('default: one call, no observedAt', async () => {
    await ingestQuestion(makeQuestion(), config);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).not.toHaveProperty('observedAt');
  });

  it('flag on: one call per session, each with its observedAt, ids aggregated', async () => {
    process.env.LME_OBSERVED_AT = '1';
    const res = await ingestQuestion(makeQuestion(), config);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const bodies = fetchSpy.mock.calls.map(c => JSON.parse(c[1].body));
    expect(bodies.map(b => b.observedAt)).toEqual([
      '2023-05-30T23:40:00.000Z',
      '2023-06-02T08:05:00.000Z',
    ]);
    expect(bodies.every(b => b.context.sessionId === 'lme-q1')).toBe(true);
    expect(res.memoryIds).toHaveLength(4);
    expect(res.chunks).toBe(4);
  });

  it('flag on: a non-2xx session call fails the question', async () => {
    process.env.LME_OBSERVED_AT = '1';
    fetchSpy.mockImplementation(async () => new Response('bad', { status: 400 }));
    await expect(ingestQuestion(makeQuestion(), config)).rejects.toThrow(/HTTP 400/);
  });
});
