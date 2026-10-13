import { MemoryQueryService } from './memory-query.service';
import { MemoryQueryRankingService } from './memory-query-ranking.service';
import { MemoryQueryContextService } from './memory-query-context.service';
import { RecallWeightService } from './recall-weight.service';
import {
  compareByRankKeys,
  compareByScore,
  recallRankComparator,
  rescueSqlTiebreak,
} from './memory-ranking.util';
import {
  nearDuplicateClusterLimit,
  selectNearDuplicateDiverse,
} from './memory-diversity.util';
import { MemoryWithScore } from './memory.types';

/**
 * ENG-9: PR #324 (deterministic ranking) and PR #327 (near-duplicate cluster
 * cap) ported onto the #328 base behind default-off flags.
 */
describe('recall ranking flags (ENG-9)', () => {
  const ENV_KEYS = [
    'RECALL_DETERMINISTIC_RANKING',
    'RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('memory-ranking.util', () => {
    const tied = [
      { id: 'b', score: 0.5, createdAt: new Date('2026-01-01') },
      { id: 'a', score: 0.5, createdAt: new Date('2026-01-01') },
      { id: 'c', score: 0.5, createdAt: new Date('2026-03-01') },
      { id: 'd', score: 0.5, vectorScore: 0.4 },
    ];

    it('compareByRankKeys gives the same order for any input order', () => {
      const forward = [...tied].sort(compareByRankKeys).map((m) => m.id);
      const reversed = [...tied]
        .reverse()
        .sort(compareByRankKeys)
        .map((m) => m.id);
      // vector hit first, then newer, then id asc
      expect(forward).toEqual(['d', 'c', 'a', 'b']);
      expect(reversed).toEqual(forward);
    });

    it('compareByScore leaves ties in input order (shipped behaviour)', () => {
      expect([...tied].sort(compareByScore).map((m) => m.id)).toEqual([
        'b',
        'a',
        'c',
        'd',
      ]);
    });

    it('score still dominates every tie-break key', () => {
      const items = [
        { id: 'a', score: 0.4, vectorScore: 0.99 },
        { id: 'z', score: 0.6 },
      ];
      expect(items.sort(compareByRankKeys).map((m) => m.id)).toEqual([
        'z',
        'a',
      ]);
    });

    it('flag selects the comparator and the SQL tiebreak', () => {
      expect(recallRankComparator()).toBe(compareByScore);
      expect(rescueSqlTiebreak()).toBe('');
      process.env.RECALL_DETERMINISTIC_RANKING = 'true';
      expect(recallRankComparator()).toBe(compareByRankKeys);
      expect(rescueSqlTiebreak('m.id')).toBe(', m.id ASC');
    });
  });

  describe('memory-diversity.util', () => {
    const mem = (id: string, raw: string) =>
      ({ id, raw, score: 1 }) as MemoryWithScore;

    it('caps a near-duplicate cluster and backfills to a full page', () => {
      const candidates = [
        mem('d1', 'deploy target is railway staging'),
        mem('d2', 'deploy target is railway staging'),
        mem('d3', 'deploy target is railway staging'),
        mem('x', 'the user prefers dark roast coffee'),
      ];
      expect(
        selectNearDuplicateDiverse(candidates, 2, 1).map((m) => m.id),
      ).toEqual(['d1', 'x']);
      expect(
        selectNearDuplicateDiverse(candidates, 3, 1).map((m) => m.id),
      ).toEqual(['d1', 'x', 'd2']);
    });

    it('parses the cluster limit env strictly', () => {
      expect(nearDuplicateClusterLimit()).toBeUndefined();
      process.env.RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT = '0';
      expect(nearDuplicateClusterLimit()).toBeUndefined();
      process.env.RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT = '1.5';
      expect(nearDuplicateClusterLimit()).toBeUndefined();
      process.env.RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT = '2';
      expect(nearDuplicateClusterLimit()).toBe(2);
    });
  });

  describe('MemoryQueryService.recall', () => {
    let service: MemoryQueryService;
    let prisma: any;
    let embedding: any;
    let temporalParser: any;

    beforeEach(() => {
      prisma = {
        memory: {
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      };
      embedding = {
        generate: jest.fn().mockResolvedValue([0.1, 0.2]),
        generateForRecall: jest.fn().mockResolvedValue([0.1, 0.2]),
        search: jest.fn().mockResolvedValue([]),
      };
      temporalParser = {
        parse: jest
          .fn()
          .mockReturnValue({ semanticQuery: 'q', temporalFilter: null }),
      };
      const recallWeightService = {
        recallWeight: jest.fn().mockReturnValue(1.0),
        applyUsageWeighting: jest
          .fn()
          .mockImplementation((mems: any[]) => Promise.resolve(mems)),
      } as any as RecallWeightService;
      const rankingService = new MemoryQueryRankingService(
        prisma,
        embedding,
        recallWeightService,
      );
      service = new MemoryQueryService(
        prisma,
        embedding,
        temporalParser,
        recallWeightService,
        rankingService,
        new MemoryQueryContextService(prisma),
      );
    });

    const rescueSql = (): string[] =>
      prisma.$queryRawUnsafe.mock.calls.map((call: any[]) => call[0]);

    it('flag off: rescue SQL is unchanged and ties keep row order', async () => {
      embedding.search.mockResolvedValue([
        { id: 'b', score: 0.8 },
        { id: 'a', score: 0.8 },
      ]);
      prisma.memory.findMany.mockResolvedValue([
        { id: 'b', raw: 'beta fact', createdAt: new Date('2026-01-01') },
        { id: 'a', raw: 'alpha fact', createdAt: new Date('2026-02-01') },
      ]);

      const result = await service.recall('u1', { query: 'q' } as any);

      expect(rescueSql().length).toBeGreaterThan(0);
      for (const sql of rescueSql()) expect(sql).not.toMatch(/id ASC/);
      expect(result.memories.map((m) => m.id)).toEqual(['b', 'a']);
      expect(result.memories[0]).not.toHaveProperty('vectorScore');
    });

    it('flag on: SQL tiebreaks on id and exact ties prefer the newer memory', async () => {
      process.env.RECALL_DETERMINISTIC_RANKING = 'true';
      embedding.search.mockResolvedValue([
        { id: 'b', score: 0.8 },
        { id: 'a', score: 0.8 },
      ]);
      prisma.memory.findMany.mockResolvedValue([
        { id: 'b', raw: 'beta fact', createdAt: new Date('2026-01-01') },
        { id: 'a', raw: 'alpha fact', createdAt: new Date('2026-02-01') },
      ]);

      const result = await service.recall('u1', { query: 'q' } as any);

      expect(rescueSql().length).toBeGreaterThan(0);
      for (const sql of rescueSql()) expect(sql).toMatch(/id ASC/);
      expect(result.memories.map((m) => m.id)).toEqual(['a', 'b']);
      expect(result.memories[0].vectorScore).toBe(0.8);
    });

    it('cluster cap keeps one near-duplicate and surfaces the distinct fact', async () => {
      const dup = 'the deploy target is railway staging';
      embedding.search.mockResolvedValue([
        { id: 'd1', score: 0.9 },
        { id: 'd2', score: 0.89 },
        { id: 'd3', score: 0.88 },
        { id: 'x', score: 0.5 },
      ]);
      prisma.memory.findMany.mockResolvedValue([
        { id: 'd1', raw: dup },
        { id: 'd2', raw: dup },
        { id: 'd3', raw: dup },
        { id: 'x', raw: 'the user prefers dark roast coffee' },
      ]);

      const off = await service.recall('u1', { query: 'q', limit: 2 } as any);
      expect(off.memories.map((m) => m.id)).toEqual(['d1', 'd2']);

      process.env.RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT = '1';
      const on = await service.recall('u1', { query: 'q', limit: 2 } as any);
      expect(on.memories.map((m) => m.id)).toEqual(['d1', 'x']);
    });
  });
});
