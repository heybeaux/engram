import { MemoryQueryRankingService } from './memory-query-ranking.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { RecallWeightService } from './recall-weight.service';
import { RerankService } from '../embedding/rerank.service';
import { GraphRecallService } from './graph-recall.service';
import { MemoryWithScore } from './memory.types';

describe('MemoryQueryRankingService', () => {
  let service: MemoryQueryRankingService;
  let prisma: jest.Mocked<PrismaService>;
  let embedding: jest.Mocked<EmbeddingService>;
  let recallWeightService: jest.Mocked<RecallWeightService>;

  beforeEach(() => {
    prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;

    embedding = {
      generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      search: jest.fn().mockResolvedValue([]),
    } as any;

    recallWeightService = {
      recallWeight: jest.fn().mockReturnValue(1.0),
      applyUsageWeighting: jest
        .fn()
        .mockImplementation((mems: any[]) => Promise.resolve(mems)),
    } as any;

    service = new MemoryQueryRankingService(
      prisma,
      embedding,
      recallWeightService,
    );
  });

  describe('getImportanceMultiplier', () => {
    it('should penalize low-importance memories (< 0.35)', () => {
      const mem = { importanceScore: 0.3 } as any;
      expect(service.getImportanceMultiplier(mem)).toBe(0.4);
    });

    it('should leave normal-importance memories neutral', () => {
      const mem = { importanceScore: 0.5 } as any;
      expect(service.getImportanceMultiplier(mem)).toBe(1.0);
    });

    it('should leave high-importance memories neutral', () => {
      const mem = { importanceScore: 0.9 } as any;
      expect(service.getImportanceMultiplier(mem)).toBe(1.0);
    });

    it('should default to 0.5 when importanceScore is missing', () => {
      const mem = {} as any;
      expect(service.getImportanceMultiplier(mem)).toBe(1.0);
    });
  });

  describe('applyUsageWeighting', () => {
    it('should delegate to RecallWeightService', async () => {
      const memories: MemoryWithScore[] = [
        { id: 'm1', raw: 'test', score: 0.9 } as any,
      ];

      const result = await service.applyUsageWeighting(memories);
      expect(recallWeightService.applyUsageWeighting).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });
  });

  describe('mergeGraphResults', () => {
    it('should return unchanged results when no graphRecallService', async () => {
      const memories: MemoryWithScore[] = [
        { id: 'm1', raw: 'test', score: 0.9 } as any,
      ];

      const result = await service.mergeGraphResults(
        memories,
        'query',
        'user-1',
        10,
      );
      expect(result).toEqual(memories);
    });

    it('should boost memories appearing in both vector and graph results', async () => {
      const mockGraphRecallService = {
        recallViaGraph: jest
          .fn()
          .mockResolvedValue([{ id: 'm1', raw: 'test', score: 0.8 }]),
      } as unknown as GraphRecallService;

      const svc = new MemoryQueryRankingService(
        prisma,
        embedding,
        recallWeightService,
        undefined,
        mockGraphRecallService,
      );

      const memories: MemoryWithScore[] = [
        { id: 'm1', raw: 'test', score: 0.9 } as any,
      ];

      const result = await svc.mergeGraphResults(
        memories,
        'query',
        'user-1',
        10,
      );
      // Score should be boosted by 1.2x
      expect(result[0].score).toBeCloseTo(0.9 * 1.2);
    });

    it('should add new graph-only memories to results', async () => {
      const mockGraphRecallService = {
        recallViaGraph: jest
          .fn()
          .mockResolvedValue([{ id: 'm2', raw: 'graph only', score: 0.7 }]),
      } as unknown as GraphRecallService;

      const svc = new MemoryQueryRankingService(
        prisma,
        embedding,
        recallWeightService,
        undefined,
        mockGraphRecallService,
      );

      const memories: MemoryWithScore[] = [
        { id: 'm1', raw: 'test', score: 0.9 } as any,
      ];

      const result = await svc.mergeGraphResults(
        memories,
        'query',
        'user-1',
        10,
      );
      expect(result).toHaveLength(2);
    });
  });

  describe('surfaceInsights', () => {
    it('should return unchanged results when no insights found', async () => {
      prisma.memory.findMany = jest.fn().mockResolvedValue([]);

      const memories: MemoryWithScore[] = [
        { id: 'm1', raw: 'test', score: 0.9 } as any,
      ];

      const result = await service.surfaceInsights(
        memories,
        ['user-1'],
        'query',
        10,
      );
      expect(result).toEqual(memories);
    });

    it('should merge relevant insights into results', async () => {
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

      prisma.memory.findMany = jest.fn().mockResolvedValue([insightMemory]);
      embedding.search.mockResolvedValue([
        { id: 'insight-1', score: 0.5 },
      ] as any);

      const memories: MemoryWithScore[] = [
        { id: 'm1', raw: 'test', score: 0.9 } as any,
      ];

      const result = await service.surfaceInsights(
        memories,
        ['user-1'],
        'query',
        10,
        [0.1, 0.2, 0.3],
      );
      expect(result.length).toBeGreaterThan(memories.length);
    });

    it('should not surface insights below similarity threshold', async () => {
      const insightMemory = {
        id: 'insight-1',
        raw: 'irrelevant insight',
        layer: 'INSIGHT',
        importanceScore: 0.8,
        createdAt: new Date(),
        extraction: {},
        deletedAt: null,
      };

      prisma.memory.findMany = jest.fn().mockResolvedValue([insightMemory]);
      // Below 0.3 similarity threshold
      embedding.search.mockResolvedValue([
        { id: 'insight-1', score: 0.2 },
      ] as any);

      const memories: MemoryWithScore[] = [
        { id: 'm1', raw: 'test', score: 0.9 } as any,
      ];

      const result = await service.surfaceInsights(
        memories,
        ['user-1'],
        'query',
        10,
        [0.1, 0.2, 0.3],
      );
      expect(result).toEqual(memories);
    });
  });

  describe('applyReranking', () => {
    it('should apply fallback blend when no rerank service', async () => {
      const memories: MemoryWithScore[] = [
        {
          id: 'm1',
          raw: 'test memory',
          score: 0.9,
          importanceScore: 0.5,
          effectiveScore: 0.5,
        } as any,
      ];

      const result = await service.applyReranking(memories, 'query', 10);
      expect(result).toHaveLength(1);
      expect(result[0].score).toBeDefined();
    });

    it('should return empty for empty input', async () => {
      const result = await service.applyReranking([], 'query', 10);
      expect(result).toEqual([]);
    });

    it('should use cross-encoder when available', async () => {
      const mockRerankService = {
        rerank: jest.fn().mockResolvedValue([{ index: 0, score: 0.95 }]),
      } as unknown as RerankService;

      const svc = new MemoryQueryRankingService(
        prisma,
        embedding,
        recallWeightService,
        mockRerankService,
      );

      const memories: MemoryWithScore[] = [
        {
          id: 'm1',
          raw: 'test',
          score: 0.9,
          importanceScore: 0.5,
          effectiveScore: 0.5,
        } as any,
      ];

      const result = await svc.applyReranking(memories, 'query', 10);
      expect(mockRerankService.rerank).toHaveBeenCalledWith('query', ['test']);
      expect(result).toHaveLength(1);
    });

    it('should fall back on reranker failure', async () => {
      const mockRerankService = {
        rerank: jest.fn().mockRejectedValue(new Error('timeout')),
      } as unknown as RerankService;

      const svc = new MemoryQueryRankingService(
        prisma,
        embedding,
        recallWeightService,
        mockRerankService,
      );

      const memories: MemoryWithScore[] = [
        {
          id: 'm1',
          raw: 'test',
          score: 0.9,
          importanceScore: 0.5,
          effectiveScore: 0.5,
        } as any,
      ];

      const result = await svc.applyReranking(memories, 'query', 10);
      expect(result).toHaveLength(1);
    });
  });
});
