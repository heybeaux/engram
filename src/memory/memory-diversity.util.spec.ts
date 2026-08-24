import { MemoryWithScore } from './memory.types';
import { selectNearDuplicateDiverse } from './memory-diversity.util';

function candidate(id: string, raw: string, score: number): MemoryWithScore {
  return { id, raw, score } as MemoryWithScore;
}

describe('selectNearDuplicateDiverse (research)', () => {
  const prefix =
    'MNEMON benchmark project fact for pagination conventions for list endpoints:';
  const decoy = (n: number) =>
    candidate(
      `decoy-${n}`,
      `${prefix} archived neighboring-service note ${n}. This historical contract belongs to legacy-paginated-list-endpoint-${n}, not the current service. Its imports, units, key formats, argument order, return types, and async behavior may differ from the current project.`,
      1 - n / 100,
    );
  const gold = candidate(
    'gold',
    `${prefix} import db plus User from ../lib/db.js and parsePageParams from ../lib/pagination.js. paginate should delegate directly to parsePageParams. db.queryUsers(page, pageSize) returns Promise with items and total; listUsers must merge the result with the validated 1-based page and pageSize.`,
    0.8,
  );

  it('caps almost-identical decoys and admits the distinct current contract', () => {
    const ranked = [
      ...Array.from({ length: 10 }, (_, i) => decoy(i + 1)),
      gold,
    ];
    const selected = selectNearDuplicateDiverse(ranked, 10, 2);

    expect(selected).toHaveLength(10);
    expect(selected.slice(0, 3).map((row) => row.id)).toEqual([
      'decoy-1',
      'decoy-2',
      'gold',
    ]);
  });

  it('does not cluster records that only share a topic prefix', () => {
    const distinct = [
      candidate(
        'a',
        `${prefix} use cursor pagination and return nextCursor.`,
        1,
      ),
      candidate(
        'b',
        `${prefix} use offset pagination and return totalPages.`,
        0.9,
      ),
      candidate(
        'c',
        `${prefix} use keyset pagination ordered by createdAt.`,
        0.8,
      ),
    ];

    expect(
      selectNearDuplicateDiverse(distinct, 3, 1).map((row) => row.id),
    ).toEqual(['a', 'b', 'c']);
  });

  it('preserves incoming relevance order among selected records', () => {
    const selected = selectNearDuplicateDiverse(
      [decoy(1), decoy(2), decoy(3), gold],
      10,
      2,
    );
    expect(selected.map((row) => row.id)).toEqual([
      'decoy-1',
      'decoy-2',
      'gold',
      'decoy-3',
    ]);
  });

  it('never exceeds the requested limit when suppressed rows exist', () => {
    const ranked = [decoy(1), decoy(2), decoy(3), gold];
    const selected = selectNearDuplicateDiverse(ranked, 3, 2);
    expect(selected).toHaveLength(3);
    expect(selected.map((row) => row.id)).toEqual([
      'decoy-1',
      'decoy-2',
      'gold',
    ]);
  });
});
