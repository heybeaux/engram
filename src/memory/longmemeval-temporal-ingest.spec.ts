import { buildRoundMemories } from '../../eval/longmemeval/src/ingest';
import { normalizeHaystackDate } from '../../eval/longmemeval/src/loader';

describe('LongMemEval temporal ingest helpers', () => {
  it('normalizes Haystack session dates to ISO timestamps', () => {
    expect(normalizeHaystackDate('2023/05/20 (Sat) 02:21')).toBe(
      '2023-05-20T02:21:00.000Z',
    );
  });

  it('builds round memories that preserve source timestamps', () => {
    const memories = buildRoundMemories([
      {
        role: 'user',
        content: 'I went to the museum yesterday.',
        timestamp: '2023-05-20T02:21:00.000Z',
      },
      {
        role: 'assistant',
        content: 'That sounds fun.',
        timestamp: '2023-05-20T02:21:00.000Z',
      },
      {
        role: 'user',
        content: 'Today I went back again.',
        timestamp: '2023-05-21T03:24:00.000Z',
      },
      {
        role: 'assistant',
        content: 'Nice.',
        timestamp: '2023-05-21T03:24:00.000Z',
      },
    ]);

    expect(memories).toEqual([
      {
        raw: 'User: I went to the museum yesterday.\n\nAssistant: That sounds fun.',
        layer: 'SESSION',
        sessionPosition: 0,
        sourceTimestamp: '2023-05-20T02:21:00.000Z',
        sourceTurnIndex: 0,
      },
      {
        raw: 'User: Today I went back again.\n\nAssistant: Nice.',
        layer: 'SESSION',
        sessionPosition: 1,
        sourceTimestamp: '2023-05-21T03:24:00.000Z',
        sourceTurnIndex: 1,
      },
    ]);
  });
});
