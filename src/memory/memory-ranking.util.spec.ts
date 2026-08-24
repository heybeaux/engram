import {
  compareByRankKeys,
  sortByRank,
  ftsRescueScore,
  ilikeRescueScore,
  rrfNorm,
  FTS_RESCUE_BAND_TOP,
  FTS_RESCUE_BAND_BOTTOM,
  ILIKE_RESCUE_BAND_TOP,
  ILIKE_RESCUE_BAND_BOTTOM,
  meetsLexicalCoverageFloor,
  RankableMemory,
} from './memory-ranking.util';

describe('memory-ranking.util', () => {
  describe('meetsLexicalCoverageFloor (defect A, part 1)', () => {
    it('rejects a single incidental term out of many', () => {
      // The exact benchmark case: an eight-term query, and a 71-character junk
      // memory whose only overlap is the corpus-wide token "mnemon".
      expect(meetsLexicalCoverageFloor(1, 8)).toBe(false);
    });

    it('accepts two or more matched terms', () => {
      expect(meetsLexicalCoverageFloor(2, 8)).toBe(true);
      expect(meetsLexicalCoverageFloor(8, 8)).toBe(true);
    });

    it('degrades to "match the only term" for single-term queries', () => {
      expect(meetsLexicalCoverageFloor(1, 1)).toBe(true);
      expect(meetsLexicalCoverageFloor(0, 1)).toBe(false);
    });

    it('treats a garbled match count as not clearing the floor', () => {
      expect(meetsLexicalCoverageFloor(Number.NaN, 8)).toBe(false);
    });

    it('never rejects on a zero-term query (no terms, no floor to clear)', () => {
      // totalTerms 0 is coerced to 1, so the rule is still "match what exists".
      expect(meetsLexicalCoverageFloor(1, 0)).toBe(true);
    });
  });

  describe('rrfNorm', () => {
    it('is 1 at rank 0 and strictly decreasing', () => {
      expect(rrfNorm(0)).toBe(1);
      for (let r = 1; r < 100; r++) {
        expect(rrfNorm(r)).toBeLessThan(rrfNorm(r - 1));
        expect(rrfNorm(r)).toBeGreaterThan(0);
      }
    });
  });

  describe('ftsRescueScore', () => {
    it('puts the best FTS hit exactly at the band top (1.25)', () => {
      expect(ftsRescueScore(0.42, 0.42, 0)).toBeCloseTo(
        FTS_RESCUE_BAND_TOP,
        10,
      );
      expect(ftsRescueScore(0.42, 0.42, 0)).toBe(1.25);
    });

    it('gives DIFFERENT scores to candidates with different ts_rank', () => {
      // This is the core defect: both of these used to be exactly 1.25.
      const strong = ftsRescueScore(0.9, 0.9, 0);
      const weak = ftsRescueScore(0.1, 0.9, 1);
      expect(strong).not.toBe(weak);
      expect(strong).toBeGreaterThan(weak);
    });

    it('is strictly decreasing with rank even when ts_rank ties exactly', () => {
      // Near-duplicate distractors routinely produce identical ts_rank; the
      // RRF positional term is what stops them collapsing into a tie.
      const scores = [0, 1, 2, 3, 4].map((r) => ftsRescueScore(0.5, 0.5, r));
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThan(scores[i - 1]);
      }
      expect(new Set(scores).size).toBe(scores.length);
    });

    it('stays inside the (1.10, 1.25] band for any input', () => {
      for (let r = 0; r < 100; r++) {
        const s = ftsRescueScore(Math.random() * 0.9, 0.9, r);
        expect(s).toBeGreaterThan(FTS_RESCUE_BAND_BOTTOM);
        expect(s).toBeLessThanOrEqual(FTS_RESCUE_BAND_TOP);
      }
      // Degenerate inputs must not escape the band either.
      expect(ftsRescueScore(NaN, 0, 0)).toBeGreaterThan(FTS_RESCUE_BAND_BOTTOM);
      expect(ftsRescueScore(NaN, 0, 0)).toBeLessThanOrEqual(
        FTS_RESCUE_BAND_TOP,
      );
      expect(ftsRescueScore(0, 1, 99)).toBeGreaterThan(FTS_RESCUE_BAND_BOTTOM);
    });

    it('still outranks a near-perfect 0.99 cosine hit', () => {
      expect(ftsRescueScore(0.001, 0.9, 99)).toBeGreaterThan(0.99);
      expect(ftsRescueScore(0.9, 0.9, 0)).toBeGreaterThan(0.99);
    });
  });

  describe('ilikeRescueScore', () => {
    it('scores full coverage at rank 0 exactly at the band top (1.10)', () => {
      expect(ilikeRescueScore(3, 3, 0)).toBeCloseTo(ILIKE_RESCUE_BAND_TOP, 10);
    });

    it('ranks higher lexical coverage above lower coverage', () => {
      expect(ilikeRescueScore(3, 3, 5)).toBeGreaterThan(
        ilikeRescueScore(1, 3, 0),
      );
    });

    it('is strictly decreasing with rank at equal coverage', () => {
      const scores = [0, 1, 2, 3].map((r) => ilikeRescueScore(2, 3, r));
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThan(scores[i - 1]);
      }
    });

    it('stays strictly inside (1.00, 1.10] and below the FTS band', () => {
      for (let r = 0; r < 40; r++) {
        const s = ilikeRescueScore((r % 3) + 1, 3, r);
        expect(s).toBeGreaterThan(ILIKE_RESCUE_BAND_BOTTOM);
        expect(s).toBeLessThanOrEqual(ILIKE_RESCUE_BAND_TOP);
        // Inter-band policy: FTS rescue > ILIKE rescue > cosine.
        expect(s).toBeLessThan(ftsRescueScore(0.0001, 1, 999));
        expect(s).toBeGreaterThan(1.0);
      }
    });

    it('handles a zero/garbled match count without collapsing to the floor', () => {
      expect(ilikeRescueScore(0, 3, 0)).toBeGreaterThan(
        ILIKE_RESCUE_BAND_BOTTOM,
      );
      expect(ilikeRescueScore(0, 0, 0)).toBeGreaterThan(
        ILIKE_RESCUE_BAND_BOTTOM,
      );
    });
  });

  describe('compareByRankKeys', () => {
    const day = (n: number) => new Date(2026, 0, n);

    it('orders by score descending first', () => {
      const out = sortByRank([
        { id: 'a', score: 0.5 },
        { id: 'b', score: 0.9 },
      ]);
      expect(out.map((m) => m.id)).toEqual(['b', 'a']);
    });

    it('breaks score ties on cosine similarity', () => {
      const out = sortByRank([
        { id: 'a', score: 1.25, vectorScore: 0.2 },
        { id: 'b', score: 1.25, vectorScore: 0.8 },
      ]);
      expect(out.map((m) => m.id)).toEqual(['b', 'a']);
    });

    it('sorts candidates with no vector hit after ones that have one', () => {
      const out = sortByRank([
        { id: 'a', score: 1.25 },
        { id: 'b', score: 1.25, vectorScore: 0 },
      ]);
      expect(out.map((m) => m.id)).toEqual(['b', 'a']);
    });

    it('falls through to importance, then createdAt, then id', () => {
      expect(
        sortByRank([
          { id: 'a', score: 1, vectorScore: 0.5, importanceScore: 0.2 },
          { id: 'b', score: 1, vectorScore: 0.5, importanceScore: 0.9 },
        ]).map((m) => m.id),
      ).toEqual(['b', 'a']);

      expect(
        sortByRank([
          {
            id: 'a',
            score: 1,
            vectorScore: 0.5,
            importanceScore: 0.5,
            createdAt: day(1),
          },
          {
            id: 'b',
            score: 1,
            vectorScore: 0.5,
            importanceScore: 0.5,
            createdAt: day(9),
          },
        ]).map((m) => m.id),
      ).toEqual(['b', 'a']);

      expect(
        sortByRank([
          {
            id: 'zzz',
            score: 1,
            vectorScore: 0.5,
            importanceScore: 0.5,
            createdAt: day(1),
          },
          {
            id: 'aaa',
            score: 1,
            vectorScore: 0.5,
            importanceScore: 0.5,
            createdAt: day(1),
          },
        ]).map((m) => m.id),
      ).toEqual(['aaa', 'zzz']);
    });

    it('is order-independent: identical sets in different input orders sort identically', () => {
      // The defect: with a bare score comparator + stable sort, these two
      // permutations returned different top-1 results purely because of the
      // order Postgres handed the rows back in.
      const tied: RankableMemory[] = [
        { id: 'm3', score: 1.25, importanceScore: 0.5, createdAt: day(2) },
        { id: 'm1', score: 1.25, importanceScore: 0.5, createdAt: day(2) },
        { id: 'm5', score: 1.25, importanceScore: 0.5, createdAt: day(2) },
        { id: 'm2', score: 1.25, importanceScore: 0.5, createdAt: day(2) },
        { id: 'm4', score: 1.25, importanceScore: 0.5, createdAt: day(2) },
      ];
      const reversed = [...tied].reverse();
      const shuffled = [tied[2], tied[0], tied[4], tied[1], tied[3]];

      const a = sortByRank(tied).map((m) => m.id);
      const b = sortByRank(reversed).map((m) => m.id);
      const c = sortByRank(shuffled).map((m) => m.id);

      expect(a).toEqual(b);
      expect(a).toEqual(c);
      expect(a).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    });

    it('is a consistent comparator (antisymmetric)', () => {
      const x = { id: 'a', score: 1, vectorScore: 0.5 };
      const y = { id: 'b', score: 1, vectorScore: 0.5 };
      expect(Math.sign(compareByRankKeys(x, y))).toBe(
        -Math.sign(compareByRankKeys(y, x)),
      );
      expect(compareByRankKeys(x, x)).toBe(0);
    });
  });
});
