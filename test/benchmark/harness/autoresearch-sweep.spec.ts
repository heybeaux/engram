import {
  classifyDurability,
  runDurabilityAwareScoring,
  DurabilityAwareScoringConfig,
} from './autoresearch-sweep';

describe('autoresearch-sweep', () => {
  describe('classifyDurability', () => {
    it('classifies empty content as EPHEMERAL', () => {
      expect(classifyDurability('')).toBe('EPHEMERAL');
      expect(classifyDurability('   ')).toBe('EPHEMERAL');
    });

    it('classifies short content (<30 chars) as EPHEMERAL', () => {
      expect(classifyDurability('Had a good day today')).toBe('EPHEMERAL');
    });

    it('classifies preference patterns as DURABLE', () => {
      expect(
        classifyDurability(
          'I prefer dark roast coffee, especially single-origin Ethiopian beans',
        ),
      ).toBe('DURABLE');
      expect(
        classifyDurability(
          'I like to go for a run in the morning before work starts',
        ),
      ).toBe('DURABLE');
      expect(
        classifyDurability(
          'I love cooking Italian food especially homemade pasta dishes',
        ),
      ).toBe('DURABLE');
      expect(
        classifyDurability(
          'I always start my morning with a large cup of black coffee',
        ),
      ).toBe('DURABLE');
    });

    it('classifies fact patterns as DURABLE', () => {
      expect(
        classifyDurability(
          'My name is Alice and I work in software engineering',
        ),
      ).toBe('DURABLE');
      expect(
        classifyDurability('I work at a large tech company in Silicon Valley'),
      ).toBe('DURABLE');
      expect(
        classifyDurability('I live in Portland, Oregon with my family and dog'),
      ).toBe('DURABLE');
      expect(
        classifyDurability(
          'My daughter is starting kindergarten this fall at the local school',
        ),
      ).toBe('DURABLE');
    });

    it('classifies named entities as DURABLE', () => {
      expect(
        classifyDurability(
          'Had a meeting with Johnson about the quarterly review process',
        ),
      ).toBe('DURABLE');
    });

    it('classifies concrete numbers as DURABLE', () => {
      expect(
        classifyDurability(
          'She was born in 1990 and grew up in the countryside',
        ),
      ).toBe('DURABLE');
    });

    it('classifies generic content without durable signals as EPHEMERAL', () => {
      expect(
        classifyDurability(
          'had a pretty busy week at the office with lots of meetings',
        ),
      ).toBe('EPHEMERAL');
      expect(
        classifyDurability(
          'the weather was nice today and the sun was shining brightly',
        ),
      ).toBe('EPHEMERAL');
    });
  });

  describe('runDurabilityAwareScoring', () => {
    // Minimal test corpus: one durable memory, two ephemeral memories.
    // Importance scores are close enough that cosine difference decides
    // the winner without durability multipliers.
    const corpus = [
      {
        id: 'mem-durable-1',
        userId: 'user-1',
        raw: 'RLS_CANARY_ALICE_health_001: I take metformin every morning for diabetes management',
        layer: 'IDENTITY',
        importanceScore: 0.6,
        createdAt: '2026-01-01T00:00:00Z',
        embedding: [1, 0, 0],
      },
      {
        id: 'mem-ephemeral-1',
        userId: 'user-1',
        raw: 'RLS_CANARY_ALICE_daily_gen_001: had a normal morning routine today',
        layer: 'SESSION',
        importanceScore: 0.45,
        createdAt: '2026-03-01T00:00:00Z',
        embedding: [0.9, 0.1, 0],
      },
      {
        id: 'mem-ephemeral-2',
        userId: 'user-1',
        raw: 'RLS_CANARY_ALICE_daily_gen_002: woke up early and got ready for the day ahead',
        layer: 'SESSION',
        importanceScore: 0.4,
        createdAt: '2026-03-02T00:00:00Z',
        embedding: [0.85, 0.15, 0],
      },
    ];

    const queries = [
      {
        id: 'test_q1',
        query: 'medication I need to take every morning',
        user: 'alice',
        must_top5: ['mem-durable-1'],
        should_top20: [],
        must_absent: [],
        category: 'test',
        embedding: [1, 0, 0],
      },
    ];

    // Cosine scores where ephemeral has significantly higher cosine,
    // enough to overcome the importance difference at neutral multipliers.
    // durable:   0.75*0.85 + 0.6*0.15 = 0.6375 + 0.09 = 0.7275
    // ephemeral: 0.92*0.85 + 0.45*0.15 = 0.782 + 0.0675 = 0.8495
    const cosineScores = {
      test_q1: {
        'mem-durable-1': 0.75,
        'mem-ephemeral-1': 0.92,
        'mem-ephemeral-2': 0.8,
      },
    };

    it('without durability boost, ephemeral memory with higher cosine wins', () => {
      const config: DurabilityAwareScoringConfig = {
        preRerankK: 120,
        cosineWeight: 0.85,
        importanceFinalWeight: 0.15,
        durableBoost: 1.0,
        ephemeralPenalty: 1.0,
      };

      const durabilityMap = new Map([
        ['mem-durable-1', 'DURABLE' as const],
        ['mem-ephemeral-1', 'EPHEMERAL' as const],
        ['mem-ephemeral-2', 'EPHEMERAL' as const],
      ]);

      const results = runDurabilityAwareScoring(
        config,
        queries,
        corpus,
        cosineScores,
        durabilityMap,
      );

      const top5 = results.get('test_q1')!;
      // Ephemeral-1 has cosine 0.88 > durable's 0.82, so it wins at neutral multipliers
      expect(top5[0]).toBe('mem-ephemeral-1');
    });

    it('with durability boost, durable memory overtakes ephemeral', () => {
      const config: DurabilityAwareScoringConfig = {
        preRerankK: 120,
        cosineWeight: 0.85,
        importanceFinalWeight: 0.15,
        durableBoost: 2.0,
        ephemeralPenalty: 0.5,
      };

      const durabilityMap = new Map([
        ['mem-durable-1', 'DURABLE' as const],
        ['mem-ephemeral-1', 'EPHEMERAL' as const],
        ['mem-ephemeral-2', 'EPHEMERAL' as const],
      ]);

      const results = runDurabilityAwareScoring(
        config,
        queries,
        corpus,
        cosineScores,
        durabilityMap,
      );

      const top5 = results.get('test_q1')!;
      // With boost=2.0 on durable (imp 0.6*2.0=1.2) vs penalty=0.5 on ephemeral (imp 0.45*0.5=0.225):
      // durable score = 0.75*0.85 + 1.2*0.15 = 0.6375 + 0.18 = 0.8175
      // ephemeral-1 score = 0.92*0.85 + 0.225*0.15 = 0.782 + 0.034 = 0.816
      expect(top5[0]).toBe('mem-durable-1');
    });

    it('respects user isolation (only scores memories for the query user)', () => {
      const corpusWithBob = [
        ...corpus,
        {
          id: 'mem-bob-1',
          userId: 'user-2',
          raw: 'RLS_CANARY_BOB_health_001: I take aspirin daily for heart health',
          layer: 'IDENTITY',
          importanceScore: 0.9,
          createdAt: '2026-01-01T00:00:00Z',
          embedding: [1, 0, 0],
        },
      ];

      const cosineWithBob: Record<string, Record<string, number>> = {
        test_q1: {
          ...cosineScores.test_q1,
          'mem-bob-1': 0.99, // Bob's memory has highest cosine
        },
      };

      const config: DurabilityAwareScoringConfig = {
        preRerankK: 120,
        cosineWeight: 0.85,
        importanceFinalWeight: 0.15,
        durableBoost: 1.0,
        ephemeralPenalty: 1.0,
      };

      const durabilityMap = new Map([
        ['mem-durable-1', 'DURABLE' as const],
        ['mem-ephemeral-1', 'EPHEMERAL' as const],
        ['mem-ephemeral-2', 'EPHEMERAL' as const],
        ['mem-bob-1', 'DURABLE' as const],
      ]);

      const results = runDurabilityAwareScoring(
        config,
        queries,
        corpusWithBob,
        cosineWithBob,
        durabilityMap,
      );

      const top5 = results.get('test_q1')!;
      // Bob's memory should NOT appear — query is for alice
      expect(top5).not.toContain('mem-bob-1');
    });

    it('returns empty array for queries with no matching user memories', () => {
      const queriesNoUser = [
        {
          ...queries[0],
          id: 'test_q_unknown',
          user: 'unknown_user',
        },
      ];

      const config: DurabilityAwareScoringConfig = {
        preRerankK: 120,
        cosineWeight: 0.85,
        importanceFinalWeight: 0.15,
        durableBoost: 1.0,
        ephemeralPenalty: 1.0,
      };

      const durabilityMap = new Map<
        string,
        'DURABLE' | 'EPHEMERAL' | 'UNCLASSIFIED'
      >();

      const results = runDurabilityAwareScoring(
        config,
        queriesNoUser,
        corpus,
        cosineScores,
        durabilityMap,
      );

      expect(results.get('test_q_unknown')).toEqual([]);
    });

    it('handles UNCLASSIFIED durability with neutral multiplier', () => {
      const config: DurabilityAwareScoringConfig = {
        preRerankK: 120,
        cosineWeight: 0.85,
        importanceFinalWeight: 0.15,
        durableBoost: 2.0,
        ephemeralPenalty: 0.5,
      };

      // All memories are UNCLASSIFIED — no boost or penalty
      const durabilityMap = new Map([
        ['mem-durable-1', 'UNCLASSIFIED' as const],
        ['mem-ephemeral-1', 'UNCLASSIFIED' as const],
        ['mem-ephemeral-2', 'UNCLASSIFIED' as const],
      ]);

      const results = runDurabilityAwareScoring(
        config,
        queries,
        corpus,
        cosineScores,
        durabilityMap,
      );

      const top5 = results.get('test_q1')!;
      // With all UNCLASSIFIED, cosine dominates — ephemeral-1 has highest cosine
      expect(top5[0]).toBe('mem-ephemeral-1');
    });
  });
});
