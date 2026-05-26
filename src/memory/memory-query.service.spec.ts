import { BadRequestException } from '@nestjs/common';
import { MemoryQueryService } from './memory-query.service';
import { MemoryQueryRankingService } from './memory-query-ranking.service';
import { MemoryQueryContextService } from './memory-query-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { TemporalParserService } from './temporal/temporal-parser.service';
import { MultiQueryService } from '../multi-query/multi-query.service';
import { MemoryPoolService } from '../memory-pool/memory-pool.service';
import { MemoryAccessLogService } from '../memory-access-log/memory-access-log.service';
import { RecallWeightService } from './recall-weight.service';
import { RerankService } from '../embedding/rerank.service';

describe('MemoryQueryService', () => {
  let service: MemoryQueryService;
  let prisma: jest.Mocked<PrismaService>;
  let embedding: jest.Mocked<EmbeddingService>;
  let temporalParser: jest.Mocked<TemporalParserService>;
  let multiQueryService: jest.Mocked<MultiQueryService>;
  let memoryPoolService: jest.Mocked<MemoryPoolService>;
  let memoryAccessLogService: jest.Mocked<MemoryAccessLogService>;
  let rankingService: MemoryQueryRankingService;
  let contextService: MemoryQueryContextService;

  const userId = 'user-123';
  const mockEmbedding = [0.1, 0.2, 0.3];

  beforeEach(() => {
    prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as any;

    embedding = {
      generate: jest.fn().mockResolvedValue(mockEmbedding),
      generateForRecall: jest.fn().mockResolvedValue(mockEmbedding),
      search: jest.fn().mockResolvedValue([]),
    } as any;

    temporalParser = {
      parse: jest.fn().mockReturnValue({
        semanticQuery: 'test query',
        temporalFilter: null,
      }),
      calculateTemporalRelevance: jest.fn().mockReturnValue(0.8),
      blendScores: jest.fn().mockReturnValue(0.7),
      expandWindow: jest.fn().mockImplementation((filter, multiplier) => {
        const mid = (filter.start.getTime() + filter.end.getTime()) / 2;
        const halfSpan = (filter.end.getTime() - filter.start.getTime()) / 2;
        return {
          ...filter,
          start: new Date(mid - halfSpan * multiplier),
          end: new Date(mid + halfSpan * multiplier),
        };
      }),
    } as any;

    multiQueryService = {
      isEnabled: jest.fn().mockReturnValue(false),
      search: jest.fn(),
      generateMetadata: jest.fn().mockReturnValue({
        queryCount: 1,
        strategy: 'default',
        explanations: [],
      }),
    } as any;

    memoryPoolService = {
      getAccessiblePoolIds: jest.fn().mockResolvedValue(['pool-1']),
    } as any;

    memoryAccessLogService = {
      logRecalled: jest.fn().mockResolvedValue(undefined),
    } as any;

    const recallWeightService = {
      recallWeight: jest.fn().mockReturnValue(1.0),
      applyUsageWeighting: jest
        .fn()
        .mockImplementation((mems: any[]) => Promise.resolve(mems)),
    } as any as RecallWeightService;

    // Create sub-services with shared deps
    rankingService = new MemoryQueryRankingService(
      prisma,
      embedding,
      recallWeightService,
    );

    contextService = new MemoryQueryContextService(prisma);

    service = new MemoryQueryService(
      prisma,
      embedding,
      temporalParser,
      recallWeightService,
      rankingService,
      contextService,
      multiQueryService,
      memoryPoolService,
      memoryAccessLogService,
    );
  });

  describe('recall', () => {
    it('should perform standard semantic search', async () => {
      embedding.search.mockResolvedValue([
        { id: 'm1', score: 0.9 },
        { id: 'm2', score: 0.7 },
      ] as any);

      prisma.memory.findMany = jest.fn().mockResolvedValue([
        { id: 'm1', raw: 'memory 1', effectiveScore: 0.8, extraction: {} },
        { id: 'm2', raw: 'memory 2', effectiveScore: 0.6, extraction: {} },
      ]);

      const result = await service.recall(userId, {
        query: 'test query',
      } as any);

      expect(result.memories).toHaveLength(2);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(embedding.generateForRecall).toHaveBeenCalledWith('test query');
    });

    it('should use temporal path when temporal intent detected', async () => {
      temporalParser.parse.mockReturnValue({
        semanticQuery: 'meeting',
        temporalFilter: {
          expression: 'yesterday',
          start: new Date('2026-02-14'),
          end: new Date('2026-02-15'),
        },
      } as any);

      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'yesterday meeting',
          effectiveScore: 0.8,
          createdAt: new Date('2026-02-14T10:00:00Z'),
          extraction: {},
        },
      ]);

      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);

      const result = await service.recall(userId, {
        query: 'yesterday meeting',
      } as any);
      expect(result.memories).toHaveLength(1);
      expect(temporalParser.blendScores).toHaveBeenCalledWith(
        0.9,
        0.8,
        0.8,
        true,
      );
    });

    it('should resolve pool IDs from agentSessionKey', async () => {
      embedding.search.mockResolvedValue([]);
      const result = await service.recall(userId, {
        query: 'test',
        agentSessionKey: 'session-1',
      } as any);

      expect(memoryPoolService.getAccessiblePoolIds).toHaveBeenCalledWith(
        'session-1',
        userId,
        undefined,
      );
      expect(result.memories).toHaveLength(0);
    });

    it('should handle pool resolution failure gracefully', async () => {
      memoryPoolService.getAccessiblePoolIds.mockRejectedValue(
        new Error('fail'),
      );
      embedding.search.mockResolvedValue([]);

      const result = await service.recall(userId, {
        query: 'test',
        agentSessionKey: 'session-1',
      } as any);

      expect(result.memories).toHaveLength(0);
    });

    it('should update retrieval counts for returned memories', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);
      prisma.memory.findMany = jest
        .fn()
        .mockResolvedValue([
          { id: 'm1', raw: 'test', effectiveScore: 0.5, extraction: {} },
        ]);

      await service.recall(userId, { query: 'test' } as any);

      expect(prisma.memory.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['m1'] } },
        data: {
          retrievalCount: { increment: 1 },
          lastRetrievedAt: expect.any(Date),
        },
      });
    });

    it('should pass filter tags and metadata to embedding search (ENG-42)', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'test',
          effectiveScore: 0.5,
          extraction: {},
          tags: ['google-ads'],
        },
      ]);

      await service.recall(userId, {
        query: 'test',
        filter: {
          tags: ['google-ads'],
          metadata: { client: 'acme' },
        },
      } as any);

      // temporalParser mock transforms query to 'test query'
      expect(embedding.search).toHaveBeenCalledWith(
        userId,
        mockEmbedding,
        expect.any(Number),
        undefined,
        undefined,
        undefined,
        'test query',
        ['google-ads'],
        { client: 'acme' },
      );
    });

    it('should apply tag filter to Prisma findMany (ENG-42)', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([]);

      await service.recall(userId, {
        query: 'test',
        filter: { tags: ['important', 'project-x'] },
      } as any);

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tags: { hasEvery: ['important', 'project-x'] },
          }),
        }),
      );
    });

    it('should apply metadata filter to Prisma findMany (ENG-42)', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([]);

      await service.recall(userId, {
        query: 'test',
        filter: { metadata: { client: 'acme' } },
      } as any);

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [{ metadata: { path: ['client'], equals: 'acme' } }],
          }),
        }),
      );
    });

    it('should use explicit poolIds for scoped recall (ENG-42)', async () => {
      embedding.search.mockResolvedValue([]);
      const result = await service.recall(userId, {
        query: 'test',
        poolIds: ['pool:map-international:google-ads'],
      } as any);

      // poolIds should be passed to embedding.search, not resolved from session
      expect(memoryPoolService.getAccessiblePoolIds).not.toHaveBeenCalled();
      // temporalParser mock transforms query to 'test query'
      expect(embedding.search).toHaveBeenCalledWith(
        userId,
        mockEmbedding,
        expect.any(Number),
        undefined,
        undefined,
        ['pool:map-international:google-ads'],
        'test query',
        undefined,
        undefined,
      );
    });

    // ── ENG-48: Temporal and arc filtering ─────────────────────────────

    it('should filter memories by after date (ENG-48)', async () => {
      embedding.search.mockResolvedValue([
        { id: 'm1', score: 0.9 },
        { id: 'm2', score: 0.8 },
      ] as any);

      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'recent',
          effectiveScore: 0.5,
          extraction: {},
          createdAt: new Date('2026-03-22'),
        },
      ]);

      const result = await service.recall(userId, {
        query: 'test',
        after: '2026-03-21',
      } as any);

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: new Date('2026-03-21') },
          }),
        }),
      );
      expect(result.memories).toHaveLength(1);
    });

    it('should filter memories by before date (ENG-48)', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);

      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'old',
          effectiveScore: 0.5,
          extraction: {},
          createdAt: new Date('2026-03-10'),
        },
      ]);

      const result = await service.recall(userId, {
        query: 'test',
        before: '2026-03-15',
      } as any);

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { lte: new Date('2026-03-15') },
          }),
        }),
      );
      expect(result.memories).toHaveLength(1);
    });

    it('should filter memories by combined after+before date range (ENG-48)', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);

      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'in range',
          effectiveScore: 0.5,
          extraction: {},
          createdAt: new Date('2026-03-12'),
        },
      ]);

      const result = await service.recall(userId, {
        query: 'test',
        after: '2026-03-10',
        before: '2026-03-15',
      } as any);

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: {
              gte: new Date('2026-03-10'),
              lte: new Date('2026-03-15'),
            },
          }),
        }),
      );
      expect(result.memories).toHaveLength(1);
    });

    it('should pass arc tag to embedding search and Prisma filter (ENG-48)', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);

      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'arc memory',
          effectiveScore: 0.5,
          extraction: {},
          tags: ['my-arc'],
        },
      ]);

      await service.recall(userId, {
        query: 'test',
        arc: 'my-arc',
      } as any);

      // Arc should be passed as filterTags to embedding.search
      expect(embedding.search).toHaveBeenCalledWith(
        userId,
        mockEmbedding,
        expect.any(Number),
        undefined,
        undefined,
        undefined,
        'test query',
        ['my-arc'],
        undefined,
      );

      // Arc should also appear in Prisma where clause
      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tags: { hasEvery: ['my-arc'] },
          }),
        }),
      );
    });

    it('should merge arc tag with existing filter.tags (ENG-48)', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);

      prisma.memory.findMany = jest.fn().mockResolvedValue([]);

      await service.recall(userId, {
        query: 'test',
        arc: 'my-arc',
        filter: { tags: ['existing-tag'] },
      } as any);

      // Both tags should be passed to embedding.search
      expect(embedding.search).toHaveBeenCalledWith(
        userId,
        mockEmbedding,
        expect.any(Number),
        undefined,
        undefined,
        undefined,
        'test query',
        ['existing-tag', 'my-arc'],
        undefined,
      );

      // Both tags in Prisma filter
      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tags: { hasEvery: ['existing-tag', 'my-arc'] },
          }),
        }),
      );
    });

    it('should throw BadRequestException for type="timeline" (ENG-48)', async () => {
      await expect(
        service.recall(userId, {
          query: 'test',
          type: 'timeline',
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow type="memory" as a no-op (ENG-48)', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);

      prisma.memory.findMany = jest
        .fn()
        .mockResolvedValue([
          { id: 'm1', raw: 'test', effectiveScore: 0.5, extraction: {} },
        ]);

      const result = await service.recall(userId, {
        query: 'test',
        type: 'memory',
      } as any);

      expect(result.memories).toHaveLength(1);
    });

    it('should not add createdAt filter when after/before not provided (ENG-48)', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);

      prisma.memory.findMany = jest
        .fn()
        .mockResolvedValue([
          { id: 'm1', raw: 'test', effectiveScore: 0.5, extraction: {} },
        ]);

      await service.recall(userId, {
        query: 'test',
      } as any);

      const findManyCall = (prisma.memory.findMany as jest.Mock).mock
        .calls[0][0];
      expect(findManyCall.where.createdAt).toBeUndefined();
    });

    it('should log access when agentSessionKey provided', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);
      prisma.memory.findMany = jest
        .fn()
        .mockResolvedValue([
          { id: 'm1', raw: 'test', effectiveScore: 0.5, extraction: {} },
        ]);

      await service.recall(userId, {
        query: 'test',
        agentSessionKey: 'agent-1',
      } as any);

      expect(memoryAccessLogService.logRecalled).toHaveBeenCalledWith(
        ['m1'],
        'agent-1',
        'test',
      );
    });
  });

  describe('shouldUseMultiQuery', () => {
    it('should return false when multiQueryService is not available', () => {
      const recallWeightService = {
        recallWeight: jest.fn().mockReturnValue(1.0),
        applyUsageWeighting: jest
          .fn()
          .mockImplementation((m: any) => Promise.resolve(m)),
      } as any as RecallWeightService;
      const svc = new MemoryQueryService(
        prisma,
        embedding,
        temporalParser,
        recallWeightService,
        rankingService,
        contextService,
      );
      expect(svc.shouldUseMultiQuery({} as any)).toBe(false);
    });

    it('should respect explicit enabled=false', () => {
      expect(
        service.shouldUseMultiQuery({ multiQuery: { enabled: false } } as any),
      ).toBe(false);
    });

    it('should respect explicit enabled=true', () => {
      expect(
        service.shouldUseMultiQuery({ multiQuery: { enabled: true } } as any),
      ).toBe(true);
    });

    it('should fall back to service isEnabled', () => {
      multiQueryService.isEnabled.mockReturnValue(true);
      expect(service.shouldUseMultiQuery({} as any)).toBe(true);
    });
  });

  describe('buildTemporalRangeFilter (ENG-48)', () => {
    it('should return empty object when no after/before provided', () => {
      const result = service.buildTemporalRangeFilter({} as any);
      expect(result).toEqual({});
    });

    it('should build gte filter for after', () => {
      const result = service.buildTemporalRangeFilter({
        after: '2026-03-20',
      } as any);
      expect(result).toEqual({ createdAt: { gte: new Date('2026-03-20') } });
    });

    it('should build lte filter for before', () => {
      const result = service.buildTemporalRangeFilter({
        before: '2026-03-24',
      } as any);
      expect(result).toEqual({ createdAt: { lte: new Date('2026-03-24') } });
    });

    it('should build combined gte+lte filter for after+before', () => {
      const result = service.buildTemporalRangeFilter({
        after: '2026-03-20',
        before: '2026-03-24',
      } as any);
      expect(result).toEqual({
        createdAt: { gte: new Date('2026-03-20'), lte: new Date('2026-03-24') },
      });
    });
  });

  describe('buildMetadataFilter (ENG-42)', () => {
    it('should return empty object when no filter provided', () => {
      const result = service.buildMetadataFilter({} as any);
      expect(result).toEqual({});
    });

    it('should build tag filter with hasEvery (AND logic)', () => {
      const result = service.buildMetadataFilter({
        filter: { tags: ['a', 'b'] },
      } as any);
      expect(result).toEqual({ tags: { hasEvery: ['a', 'b'] } });
    });

    it('should build metadata path filter for each key-value pair', () => {
      const result = service.buildMetadataFilter({
        filter: { metadata: { client: 'acme', env: 'prod' } },
      } as any);
      expect(result).toEqual({
        AND: [
          { metadata: { path: ['client'], equals: 'acme' } },
          { metadata: { path: ['env'], equals: 'prod' } },
        ],
      });
    });

    it('should combine tags and metadata filters', () => {
      const result = service.buildMetadataFilter({
        filter: { tags: ['x'], metadata: { k: 'v' } },
      } as any);
      expect(result).toEqual({
        tags: { hasEvery: ['x'] },
        AND: [{ metadata: { path: ['k'], equals: 'v' } }],
      });
    });

    it('should include arc tag in hasEvery filter (ENG-48)', () => {
      const result = service.buildMetadataFilter({
        arc: 'my-arc',
      } as any);
      expect(result).toEqual({ tags: { hasEvery: ['my-arc'] } });
    });

    it('should merge arc with existing filter.tags (ENG-48)', () => {
      const result = service.buildMetadataFilter({
        arc: 'my-arc',
        filter: { tags: ['existing'] },
      } as any);
      expect(result).toEqual({ tags: { hasEvery: ['existing', 'my-arc'] } });
    });
  });

  describe('temporal path — reranking query selection', () => {
    it('should pass original query (with temporal expression) to reranker on temporal path', async () => {
      const mockRerankService = {
        rerank: jest.fn().mockResolvedValue([{ index: 0, score: 0.9 }]),
      } as unknown as RerankService;

      const recallWeightService = {
        recallWeight: jest.fn().mockReturnValue(1.0),
        applyUsageWeighting: jest
          .fn()
          .mockImplementation((mems: any[]) => Promise.resolve(mems)),
      } as unknown as RecallWeightService;

      // Create ranking service WITH reranker
      const rankingSvcWithReranker = new MemoryQueryRankingService(
        prisma,
        embedding,
        recallWeightService,
        mockRerankService,
      );

      const serviceWithReranker = new MemoryQueryService(
        prisma,
        embedding,
        temporalParser,
        recallWeightService,
        rankingSvcWithReranker,
        contextService,
      );

      temporalParser.parse.mockReturnValue({
        semanticQuery: 'What did I work on?',
        temporalFilter: {
          expression: 'last week',
          start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          end: new Date(),
        },
      } as any);

      const memInRange = {
        id: 'm-lw',
        raw: 'Last week I rewrote the API auth module completely.',
        createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        importanceScore: 0.6,
        effectiveScore: 0.6,
        deletedAt: null,
        supersededById: null,
        layer: 'SESSION',
        extraction: null,
      };

      prisma.memory.findMany = jest.fn().mockResolvedValue([memInRange]);
      embedding.search.mockResolvedValue([{ id: 'm-lw', score: 0.8 }] as any);

      await serviceWithReranker.recall('user-123', {
        query: 'What did I work on last week?',
        limit: 5,
      } as any);

      // Cross-encoder must receive the original query (including "last week")
      // so it can rank memories with "last week" context correctly
      expect((mockRerankService as any).rerank).toHaveBeenCalledWith(
        'What did I work on last week?',
        expect.any(Array),
      );
    });

    it('should pass stripped semantic query to reranker on standard (non-temporal) path', async () => {
      const mockRerankService = {
        rerank: jest.fn().mockResolvedValue([{ index: 0, score: 0.9 }]),
      } as unknown as RerankService;

      const recallWeightService = {
        recallWeight: jest.fn().mockReturnValue(1.0),
        applyUsageWeighting: jest
          .fn()
          .mockImplementation((mems: any[]) => Promise.resolve(mems)),
      } as unknown as RecallWeightService;

      const rankingSvcWithReranker = new MemoryQueryRankingService(
        prisma,
        embedding,
        recallWeightService,
        mockRerankService,
      );

      const serviceWithReranker = new MemoryQueryService(
        prisma,
        embedding,
        temporalParser,
        recallWeightService,
        rankingSvcWithReranker,
        contextService,
      );

      // No temporal intent — parser returns original query as semanticQuery
      temporalParser.parse.mockReturnValue({
        semanticQuery: 'What kind of coffee do I like?',
        temporalFilter: null,
      } as any);

      const mem = {
        id: 'm-coffee',
        raw: 'I prefer pour-over coffee with a V60.',
        importanceScore: 0.6,
        effectiveScore: 0.6,
        deletedAt: null,
        supersededById: null,
        layer: 'IDENTITY',
        extraction: null,
      };

      embedding.search.mockResolvedValue([
        { id: 'm-coffee', score: 0.9 },
      ] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([mem]);

      await serviceWithReranker.recall('user-123', {
        query: 'What kind of coffee do I like?',
        limit: 5,
      } as any);

      // Standard path: semanticQuery equals original query (no temporal stripping)
      expect((mockRerankService as any).rerank).toHaveBeenCalledWith(
        'What kind of coffee do I like?',
        expect.any(Array),
      );
    });
  });

  describe('surfaceInsights (HEY-135)', () => {
    it('should reuse cached query embedding instead of re-generating', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);

      prisma.memory.findMany = jest
        .fn()
        .mockResolvedValueOnce([
          // standard recall
          { id: 'm1', raw: 'memory 1', effectiveScore: 0.8, extraction: {} },
        ])
        .mockResolvedValueOnce([]); // insight query returns none

      await service.recall(userId, { query: 'test query' } as any);

      // embedding.generate should be called exactly once (for the query),
      // NOT twice (surfaceInsights reuses the cached embedding)
      expect(embedding.generateForRecall).toHaveBeenCalledTimes(1);
    });

    it('should use vector search for insight relevance instead of re-embedding each', async () => {
      const insightMemory = {
        id: 'insight-1',
        raw: 'user prefers dark mode',
        layer: 'INSIGHT',
        importanceScore: 0.8,
        effectiveScore: 0.8,
        createdAt: new Date(),
        extraction: {},
        deletedAt: null,
        supersededById: null,
      };

      // Mock findMany to return insights when queried with INSIGHT layer
      prisma.memory.findMany = jest.fn().mockImplementation((args: any) => {
        if (args?.where?.layer === 'INSIGHT') {
          return Promise.resolve([insightMemory]);
        }
        return Promise.resolve([
          { id: 'm1', raw: 'memory 1', effectiveScore: 0.8, extraction: {} },
        ]);
      });

      embedding.search
        .mockResolvedValueOnce([{ id: 'm1', score: 0.9 }]) // standard search
        .mockResolvedValueOnce([{ id: 'insight-1', score: 0.5 }]); // insight vector search

      await service.recall(userId, { query: 'test query' } as any);

      // embedding.search called twice: main recall + insight relevance via vector search
      const searchCalls = embedding.search.mock.calls;
      expect(searchCalls.length).toBe(2);
      // Second call should filter by INSIGHT layer
      expect(searchCalls[1][3]).toEqual(['INSIGHT']);
      // Should NOT re-embed each insight individually — only 1 generate call
      expect(embedding.generateForRecall).toHaveBeenCalledTimes(1);
    });

    it('should not surface insights when requested layers exclude INSIGHT', async () => {
      const identityMemory = {
        id: 'm1',
        raw: 'identity memory',
        layer: 'IDENTITY',
        effectiveScore: 0.8,
        extraction: {},
      };

      prisma.memory.findMany = jest.fn().mockImplementation((args: any) => {
        if (args?.where?.layer === 'INSIGHT') {
          return Promise.resolve([
            {
              id: 'insight-1',
              raw: 'should not leak in',
              layer: 'INSIGHT',
              importanceScore: 0.9,
              effectiveScore: 0.9,
              createdAt: new Date(),
              extraction: {},
            },
          ]);
        }
        return Promise.resolve([identityMemory]);
      });

      embedding.search.mockResolvedValueOnce([{ id: 'm1', score: 0.9 }] as any);

      const result = await service.recall(userId, {
        query: 'who am i',
        layers: ['IDENTITY'],
      } as any);

      expect(result.memories.map((m) => m.id)).toEqual(['m1']);
      expect(embedding.search).toHaveBeenCalledTimes(1);
      expect(prisma.memory.findMany).toHaveBeenCalledTimes(1);
    });

    it('should apply recall filters to surfaced insight lookup', async () => {
      const insightMemory = {
        id: 'insight-1',
        raw: 'scoped insight',
        layer: 'INSIGHT',
        importanceScore: 0.8,
        effectiveScore: 0.8,
        createdAt: new Date(),
        extraction: {},
      };

      prisma.memory.findMany = jest.fn().mockImplementation((args: any) => {
        if (args?.where?.layer === 'INSIGHT') {
          return Promise.resolve([insightMemory]);
        }
        return Promise.resolve([
          { id: 'm1', raw: 'memory 1', effectiveScore: 0.8, extraction: {} },
        ]);
      });

      embedding.search
        .mockResolvedValueOnce([{ id: 'm1', score: 0.9 }])
        .mockResolvedValueOnce([{ id: 'insight-1', score: 0.5 }]);

      await service.recall(userId, {
        query: 'test query',
        layers: ['INSIGHT', 'IDENTITY'],
        sessionId: 'session-X',
        visibility: ['TEAM'],
        filterAgentId: 'agent-7',
      } as any);

      const insightCall = (prisma.memory.findMany as jest.Mock).mock.calls.find(
        ([args]) => args?.where?.layer === 'INSIGHT',
      )?.[0];

      expect(insightCall).toBeDefined();
      expect(insightCall.where).toMatchObject({
        layer: 'INSIGHT',
        sessionId: 'session-X',
        visibility: { in: ['TEAM'] },
        agentId: 'agent-7',
      });
    });
  });

  describe('recall with multiQuery', () => {
    it('should use multi-query path when enabled', async () => {
      multiQueryService.isEnabled.mockReturnValue(true);
      multiQueryService.search.mockResolvedValue({
        results: [{ memoryId: 'm1', score: 0.9 }],
        metadata: {},
      } as any);

      prisma.memory.findMany = jest
        .fn()
        .mockResolvedValue([
          { id: 'm1', raw: 'test', effectiveScore: 0.5, extraction: {} },
        ]);

      const result = await service.recall(userId, {
        query: 'complex query',
      } as any);
      expect(result.memories).toHaveLength(1);
      expect(multiQueryService.search).toHaveBeenCalled();
    });

    it('should fall back to standard when temporal intent + multiQuery', async () => {
      multiQueryService.isEnabled.mockReturnValue(true);
      temporalParser.parse.mockReturnValue({
        semanticQuery: 'meeting',
        temporalFilter: {
          expression: 'yesterday',
          start: new Date('2026-02-14'),
          end: new Date('2026-02-15'),
        },
      } as any);

      embedding.search.mockResolvedValue([]);
      prisma.memory.findMany = jest.fn().mockResolvedValue([]);

      await service.recall(userId, { query: 'yesterday meeting' } as any);
      // Should NOT use multiQuery for temporal queries
      expect(multiQueryService.search).not.toHaveBeenCalled();
    });
  });

  // HEY-575 regression: adaptive expansion must not widen end past original filter boundary
  // ── HEY-578: sessionId filter ─────────────────────────────────────────────

  describe('buildSessionIdFilter (HEY-578)', () => {
    it('returns empty object when sessionId is not provided', () => {
      expect(service.buildSessionIdFilter({} as any)).toEqual({});
    });

    it('returns sessionId clause when provided', () => {
      expect(
        service.buildSessionIdFilter({ sessionId: 'sess-xyz' } as any),
      ).toEqual({ sessionId: 'sess-xyz' });
    });
  });

  describe('recall — sessionId filter (HEY-578)', () => {
    it('positive filter: passes sessionId into Prisma where clause', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.9 }] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([]);

      await service.recall(userId, {
        query: 'test',
        sessionId: 'session-X',
      } as any);

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ sessionId: 'session-X' }),
        }),
      );
    });

    it('session isolation: sessionId=X Prisma where clause excludes sessionId=Y at DB level', async () => {
      // We verify the WHERE clause is correctly composed — Prisma enforces isolation at the DB.
      // A contract test: confirm sessionId is in the where clause so the DB rejects other sessions.
      embedding.search.mockResolvedValue([
        { id: 'mem-x', score: 0.9 },
        { id: 'mem-y', score: 0.85 },
      ] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([]);

      await service.recall(userId, {
        query: 'test',
        sessionId: 'session-X',
      } as any);

      // Every candidate-fetching findMany call must carry sessionId=session-X
      const candidateCalls = (
        prisma.memory.findMany as jest.Mock
      ).mock.calls.filter(
        (c: any[]) =>
          c[0]?.where?.id !== undefined || c[0]?.where?.sessionId !== undefined,
      );
      expect(candidateCalls.length).toBeGreaterThan(0);
      const firstCandidateCall = (prisma.memory.findMany as jest.Mock).mock
        .calls[0];
      expect(firstCandidateCall[0].where).toMatchObject({
        sessionId: 'session-X',
      });
    });

    it('cross-tenant isolation: sessionId filter composes with userId in embedding.search (tenant scoping preserved)', async () => {
      // In the standard path, userId is passed to embedding.search (tenant isolation).
      // sessionId filter is applied additively in the Prisma where clause (session isolation).
      // Both must be present for correct cross-tenant + cross-session isolation.
      embedding.search.mockResolvedValue([]);
      prisma.memory.findMany = jest.fn().mockResolvedValue([]);

      await service.recall('tenant-A', {
        query: 'test',
        sessionId: 'session-X',
      } as any);

      // userId reaches embedding.search (tenant isolation)
      const searchCall = (embedding.search as jest.Mock).mock.calls[0];
      expect(searchCall[0]).toBe('tenant-A');

      // sessionId reaches prisma.memory.findMany (session filter)
      const call = (prisma.memory.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where).toMatchObject({ sessionId: 'session-X' });
    });

    it('no regression: omitting sessionId leaves no sessionId key in where clause', async () => {
      embedding.search.mockResolvedValue([]);
      prisma.memory.findMany = jest.fn().mockResolvedValue([]);

      await service.recall(userId, { query: 'test' } as any);

      const call = (prisma.memory.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where).not.toHaveProperty('sessionId');
    });
  });

  // ── HEY-575 regression ───────────────────────────────────────────────────

  describe('temporal adaptive expansion — end boundary (HEY-575)', () => {
    const twoYearsAgo = new Date('2024-01-01T00:00:00.000Z');
    const oneYearAgo = new Date('2025-01-01T00:00:00.000Z');

    beforeEach(() => {
      // "years ago" filter: start=2yrs, end=1yr. expandWindow doubles symmetrically,
      // pushing end past now after just one pass.
      temporalParser.parse.mockReturnValue({
        semanticQuery: 'standup notes',
        temporalFilter: {
          expression: 'years ago',
          start: twoYearsAgo,
          end: oneYearAgo,
          confidence: 0.7,
        },
      } as any);

      embedding.search.mockResolvedValue([]);
    });

    it('should never query memories newer than the original filter end during expansion', async () => {
      // First call returns 0 memories → triggers adaptive expansion.
      // Second call returns enough memories → stops.
      prisma.memory.findMany = jest
        .fn()
        .mockResolvedValueOnce([]) // pass 0: no results, triggers expansion
        .mockResolvedValue([
          {
            id: 'old-mem-1',
            raw: 'standup 2 years ago',
            effectiveScore: 0.4,
            createdAt: new Date('2024-06-01'),
            extraction: {},
          },
          {
            id: 'old-mem-2',
            raw: 'standup 2 years ago',
            effectiveScore: 0.4,
            createdAt: new Date('2024-06-02'),
            extraction: {},
          },
          {
            id: 'old-mem-3',
            raw: 'standup 2 years ago',
            effectiveScore: 0.4,
            createdAt: new Date('2024-06-03'),
            extraction: {},
          },
          {
            id: 'old-mem-4',
            raw: 'standup 2 years ago',
            effectiveScore: 0.4,
            createdAt: new Date('2024-06-04'),
            extraction: {},
          },
          {
            id: 'old-mem-5',
            raw: 'standup 2 years ago',
            effectiveScore: 0.4,
            createdAt: new Date('2024-06-05'),
            extraction: {},
          },
        ]);

      await service.recall(userId, {
        query: 'standup notes from years ago',
      } as any);

      const allCalls = (prisma.memory.findMany as jest.Mock).mock.calls;
      // Every findMany call must have lte <= originalFilterEnd (oneYearAgo)
      for (const [args] of allCalls) {
        if (args?.where?.createdAt?.lte) {
          expect(args.where.createdAt.lte.getTime()).toBeLessThanOrEqual(
            oneYearAgo.getTime(),
          );
        }
      }
    });

    it('should not return today-anchored memories when query is "years ago"', async () => {
      const todayMemory = {
        id: 'today-mem-1',
        raw: 'standup today',
        effectiveScore: 0.8,
        createdAt: new Date(), // now
        extraction: {},
      };

      // Simulate expansion eventually returning a today-anchored memory if
      // the end clamp is missing — the fix should prevent this being queried.
      prisma.memory.findMany = jest.fn().mockResolvedValue([todayMemory]);

      await service.recall(userId, {
        query: 'standup notes from years ago',
      } as any);

      const allCalls = (prisma.memory.findMany as jest.Mock).mock.calls;
      // The lte on every call must never be past the original end boundary
      for (const [args] of allCalls) {
        if (args?.where?.createdAt?.lte) {
          expect(args.where.createdAt.lte.getTime()).toBeLessThanOrEqual(
            oneYearAgo.getTime(),
          );
        }
      }
    });
  });
});
