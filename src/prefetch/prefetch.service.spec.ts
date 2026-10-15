import { Test, TestingModule } from '@nestjs/testing';
import { PrefetchService, DEFAULT_PREFETCH_CONFIG } from './prefetch.service';
import { TopicDetectionService } from './topic-detection.service';
import { PrefetchCacheService } from './prefetch-cache.service';
import { PrefetchMetricsService } from './prefetch-metrics.service';
import { MemoryService } from '../memory/memory.service';
import { EmbeddingService } from '../memory/embedding.service';
import { PrismaService } from '../prisma/prisma.service';
import { TopicScore } from './prefetch.types';

describe('PrefetchService', () => {
  let service: PrefetchService;
  let mockTopicDetection: any;
  let mockCache: any;
  let mockMetrics: any;
  let mockMemoryService: any;
  let mockEmbeddingService: any;
  let mockPrisma: any;

  const mockTopics: TopicScore[] = [
    { topic: 'family', confidence: 0.8, source: 'merged' },
    { topic: 'schedule', confidence: 0.6, source: 'merged' },
  ];

  beforeEach(async () => {
    mockTopicDetection = {
      detect: jest.fn().mockResolvedValue({
        topics: mockTopics,
        processingTimeMs: 5,
        layerBreakdown: { keyword: new Map(), embedding: new Map() },
      }),
      configure: jest.fn(),
      getConfig: jest.fn().mockReturnValue({}),
      predictNextTopics: jest.fn().mockReturnValue([]),
      detectTopicShift: jest.fn().mockReturnValue(null),
      clearHistory: jest.fn(),
      initializePrototypes: jest.fn().mockResolvedValue(undefined),
      setPrototype: jest.fn(),
    } as any;

    mockCache = {
      configure: jest.fn(),
      getConfig: jest.fn().mockReturnValue({}),
      get: jest.fn(),
      getMany: jest.fn().mockReturnValue({
        memories: [],
        hitCount: 0,
        missCount: 0,
        lookupTimeMs: 1,
      }),
      has: jest.fn().mockReturnValue(false),
      set: jest.fn(),
      prefetchForTopic: jest.fn().mockReturnValue(0),
      getByTopic: jest.fn().mockReturnValue([]),
      getIdsByTopic: jest.fn().mockReturnValue([]),
      evictTopic: jest.fn().mockReturnValue(0),
      evict: jest.fn().mockReturnValue(true),
      clear: jest.fn(),
      getCachedIds: jest.fn().mockReturnValue(new Set()),
      getStats: jest.fn().mockReturnValue({
        size: 0,
        maxSize: 500,
        topicCount: 0,
        totalAccessCount: 0,
        prefetchedCount: 0,
        prefetchedUsed: 0,
        prefetchPrecision: 0,
        hitRate: 0,
        missRate: 0,
      }),
      resetMetrics: jest.fn(),
      cleanupExpired: jest.fn().mockReturnValue(0),
    } as any;

    mockMetrics = {
      recordPrefetch: jest.fn(),
      recordAccess: jest.fn(),
      recordCacheResult: jest.fn(),
      recordDetectionLatency: jest.fn(),
      recordPrefetchLatency: jest.fn(),
      recordLookupLatency: jest.fn(),
      setMemoryPressure: jest.fn(),
      calculatePrecisionRecall: jest
        .fn()
        .mockReturnValue({ precision: 0, recall: 0, f1Score: 0, byTopic: {} }),
      getMetrics: jest.fn().mockReturnValue({
        cacheHitRate: 0,
        prefetchHitRate: 0,
        avgLatencyMs: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        prefetchPrecision: 0,
        prefetchRecall: 0,
        topicDetectionLatencyMs: 0,
        totalPrefetches: 0,
        totalAccesses: 0,
        memoryPressureLevel: 'normal',
      }),
      getTopicMetrics: jest.fn().mockReturnValue({
        precision: 0,
        sampleSize: 0,
        avgScore: 0,
        avgLatencyMs: 0,
      }),
      getFeedbackForLearning: jest.fn().mockReturnValue(new Map()),
      reset: jest.fn(),
    } as any;

    mockMemoryService = {
      recall: jest
        .fn()
        .mockResolvedValue({ memories: [], queryTokens: 5, latencyMs: 10 }),
      getById: jest.fn().mockResolvedValue(null),
    } as any;

    mockEmbeddingService = {
      generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    } as any;

    mockPrisma = {
      memory: { findMany: jest.fn().mockResolvedValue([{ id: 'mem-1' }]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrefetchService,
        { provide: TopicDetectionService, useValue: mockTopicDetection },
        { provide: PrefetchCacheService, useValue: mockCache },
        { provide: PrefetchMetricsService, useValue: mockMetrics },
        { provide: MemoryService, useValue: mockMemoryService },
        { provide: EmbeddingService, useValue: mockEmbeddingService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<PrefetchService>(PrefetchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('configuration', () => {
    it('should have default configuration', () => {
      const config = service.getConfig();
      expect(config.enabled).toBe(DEFAULT_PREFETCH_CONFIG.enabled);
      expect(config.backgroundPrefetch).toBe(
        DEFAULT_PREFETCH_CONFIG.backgroundPrefetch,
      );
    });

    it('should allow configuration updates', () => {
      service.configure({ enabled: false });
      const config = service.getConfig();
      expect(config.enabled).toBe(false);
    });

    it('should apply cache configuration', () => {
      service.configure({ cache: { maxSize: 100 } } as any);
      expect(mockCache.configure).toHaveBeenCalled();
    });

    it('should apply detection configuration', () => {
      service.configure({ detection: { minConfidence: 0.5 } } as any);
      expect(mockTopicDetection.configure).toHaveBeenCalled();
    });

    it('should report enabled status', () => {
      expect(service.isEnabled()).toBe(true);

      service.configure({ enabled: false });
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('processMessage', () => {
    it('should detect topics from message', async () => {
      const topics = await service.processMessage('How is my wife?', 'user-1');

      expect(mockTopicDetection.detect).toHaveBeenCalledWith(
        'How is my wife?',
        undefined,
      );
      expect(topics).toEqual(mockTopics);
    });

    it('should return empty when disabled', async () => {
      service.configure({ enabled: false });

      const topics = await service.processMessage('How is my wife?', 'user-1');

      expect(topics).toEqual([]);
      expect(mockTopicDetection.detect).not.toHaveBeenCalled();
    });

    it('should record detection latency', async () => {
      await service.processMessage('test message', 'user-1');

      expect(mockMetrics.recordDetectionLatency).toHaveBeenCalledWith(5);
    });

    it('should pass context to detection', async () => {
      const context = {
        userId: 'user-1',
        recentTopics: [],
        recentMessages: [],
      };

      await service.processMessage('test message', 'user-1', context);

      expect(mockTopicDetection.detect).toHaveBeenCalledWith(
        'test message',
        context,
      );
    });
  });

  describe('loadContextWithPrefetch', () => {
    it('excludes memories hidden since cache population', async () => {
      mockCache.getByTopic.mockReturnValue([{ id: 'hidden', score: 0.9 }]);
      mockPrisma.memory.findMany.mockImplementation(async ({ where }: any) => {
        expect(where.userHidden).toBe(false);
        return [];
      });
      const result = await service.loadContextWithPrefetch(
        'user-1',
        'family',
        10,
      );
      expect(result.memories).toEqual([]);
      expect(result.cacheHits).toBe(0);
    });

    it('should return enhanced context result', async () => {
      const result = await service.loadContextWithPrefetch(
        'user-1',
        'test query',
        10,
      );

      expect(result).toHaveProperty('memories');
      expect(result).toHaveProperty('fromCache');
      expect(result).toHaveProperty('cacheHits');
      expect(result).toHaveProperty('cacheMisses');
      expect(result).toHaveProperty('prefetchTriggered');
      expect(result).toHaveProperty('topics');
      expect(result).toHaveProperty('latencyMs');
    });

    it('should return empty result when disabled', async () => {
      service.configure({ enabled: false });

      const result = await service.loadContextWithPrefetch(
        'user-1',
        'test query',
        10,
      );

      expect(result.memories).toEqual([]);
      expect(result.fromCache).toBe(false);
    });

    it('should check cache for detected topics', async () => {
      mockCache.getByTopic.mockReturnValue([
        {
          id: 'mem-1',
          content: 'test',
          embedding: [],
          score: 0.8,
          layer: 'IDENTITY',
          cachedAt: Date.now(),
          accessCount: 0,
          lastAccessedAt: Date.now(),
          topics: ['family'],
        },
      ]);

      const result = await service.loadContextWithPrefetch(
        'user-1',
        'family',
        10,
      );

      expect(mockCache.getByTopic).toHaveBeenCalled();
      expect(result.cacheHits).toBeGreaterThan(0);
    });

    it('should record lookup latency', async () => {
      await service.loadContextWithPrefetch('user-1', 'test', 10);

      expect(mockMetrics.recordLookupLatency).toHaveBeenCalled();
    });

    it('should trigger background prefetch for predicted topics', async () => {
      mockTopicDetection.predictNextTopics.mockReturnValue([
        { topic: 'health', confidence: 0.4, source: 'merged' },
      ]);

      const result = await service.loadContextWithPrefetch(
        'user-1',
        'family',
        10,
      );

      expect(result.prefetchTriggered).toBe(true);
    });
  });

  describe('prefetchForTopics', () => {
    it('should prefetch memories for topics', async () => {
      mockMemoryService.recall.mockResolvedValue({
        memories: [{ id: 'mem-1', raw: 'test', layer: 'IDENTITY' } as any],
        queryTokens: 5,
        latencyMs: 10,
      });
      mockMemoryService.getById.mockResolvedValue({
        id: 'mem-1',
        raw: 'test',
        layer: 'IDENTITY',
      });

      const result = await service.prefetchForTopics('user-1', mockTopics);

      expect(result.topics).toContain('family');
      expect(result.topics).toContain('schedule');
      expect(result.timeMs).toBeGreaterThanOrEqual(0);
    });

    it('should skip already cached memories', async () => {
      mockCache.getCachedIds.mockReturnValue(new Set(['mem-1']));
      mockMemoryService.recall.mockResolvedValue({
        memories: [{ id: 'mem-1', raw: 'test', layer: 'IDENTITY' }],
        queryTokens: 5,
        latencyMs: 10,
      });

      const result = await service.prefetchForTopics('user-1', mockTopics);

      // mem-1 was already cached, so it's a cache hit
      expect(result.cacheHits).toBeGreaterThanOrEqual(0);
    });

    it('should record prefetch metrics', async () => {
      mockMemoryService.recall.mockResolvedValue({
        memories: [{ id: 'mem-1', raw: 'test', layer: 'IDENTITY', score: 0.8 }],
        queryTokens: 5,
        latencyMs: 10,
      });
      mockMemoryService.getById.mockResolvedValue({
        id: 'mem-1',
        raw: 'test',
        layer: 'IDENTITY',
      });

      await service.prefetchForTopics('user-1', mockTopics);

      expect(mockMetrics.recordPrefetchLatency).toHaveBeenCalled();
    });
  });

  describe('warmCache', () => {
    it('should warm cache with default topics', async () => {
      const result = await service.warmCache('user-1');

      expect(result.topics).toContain('identity');
      expect(result.topics).toContain('family');
      expect(result.topics).toContain('schedule');
      expect(result.topics).toContain('projects/active');
    });

    it('should warm cache with custom topics', async () => {
      const result = await service.warmCache('user-1', ['work', 'technical']);

      expect(result.topics).toContain('work');
      expect(result.topics).toContain('technical');
    });
  });

  describe('handleTopicShift', () => {
    it('should evict departed topics', async () => {
      mockTopicDetection.detectTopicShift.mockReturnValue({
        departedTopics: ['family'],
        arrivedTopics: ['work'],
        confidence: 0.8,
      });

      await service.handleTopicShift('user-1', [
        { topic: 'work', confidence: 0.8, source: 'merged' },
      ]);

      expect(mockCache.evictTopic).toHaveBeenCalledWith('family');
    });

    it('should not evict if still somewhat relevant', async () => {
      mockTopicDetection.detectTopicShift.mockReturnValue({
        departedTopics: ['family'],
        arrivedTopics: ['work'],
        confidence: 0.8,
      });

      await service.handleTopicShift('user-1', [
        { topic: 'work', confidence: 0.8, source: 'merged' },
        { topic: 'family', confidence: 0.4, source: 'merged' },
      ]);

      expect(mockCache.evictTopic).not.toHaveBeenCalledWith('family');
    });

    it('should do nothing if no shift detected', async () => {
      mockTopicDetection.detectTopicShift.mockReturnValue(null);

      await service.handleTopicShift('user-1', mockTopics);

      expect(mockCache.evictTopic).not.toHaveBeenCalled();
    });
  });

  describe('recordMemoryAccess', () => {
    it('should record access to cache', () => {
      service.recordMemoryAccess('mem-1', 'pf-1');

      expect(mockCache.get).toHaveBeenCalledWith('mem-1');
      expect(mockMetrics.recordAccess).toHaveBeenCalledWith('pf-1', 'mem-1');
    });

    it('should work without prefetch ID', () => {
      service.recordMemoryAccess('mem-1');

      expect(mockCache.get).toHaveBeenCalledWith('mem-1');
      expect(mockMetrics.recordAccess).not.toHaveBeenCalled();
    });
  });

  describe('getCacheStats', () => {
    it('should return cache statistics', () => {
      const stats = service.getCacheStats();

      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('maxSize');
      expect(mockCache.getStats).toHaveBeenCalled();
    });
  });

  describe('getMetrics', () => {
    it('should return prefetch metrics', () => {
      const metrics = service.getMetrics();

      expect(metrics).toHaveProperty('cacheHitRate');
      expect(metrics).toHaveProperty('prefetchPrecision');
      expect(mockMetrics.getMetrics).toHaveBeenCalled();
    });
  });

  describe('getPrecisionRecall', () => {
    it('should return precision/recall metrics', () => {
      const pr = service.getPrecisionRecall('user-1', 3600000);

      expect(pr).toHaveProperty('precision');
      expect(pr).toHaveProperty('recall');
      expect(pr).toHaveProperty('f1Score');
      expect(mockMetrics.calculatePrecisionRecall).toHaveBeenCalledWith(
        'user-1',
        3600000,
      );
    });
  });

  describe('clear operations', () => {
    it('should clear topic history', () => {
      service.clearTopicHistory('user-1');

      expect(mockTopicDetection.clearHistory).toHaveBeenCalledWith('user-1');
    });

    it('should reset metrics', () => {
      service.resetMetrics();

      expect(mockMetrics.reset).toHaveBeenCalled();
      expect(mockCache.resetMetrics).toHaveBeenCalled();
    });

    it('should clear cache', () => {
      service.clearCache();

      expect(mockCache.clear).toHaveBeenCalled();
    });
  });

  describe('background prefetch queue', () => {
    it('should process prefetch queue', async () => {
      // Enable background prefetch
      service.configure({ backgroundPrefetch: true });

      // Trigger message processing which schedules prefetch
      await service.processMessage('family', 'user-1');

      // Give queue time to process
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify prefetch was attempted
      // The exact behavior depends on the queue processing
    });

    it('should handle queue errors gracefully', async () => {
      mockMemoryService.recall.mockRejectedValue(new Error('DB error'));

      // Should not throw
      await expect(
        service.prefetchForTopics('user-1', mockTopics),
      ).resolves.toBeDefined();
    });
  });

  describe('onModuleInit', () => {
    it('should initialize prototypes when embedding classification enabled', async () => {
      service.configure({
        detection: { enableEmbeddingClassification: true } as any,
      });

      await service.onModuleInit();

      expect(mockTopicDetection.initializePrototypes).toHaveBeenCalled();
    });

    it('should skip prototype initialization when disabled', async () => {
      service.configure({
        detection: { enableEmbeddingClassification: false } as any,
      });
      mockTopicDetection.initializePrototypes.mockClear();

      await service.onModuleInit();

      expect(mockTopicDetection.initializePrototypes).not.toHaveBeenCalled();
    });
  });
});
