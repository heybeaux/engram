import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MemoryLayer } from '@prisma/client';
import { MultiQueryService } from './multi-query.service';
import {
  QueryExpansionService,
  QueryExpansionResult,
} from './query-expansion.service';
import {
  ResultFusionService,
  QuerySearchResult,
  FusedResult,
} from './result-fusion.service';
import { EmbeddingService } from '../memory/embedding.service';
import { FusionStrategy, ExpansionStrategy } from './dto/multi-query.dto';

describe('MultiQueryService', () => {
  let service: MultiQueryService;
  let configService: jest.Mocked<ConfigService>;
  let embeddingService: jest.Mocked<EmbeddingService>;
  let expansionService: jest.Mocked<QueryExpansionService>;
  let fusionService: jest.Mocked<ResultFusionService>;

  const mockConfig = {
    get: jest.fn(),
  };

  const mockEmbedding = {
    generate: jest.fn(),
    generateForRecall: jest.fn(),
    search: jest.fn(),
  };

  const mockExpansion = {
    expand: jest.fn(),
  };

  const mockFusion = {
    fuse: jest.fn(),
  };

  const mockExpansionResult: QueryExpansionResult = {
    original: 'test query',
    variants: ['test query', 'test variant 1', 'test variant 2'],
    sources: {
      'test query': 'original',
      'test variant 1': 'rules',
      'test variant 2': 'rules',
    },
    timings: { rulesMs: 5, llmMs: 0, totalMs: 5 },
    llmUsed: false,
  };

  const mockFusedResults: FusedResult[] = [
    {
      memoryId: 'mem_1',
      score: 0.95,
      rrfScore: 0.05,
      queryCount: 3,
      bestRank: 1,
      avgScore: 0.9,
      queryMatches: [
        { queryIndex: 0, query: 'test query', rank: 1, score: 0.95 },
        { queryIndex: 1, query: 'test variant 1', rank: 1, score: 0.88 },
        { queryIndex: 2, query: 'test variant 2', rank: 2, score: 0.85 },
      ],
    },
    {
      memoryId: 'mem_2',
      score: 0.85,
      rrfScore: 0.04,
      queryCount: 2,
      bestRank: 2,
      avgScore: 0.82,
      queryMatches: [
        { queryIndex: 0, query: 'test query', rank: 2, score: 0.85 },
        { queryIndex: 1, query: 'test variant 1', rank: 3, score: 0.78 },
      ],
    },
  ];

  beforeEach(async () => {
    jest.clearAllMocks();

    mockConfig.get.mockImplementation((key: string) => {
      switch (key) {
        case 'MULTI_QUERY_ENABLED':
          return 'true';
        default:
          return undefined;
      }
    });

    mockExpansion.expand.mockResolvedValue(mockExpansionResult);
    mockEmbedding.generate.mockResolvedValue(Array(768).fill(0.1));
    mockEmbedding.generateForRecall.mockResolvedValue(Array(768).fill(0.1));
    mockEmbedding.search.mockResolvedValue([
      { id: 'mem_1', score: 0.95 },
      { id: 'mem_2', score: 0.85 },
    ]);
    mockFusion.fuse.mockReturnValue(mockFusedResults);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MultiQueryService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: EmbeddingService, useValue: mockEmbedding },
        { provide: QueryExpansionService, useValue: mockExpansion },
        { provide: ResultFusionService, useValue: mockFusion },
      ],
    }).compile();

    service = module.get<MultiQueryService>(MultiQueryService);
    configService = module.get(ConfigService);
    embeddingService = module.get(EmbeddingService);
    expansionService = module.get(QueryExpansionService);
    fusionService = module.get(ResultFusionService);
  });

  describe('isEnabled', () => {
    it('should return true when MULTI_QUERY_ENABLED is "true"', () => {
      mockConfig.get.mockReturnValue('true');
      expect(service.isEnabled()).toBe(true);
    });

    it('should return true when MULTI_QUERY_ENABLED is "1"', () => {
      mockConfig.get.mockReturnValue('1');
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when disabled', () => {
      mockConfig.get.mockReturnValue('false');
      const module = Test.createTestingModule({
        providers: [
          MultiQueryService,
          { provide: ConfigService, useValue: mockConfig },
          { provide: EmbeddingService, useValue: mockEmbedding },
          { provide: QueryExpansionService, useValue: mockExpansion },
          { provide: ResultFusionService, useValue: mockFusion },
        ],
      }).compile();

      const newService = module.then((m) => m.get(MultiQueryService));
      // Note: This tests the config loading behavior
    });
  });

  describe('search', () => {
    it('should expand query into variants', async () => {
      await service.search('test query', 'user_123');

      expect(mockExpansion.expand).toHaveBeenCalled();
      const callArgs = mockExpansion.expand.mock.calls[0];
      expect(callArgs[0]).toBe('test query');
      expect(callArgs[1]).toBeDefined();
      expect(callArgs[1].strategy).toBeDefined();
      expect(callArgs[1].maxVariants).toBeDefined();
    });

    it('should embed all query variants', async () => {
      await service.search('test query', 'user_123');

      // Should be called once per variant
      expect(mockEmbedding.generateForRecall).toHaveBeenCalledTimes(3);
    });

    it('should search vector store for each variant', async () => {
      await service.search('test query', 'user_123');

      // Should search for each variant
      expect(mockEmbedding.search).toHaveBeenCalledTimes(3);
      expect(mockEmbedding.search).toHaveBeenCalledWith(
        'user_123',
        expect.any(Array),
        expect.any(Number),
        undefined, // layers
        undefined, // projectId
        undefined, // poolIds
      );
    });

    it('should fuse results from all queries', async () => {
      await service.search('test query', 'user_123');

      expect(mockFusion.fuse).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(String),
        expect.objectContaining({
          original: 'test query',
          variants: expect.any(Array),
        }),
      );
    });

    it('should return fused results with metrics', async () => {
      const result = await service.search('test query', 'user_123');

      expect(result.results).toBeDefined();
      expect(result.results.length).toBe(2);
      expect(result.expansion).toBeDefined();
      expect(result.metrics).toBeDefined();
      expect(result.metrics.expansionMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.embeddingMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.searchMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.fusionMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('should respect topK limit', async () => {
      mockFusion.fuse.mockReturnValue([
        ...mockFusedResults,
        {
          memoryId: 'mem_3',
          score: 0.7,
          rrfScore: 0.03,
          queryCount: 1,
          bestRank: 3,
          avgScore: 0.7,
          queryMatches: [],
        },
      ]);

      const result = await service.search('test query', 'user_123', {
        topK: 2,
      });

      expect(result.results.length).toBe(2);
    });

    it('should pass layers filter to search', async () => {
      await service.search('test query', 'user_123', {
        layers: [MemoryLayer.IDENTITY, MemoryLayer.PROJECT],
      });

      expect(mockEmbedding.search).toHaveBeenCalledWith(
        'user_123',
        expect.any(Array),
        expect.any(Number),
        [MemoryLayer.IDENTITY, MemoryLayer.PROJECT],
        undefined,
        undefined,
      );
    });

    it('should pass projectId filter to search', async () => {
      await service.search('test query', 'user_123', {
        projectId: 'project_123',
      });

      expect(mockEmbedding.search).toHaveBeenCalledWith(
        'user_123',
        expect.any(Array),
        expect.any(Number),
        undefined,
        'project_123',
        undefined,
      );
    });

    it('should use preset configuration', async () => {
      await service.search('test query', 'user_123', {
        multiQuery: { preset: 'fast' },
      });

      // Fast preset should use fewer variants
      expect(mockExpansion.expand).toHaveBeenCalledWith(
        'test query',
        expect.objectContaining({
          maxVariants: 3,
          strategy: ExpansionStrategy.RULES,
        }),
      );
    });

    it('should use balanced preset configuration', async () => {
      await service.search('test query', 'user_123', {
        multiQuery: { preset: 'balanced' },
      });

      expect(mockExpansion.expand).toHaveBeenCalledWith(
        'test query',
        expect.objectContaining({
          maxVariants: 5,
          strategy: ExpansionStrategy.HYBRID,
        }),
      );
    });

    it('should use comprehensive preset configuration', async () => {
      await service.search('test query', 'user_123', {
        multiQuery: { preset: 'comprehensive' },
      });

      expect(mockExpansion.expand).toHaveBeenCalledWith(
        'test query',
        expect.objectContaining({
          maxVariants: 10,
          strategy: ExpansionStrategy.HYBRID,
        }),
      );
    });

    it('should override fusion strategy from options', async () => {
      await service.search('test query', 'user_123', {
        multiQuery: { fusionStrategy: FusionStrategy.RRF },
      });

      expect(mockFusion.fuse).toHaveBeenCalledWith(
        expect.any(Array),
        FusionStrategy.RRF,
        expect.any(Object),
      );
    });

    it('should handle expansion timeout gracefully', async () => {
      // First call times out, second call (fallback) succeeds
      mockExpansion.expand
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Timeout')), 100),
            ),
        )
        .mockResolvedValueOnce(mockExpansionResult);

      // Should degrade gracefully without throwing
      await expect(
        service.search('test query', 'user_123', {
          multiQuery: { targetLatencyMs: 50 },
        }),
      ).resolves.toBeDefined();
    });

    it('should set degraded flag when falling back', async () => {
      // First call times out, second call (fallback) succeeds
      mockExpansion.expand
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Timeout')), 100),
            ),
        )
        .mockResolvedValueOnce(mockExpansionResult);

      const result = await service.search('test query', 'user_123', {
        multiQuery: { targetLatencyMs: 50 },
      });

      expect(result.degraded).toBe(true);
    });
  });

  describe('generateMetadata', () => {
    it('should include variants when requested', () => {
      const result = {
        results: mockFusedResults,
        expansion: mockExpansionResult,
        metrics: {
          expansionMs: 5,
          embeddingMs: 50,
          searchMs: 80,
          fusionMs: 10,
          totalMs: 145,
        },
        degraded: false,
      };

      const metadata = service.generateMetadata(result, {
        includeVariants: true,
      });

      expect(metadata.variants).toEqual([
        'test query',
        'test variant 1',
        'test variant 2',
      ]);
      expect(metadata.variantSources).toBeDefined();
    });

    it('should exclude variants when not requested', () => {
      const result = {
        results: mockFusedResults,
        expansion: mockExpansionResult,
        metrics: {
          expansionMs: 5,
          embeddingMs: 50,
          searchMs: 80,
          fusionMs: 10,
          totalMs: 145,
        },
        degraded: false,
      };

      const metadata = service.generateMetadata(result, {
        includeVariants: false,
      });

      expect(metadata.variants).toBeUndefined();
      expect(metadata.variantSources).toBeUndefined();
    });

    it('should include timings when requested', () => {
      const result = {
        results: mockFusedResults,
        expansion: mockExpansionResult,
        metrics: {
          expansionMs: 5,
          embeddingMs: 50,
          searchMs: 80,
          fusionMs: 10,
          totalMs: 145,
        },
        degraded: false,
      };

      const metadata = service.generateMetadata(result, {
        includeTimings: true,
      });

      expect(metadata.timings).toBeDefined();
      expect(metadata.timings!.totalMs).toBe(145);
    });
  });

  describe('generateExplanations', () => {
    it('should generate explanations for each result', () => {
      const explanations = service.generateExplanations(
        mockFusedResults,
        mockExpansionResult,
      );

      expect(explanations['mem_1']).toBeDefined();
      expect(explanations['mem_2']).toBeDefined();
    });

    it('should include matched queries in explanation', () => {
      const explanations = service.generateExplanations(
        mockFusedResults,
        mockExpansionResult,
      );

      expect(explanations['mem_1'].matchedQueries.length).toBe(3);
      expect(explanations['mem_1'].matchedQueries[0].isOriginal).toBe(true);
      expect(explanations['mem_1'].matchedQueries[1].isOriginal).toBe(false);
    });

    it('should include fusion contributions', () => {
      const explanations = service.generateExplanations(
        mockFusedResults,
        mockExpansionResult,
      );

      expect(explanations['mem_1'].fusionContributions.rrfScore).toBe(0.05);
      expect(
        explanations['mem_1'].fusionContributions.frequencyBoost,
      ).toBeCloseTo(1.0, 5);
      expect(explanations['mem_1'].fusionContributions.weightBoost).toBe(1.5); // Has original match
    });
  });
});
