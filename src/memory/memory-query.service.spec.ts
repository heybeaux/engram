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
      search: jest.fn().mockResolvedValue([]),
    } as any;

    temporalParser = {
      parse: jest.fn().mockReturnValue({
        semanticQuery: 'test query',
        temporalFilter: null,
      }),
      calculateTemporalRelevance: jest.fn().mockReturnValue(0.8),
      blendScores: jest.fn().mockReturnValue(0.7),
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
      expect(embedding.generate).toHaveBeenCalledWith('test query');
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
      expect(embedding.generate).toHaveBeenCalledTimes(1);
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
      expect(embedding.generate).toHaveBeenCalledTimes(1);
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
});
