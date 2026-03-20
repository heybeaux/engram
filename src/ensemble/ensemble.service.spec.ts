/**
 * Ensemble Service Tests
 *
 * Comprehensive tests for RRF fusion algorithm, ensemble retrieval,
 * nightly re-embedding, and model management.
 * Updated to use pgvector instead of Pinecone.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EnsembleService } from './ensemble.service';
import { NightlyReembedService } from './nightly-reembed.service';
import { CheckpointService } from './checkpoint.service';
import { DriftDetectionService } from './drift-detection.service';
import { ModelRegistryService } from './model-registry.service';
import { PgVectorEnsembleProvider } from './pgvector-ensemble.provider';
import { PrismaService } from '../prisma/prisma.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { CloudEnsembleService } from '../embedding/cloud-ensemble.service';
import {
  ModelId,
  ModelSearchResult,
  FusedResult,
  ReembedCheckpoint,
  ModelRegistryEntry,
  DEFAULT_PROMOTION_THRESHOLDS,
} from './ensemble.types';

// =============================================================================
// Mock Setup
// =============================================================================

const mockPrismaService = {
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $executeRaw: jest.fn(),
  $transaction: jest.fn((fn) => fn(mockPrismaService)),
  ensembleReembedJob: {
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  ensembleReembedCheckpoint: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  ensembleModelConfig: {
    create: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  memory: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
};

const mockPgVectorProvider = {
  upsertEmbedding: jest.fn(),
  upsertEmbeddings: jest.fn(),
  queryByModel: jest.fn(),
  queryAllModels: jest.fn(),
  queryWithModelEmbeddings: jest.fn(),
  deleteByMemory: jest.fn(),
  deleteByMemoryAndModel: jest.fn(),
  deleteByUser: jest.fn(),
  getEmbeddingCountByModel: jest.fn(),
  hasAllModelEmbeddings: jest.fn(),
  getMemoriesMissingEmbeddings: jest.fn(),
  getExistingEmbedding: jest.fn(),
};

const mockEmbeddingService = {
  embed: jest.fn(),
  embedOne: jest.fn(),
  getModelName: jest.fn().mockReturnValue('bge-base-en-v1.5'),
  getDimensions: jest.fn().mockReturnValue(768),
  healthCheck: jest.fn(),
  getProviderName: jest.fn().mockReturnValue('local'),
  getProvider: jest.fn(),
};

const mockCloudEnsembleService = {
  isAvailable: jest.fn().mockReturnValue(false),
  embed: jest.fn(),
  embedBatch: jest.fn(),
  getAvailableModels: jest.fn().mockReturnValue([]),
};

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const config: Record<string, any> = {
      ENSEMBLE_ENABLED: false,
      ENSEMBLE_REEMBED_ENABLED: false,
      LOCAL_EMBED_URL: 'http://localhost:8080',
      ENSEMBLE_DRIFT_THRESHOLD: 0.15,
      ENSEMBLE_DRIFT_ALERT: 0.25,
      ENSEMBLE_CONSENSUS_BOOST: true,
      ENSEMBLE_CONSENSUS_FACTOR: 0.1,
    };
    return config[key] ?? defaultValue;
  }),
};

// =============================================================================
// EnsembleService Tests
// =============================================================================

describe('EnsembleService', () => {
  let service: EnsembleService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnsembleService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PgVectorEnsembleProvider, useValue: mockPgVectorProvider },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: EmbeddingService, useValue: mockEmbeddingService },
        { provide: CloudEnsembleService, useValue: mockCloudEnsembleService },
      ],
    }).compile();

    service = module.get<EnsembleService>(EnsembleService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('reciprocalRankFusion', () => {
    it('should compute RRF scores correctly with default k=60', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
        { memoryId: 'mem-2', model: 'bge-base', rank: 2, score: 0.85 },
        { memoryId: 'mem-3', model: 'bge-base', rank: 3, score: 0.75 },
      ]);

      modelResults.set('minilm', [
        { memoryId: 'mem-2', model: 'minilm', rank: 1, score: 0.92 },
        { memoryId: 'mem-1', model: 'minilm', rank: 2, score: 0.88 },
        { memoryId: 'mem-4', model: 'minilm', rank: 3, score: 0.7 },
      ]);

      const results = service.reciprocalRankFusion(modelResults, 60);

      expect(results.length).toBe(4);

      // Top 2 should be mem-1 and mem-2 (they appear in both)
      const topIds = results
        .slice(0, 2)
        .map((r) => r.memoryId)
        .sort();
      expect(topIds).toEqual(['mem-1', 'mem-2']);

      // Memories appearing in both models should have appearsInModels = 2
      const mem1 = results.find((r) => r.memoryId === 'mem-1');
      expect(mem1?.appearsInModels).toBe(2);
      expect(mem1?.modelScores.size).toBe(2);
    });

    it('should apply model weights correctly', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
      ]);

      modelResults.set('minilm', [
        { memoryId: 'mem-2', model: 'minilm', rank: 1, score: 0.95 },
      ]);

      // Give BGE 2x weight
      const weights: Partial<Record<ModelId, number>> = {
        'bge-base': 2.0,
        minilm: 1.0,
        nomic: 1.0,
        'gte-base': 1.0,
      };
      const results = service.reciprocalRankFusion(modelResults, 60, weights);

      const mem1 = results.find((r) => r.memoryId === 'mem-1');
      const mem2 = results.find((r) => r.memoryId === 'mem-2');

      // mem-1 should have 2x the score of mem-2
      expect(mem1?.rrfScore).toBeCloseTo(mem2!.rrfScore * 2, 5);
      expect(results[0].memoryId).toBe('mem-1');
    });

    it('should handle empty results', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();
      modelResults.set('bge-base', []);
      modelResults.set('minilm', []);

      const results = service.reciprocalRankFusion(modelResults, 60);
      expect(results.length).toBe(0);
    });

    it('should handle single model results', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
        { memoryId: 'mem-2', model: 'bge-base', rank: 2, score: 0.85 },
      ]);

      const results = service.reciprocalRankFusion(modelResults, 60);

      expect(results.length).toBe(2);
      expect(results[0].memoryId).toBe('mem-1');
      expect(results[1].memoryId).toBe('mem-2');
    });

    it('should preserve model scores in results', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
      ]);

      modelResults.set('minilm', [
        { memoryId: 'mem-1', model: 'minilm', rank: 2, score: 0.88 },
      ]);

      const results = service.reciprocalRankFusion(modelResults, 60);
      const mem1 = results.find((r) => r.memoryId === 'mem-1');

      expect(mem1?.modelScores.get('bge-base')).toEqual({
        rank: 1,
        score: 0.95,
      });
      expect(mem1?.modelScores.get('minilm')).toEqual({ rank: 2, score: 0.88 });
    });

    it('should rank results by RRF score descending', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
        { memoryId: 'mem-3', model: 'bge-base', rank: 2, score: 0.9 },
      ]);

      modelResults.set('minilm', [
        { memoryId: 'mem-2', model: 'minilm', rank: 1, score: 0.95 },
        { memoryId: 'mem-1', model: 'minilm', rank: 2, score: 0.88 },
      ]);

      const results = service.reciprocalRankFusion(modelResults, 60);

      // mem-1 should be first because it appears in both models
      expect(results[0].memoryId).toBe('mem-1');
      expect(results[0].rrfScore).toBeGreaterThan(results[1].rrfScore);
    });

    it('should use k parameter correctly', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
      ]);

      // With k=60: score = 1/(60+1) ≈ 0.01639
      const resultsK60 = service.reciprocalRankFusion(modelResults, 60);
      expect(resultsK60[0].rrfScore).toBeCloseTo(1 / 61, 5);

      // With k=10: score = 1/(10+1) ≈ 0.0909
      const resultsK10 = service.reciprocalRankFusion(modelResults, 10);
      expect(resultsK10[0].rrfScore).toBeCloseTo(1 / 11, 5);

      // Lower k should give higher scores
      expect(resultsK10[0].rrfScore).toBeGreaterThan(resultsK60[0].rrfScore);
    });

    it('should handle large result sets efficiently', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      const bgeResults: ModelSearchResult[] = [];
      const minilmResults: ModelSearchResult[] = [];

      for (let i = 0; i < 100; i++) {
        bgeResults.push({
          memoryId: `mem-${i}`,
          model: 'bge-base',
          rank: i + 1,
          score: 1 - i * 0.01,
        });

        minilmResults.push({
          memoryId: `mem-${99 - i}`,
          model: 'minilm',
          rank: i + 1,
          score: 1 - i * 0.01,
        });
      }

      modelResults.set('bge-base', bgeResults);
      modelResults.set('minilm', minilmResults);

      const results = service.reciprocalRankFusion(modelResults, 60);

      expect(results.length).toBe(100);

      // All memories should appear in both models
      for (const result of results) {
        expect(result.appearsInModels).toBe(2);
      }
    });

    it('should handle zero weight for a model', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
      ]);

      modelResults.set('minilm', [
        { memoryId: 'mem-2', model: 'minilm', rank: 1, score: 0.95 },
      ]);

      const weights: Partial<Record<ModelId, number>> = {
        'bge-base': 1.0,
        minilm: 0.0,
        nomic: 1.0,
        'gte-base': 1.0,
      };
      const results = service.reciprocalRankFusion(modelResults, 60, weights);

      const mem1 = results.find((r) => r.memoryId === 'mem-1');
      const mem2 = results.find((r) => r.memoryId === 'mem-2');

      expect(mem1?.rrfScore).toBeGreaterThan(0);
      expect(mem2?.rrfScore).toBe(0);
    });

    it('should handle same memory at same rank in both models', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
      ]);

      modelResults.set('minilm', [
        { memoryId: 'mem-1', model: 'minilm', rank: 1, score: 0.93 },
      ]);

      const results = service.reciprocalRankFusion(modelResults, 60);

      expect(results.length).toBe(1);
      expect(results[0].memoryId).toBe('mem-1');
      expect(results[0].appearsInModels).toBe(2);

      // Score should be 2 * 1/(60+1) for rank 1 in both, plus consensus boost
      const baseScore = 2 * (1 / 61);
      // With consensus boost: baseScore * (1 + 0.1 * (2/2)) = baseScore * 1.1
      const expectedScore = baseScore * 1.1;
      expect(results[0].rrfScore).toBeCloseTo(expectedScore, 5);
    });

    it('should handle three models correctly', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
        { memoryId: 'mem-2', model: 'bge-base', rank: 2, score: 0.85 },
      ]);

      modelResults.set('nomic', [
        { memoryId: 'mem-1', model: 'nomic', rank: 1, score: 0.92 },
        { memoryId: 'mem-3', model: 'nomic', rank: 2, score: 0.8 },
      ]);

      modelResults.set('minilm', [
        { memoryId: 'mem-1', model: 'minilm', rank: 1, score: 0.9 },
        { memoryId: 'mem-2', model: 'minilm', rank: 2, score: 0.82 },
      ]);

      const results = service.reciprocalRankFusion(modelResults, 60);

      // mem-1 appears in all 3 models at rank 1
      const mem1 = results.find((r) => r.memoryId === 'mem-1');
      expect(mem1?.appearsInModels).toBe(3);

      // Base score with weights: bge-base=1.0, nomic=0.8, minilm=1.0
      // RRF score = 1.0*(1/61) + 0.8*(1/61) + 1.0*(1/61) = 2.8/61
      // With consensus boost (full agreement): 2.8/61 * (1 + 0.1 * 1) = 3.08/61
      const baseScore = (1.0 + 0.8 + 1.0) * (1 / 61);
      const expectedScore = baseScore * (1 + 0.1 * (3 / 3)); // Full consensus
      expect(mem1?.rrfScore).toBeCloseTo(expectedScore, 5);

      // mem-2 appears in 2 models at rank 2
      const mem2 = results.find((r) => r.memoryId === 'mem-2');
      expect(mem2?.appearsInModels).toBe(2);

      // mem-3 appears in 1 model
      const mem3 = results.find((r) => r.memoryId === 'mem-3');
      expect(mem3?.appearsInModels).toBe(1);
    });
  });

  describe('getConfig', () => {
    it('should return configuration', () => {
      const config = service.getConfig();
      expect(config).toHaveProperty('enabled');
      expect(config).toHaveProperty('models');
      expect(config).toHaveProperty('weights');
      expect(config).toHaveProperty('rrfK');
    });
  });

  describe('isEnabled', () => {
    it('should return enabled status', () => {
      expect(typeof service.isEnabled()).toBe('boolean');
    });
  });

  describe('delete', () => {
    it('should call pgvector provider deleteByMemory', async () => {
      // Enable the service for this test
      (service as any).config.enabled = true;

      await service.delete('mem-123');

      expect(mockPgVectorProvider.deleteByMemory).toHaveBeenCalledWith(
        'mem-123',
      );
    });

    it('should skip when disabled', async () => {
      (service as any).config.enabled = false;

      await service.delete('mem-123');

      expect(mockPgVectorProvider.deleteByMemory).not.toHaveBeenCalled();
    });
  });

  describe('getEmbeddingStats', () => {
    it('should return embedding counts by model', async () => {
      mockPgVectorProvider.getEmbeddingCountByModel.mockResolvedValue({
        'bge-base': 1000,
        minilm: 950,
      });

      const stats = await service.getEmbeddingStats();

      expect(stats['bge-base']).toBe(1000);
      expect(stats['minilm']).toBe(950);
    });
  });
});

// =============================================================================
// DriftDetectionService Tests
// =============================================================================

describe('DriftDetectionService', () => {
  let service: DriftDetectionService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriftDetectionService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ServicePrismaService, useValue: mockPrismaService },
        { provide: EmbeddingService, useValue: mockEmbeddingService },
        { provide: CloudEnsembleService, useValue: mockCloudEnsembleService },
      ],
    }).compile();

    service = module.get<DriftDetectionService>(DriftDetectionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('measureDrift', () => {
    it('should return 0 drift when no old embedding exists', async () => {
      const result = await service.measureDrift(
        'mem-1',
        null,
        [0.1, 0.2, 0.3],
        'bge-base',
      );

      expect(result.cosineDrift).toBe(0);
      expect(result.flagged).toBe(false);
    });

    it('should calculate 0 drift for identical embeddings', async () => {
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
      const result = await service.measureDrift(
        'mem-1',
        embedding,
        embedding,
        'bge-base',
      );

      expect(result.cosineDrift).toBeCloseTo(0, 5);
      expect(result.flagged).toBe(false);
    });

    it('should calculate drift for different embeddings', async () => {
      const old = [1, 0, 0];
      const newEmb = [0, 1, 0]; // Orthogonal vectors

      const result = await service.measureDrift(
        'mem-1',
        old,
        newEmb,
        'bge-base',
      );

      // Cosine distance of orthogonal vectors = 1
      expect(result.cosineDrift).toBeCloseTo(1, 5);
      expect(result.flagged).toBe(true);
    });

    it('should flag high drift embeddings', async () => {
      const old = [0.1, 0.2, 0.3];
      const newEmb = [0.5, 0.6, 0.7]; // Different direction

      const result = await service.measureDrift(
        'mem-1',
        old,
        newEmb,
        'bge-base',
      );

      // Check if flagged based on threshold
      expect(result.flagged).toBe(result.cosineDrift > 0.15);
    });
  });

  describe('measureBatchDrift with pgvector', () => {
    it('should fetch existing embeddings from pgvector', async () => {
      const memories = [
        { id: 'mem-1', raw: 'Test 1' },
        { id: 'mem-2', raw: 'Test 2' },
      ];
      const newEmbeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];

      // Mock pgvector query returning existing embeddings
      mockPrismaService.$queryRawUnsafe.mockResolvedValue([
        { memory_id: 'mem-1', embedding: '[0.1,0.2,0.3]' },
      ]);

      const results = await service.measureBatchDrift(
        memories,
        newEmbeddings,
        'bge-base',
      );

      expect(results.length).toBe(2);
      expect(mockPrismaService.$queryRawUnsafe).toHaveBeenCalled();
    });

    it('should handle missing existing embeddings', async () => {
      const memories = [{ id: 'mem-1', raw: 'Test 1' }];
      const newEmbeddings = [[0.1, 0.2, 0.3]];

      // No existing embeddings
      mockPrismaService.$queryRawUnsafe.mockResolvedValue([]);

      const results = await service.measureBatchDrift(
        memories,
        newEmbeddings,
        'bge-base',
      );

      expect(results.length).toBe(1);
      expect(results[0].cosineDrift).toBe(0);
      expect(results[0].oldEmbeddingVersion).toBe('none');
    });
  });

  describe('summarizeDrift', () => {
    it('should summarize empty analyses', () => {
      const summary = service.summarizeDrift([]);

      expect(summary.measured).toBe(false);
      expect(summary.avgCosineDrift).toBe(0);
      expect(summary.maxCosineDrift).toBe(0);
    });

    it('should calculate summary statistics', () => {
      const analyses = [
        {
          memoryId: 'm1',
          model: 'bge-base' as ModelId,
          cosineDrift: 0.1,
          oldEmbeddingVersion: 'v1',
          newEmbeddingVersion: 'v2',
          flagged: false,
        },
        {
          memoryId: 'm2',
          model: 'bge-base' as ModelId,
          cosineDrift: 0.2,
          oldEmbeddingVersion: 'v1',
          newEmbeddingVersion: 'v2',
          flagged: true,
        },
        {
          memoryId: 'm3',
          model: 'bge-base' as ModelId,
          cosineDrift: 0.3,
          oldEmbeddingVersion: 'v1',
          newEmbeddingVersion: 'v2',
          flagged: true,
        },
      ];

      const summary = service.summarizeDrift(analyses);

      expect(summary.measured).toBe(true);
      expect(summary.avgCosineDrift).toBeCloseTo(0.2, 5);
      expect(summary.maxCosineDrift).toBeCloseTo(0.3, 5);
      expect(summary.memoriesWithHighDrift).toBe(2);
    });

    it('should group by model', () => {
      const analyses = [
        {
          memoryId: 'm1',
          model: 'bge-base' as ModelId,
          cosineDrift: 0.1,
          oldEmbeddingVersion: 'v1',
          newEmbeddingVersion: 'v2',
          flagged: false,
        },
        {
          memoryId: 'm2',
          model: 'minilm' as ModelId,
          cosineDrift: 0.2,
          oldEmbeddingVersion: 'v1',
          newEmbeddingVersion: 'v2',
          flagged: true,
        },
      ];

      const summary = service.summarizeDrift(analyses);

      expect(summary.byModel['bge-base']).toBeDefined();
      expect(summary.byModel['minilm']).toBeDefined();
      expect(summary.byModel['bge-base'].avg).toBeCloseTo(0.1, 5);
      expect(summary.byModel['minilm'].avg).toBeCloseTo(0.2, 5);
    });
  });

  describe('thresholds', () => {
    it('should identify high drift', () => {
      expect(service.isHighDrift(0.2)).toBe(true);
      expect(service.isHighDrift(0.1)).toBe(false);
    });

    it('should identify alert-level drift', () => {
      expect(service.shouldAlert(0.3)).toBe(true);
      expect(service.shouldAlert(0.2)).toBe(false);
    });

    it('should return thresholds', () => {
      const thresholds = service.getThresholds();
      expect(thresholds.drift).toBe(0.15);
      expect(thresholds.alert).toBe(0.25);
    });
  });
});

// =============================================================================
// CheckpointService Tests
// =============================================================================

describe('CheckpointService', () => {
  let service: CheckpointService;
  let prisma: typeof mockPrismaService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckpointService,
        { provide: ServicePrismaService, useValue: mockPrismaService },
        { provide: EmbeddingService, useValue: mockEmbeddingService },
        { provide: CloudEnsembleService, useValue: mockCloudEnsembleService },
      ],
    }).compile();

    service = module.get<CheckpointService>(CheckpointService);
    prisma = mockPrismaService;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('save', () => {
    it('should save checkpoint to database', async () => {
      const checkpoint: ReembedCheckpoint = {
        jobId: 'test-job',
        createdAt: new Date(),
        lastProcessedId: 'mem-100',
        progress: {
          totalMemories: 500,
          processedMemories: 100,
          currentBatch: 10,
          totalBatches: 50,
          currentModel: 'bge-base',
        },
        completedModels: [],
        metrics: {},
      };

      prisma.ensembleReembedCheckpoint.upsert.mockResolvedValue({});

      await service.save(checkpoint);

      expect(prisma.ensembleReembedCheckpoint.upsert).toHaveBeenCalledWith({
        where: { jobId: 'test-job' },
        create: expect.objectContaining({ jobId: 'test-job' }),
        update: expect.objectContaining({ lastProcessedId: 'mem-100' }),
      });
    });
  });

  describe('get', () => {
    it('should return null for non-existent checkpoint', async () => {
      prisma.ensembleReembedCheckpoint.findUnique.mockResolvedValue(null);

      const result = await service.get('non-existent');

      expect(result).toBeNull();
    });

    it('should return checkpoint when found', async () => {
      prisma.ensembleReembedCheckpoint.findUnique.mockResolvedValue({
        jobId: 'test-job',
        createdAt: new Date(),
        lastProcessedId: 'mem-100',
        progress: { totalMemories: 500 },
        completedModels: [],
        metrics: {},
      });

      const result = await service.get('test-job');

      expect(result).not.toBeNull();
      expect(result?.jobId).toBe('test-job');
    });
  });

  describe('delete', () => {
    it('should delete checkpoint', async () => {
      prisma.ensembleReembedCheckpoint.deleteMany.mockResolvedValue({
        count: 1,
      });

      await service.delete('test-job');

      expect(prisma.ensembleReembedCheckpoint.deleteMany).toHaveBeenCalledWith({
        where: { jobId: 'test-job' },
      });
    });
  });

  describe('findActiveCheckpoint', () => {
    it('should return null when no active checkpoints', async () => {
      prisma.ensembleReembedCheckpoint.findFirst.mockResolvedValue(null);

      const result = await service.findActiveCheckpoint();

      expect(result).toBeNull();
    });

    it('should return most recent checkpoint', async () => {
      prisma.ensembleReembedCheckpoint.findFirst.mockResolvedValue({
        jobId: 'recent-job',
        createdAt: new Date(),
        lastProcessedId: 'mem-50',
        progress: {},
        completedModels: [],
        metrics: {},
      });

      const result = await service.findActiveCheckpoint();

      expect(result?.jobId).toBe('recent-job');
    });
  });

  describe('cleanupStale', () => {
    it('should delete stale checkpoints', async () => {
      prisma.ensembleReembedCheckpoint.deleteMany.mockResolvedValue({
        count: 3,
      });

      const count = await service.cleanupStale();

      expect(count).toBe(3);
    });
  });
});

// =============================================================================
// ModelRegistryService Tests
// =============================================================================

describe('ModelRegistryService', () => {
  let service: ModelRegistryService;
  let prisma: typeof mockPrismaService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelRegistryService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ServicePrismaService, useValue: mockPrismaService },
        { provide: EmbeddingService, useValue: mockEmbeddingService },
        { provide: CloudEnsembleService, useValue: mockCloudEnsembleService },
      ],
    }).compile();

    service = module.get<ModelRegistryService>(ModelRegistryService);
    prisma = mockPrismaService;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getActiveModels', () => {
    it('should return active models', async () => {
      prisma.ensembleModelConfig.findMany.mockResolvedValue([
        { modelId: 'bge-base' },
        { modelId: 'minilm' },
      ]);

      const models = await service.getActiveModels();

      expect(models).toContain('bge-base');
      expect(models).toContain('minilm');
    });

    it('should return empty array when no active models', async () => {
      prisma.ensembleModelConfig.findMany.mockResolvedValue([]);

      const models = await service.getActiveModels();

      expect(models).toEqual([]);
    });
  });

  describe('getActiveAndShadowModels', () => {
    it('should return both active and shadow models', async () => {
      prisma.ensembleModelConfig.findMany.mockResolvedValue([
        { modelId: 'bge-base' },
        { modelId: 'nomic' },
      ]);

      const models = await service.getActiveAndShadowModels();

      expect(models.length).toBe(2);
    });
  });

  describe('addModel', () => {
    it('should add model with default shadow status', async () => {
      prisma.ensembleModelConfig.create.mockResolvedValue({
        modelId: 'nomic',
        status: 'SHADOW',
        weight: 1.0,
        addedAt: new Date(),
        qualityMetrics: {},
        promotionThresholds: DEFAULT_PROMOTION_THRESHOLDS,
      });

      const result = await service.addModel({ modelId: 'nomic' });

      expect(result.modelId).toBe('nomic');
      expect(result.status).toBe('shadow');
    });

    it('should add model with custom weight', async () => {
      prisma.ensembleModelConfig.create.mockResolvedValue({
        modelId: 'nomic',
        status: 'SHADOW',
        weight: 1.2,
        addedAt: new Date(),
        qualityMetrics: {},
        promotionThresholds: DEFAULT_PROMOTION_THRESHOLDS,
      });

      const result = await service.addModel({ modelId: 'nomic', weight: 1.2 });

      expect(result.weight).toBe(1.2);
    });
  });

  describe('updateModelStatus', () => {
    it('should update model status', async () => {
      prisma.ensembleModelConfig.update.mockResolvedValue({});

      await service.updateModelStatus('nomic', 'active');

      expect(prisma.ensembleModelConfig.update).toHaveBeenCalledWith({
        where: { modelId: 'nomic' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      });
    });

    it('should set promotedAt when promoting to active', async () => {
      prisma.ensembleModelConfig.update.mockResolvedValue({});

      await service.updateModelStatus('nomic', 'active');

      expect(prisma.ensembleModelConfig.update).toHaveBeenCalledWith({
        where: { modelId: 'nomic' },
        data: expect.objectContaining({ promotedAt: expect.any(Date) }),
      });
    });
  });

  describe('updateModelWeight', () => {
    it('should update model weight', async () => {
      prisma.ensembleModelConfig.update.mockResolvedValue({});

      await service.updateModelWeight('bge-base', 1.5);

      expect(prisma.ensembleModelConfig.update).toHaveBeenCalledWith({
        where: { modelId: 'bge-base' },
        data: { weight: 1.5 },
      });
    });
  });

  describe('checkPromotionCriteria', () => {
    it('should pass when all criteria met', async () => {
      service.getModelConfig = jest.fn().mockResolvedValue({
        modelId: 'nomic',
        status: 'shadow',
        qualityMetrics: {
          sampleQueries: 2000,
          avgRankContribution: 0.25,
          uniqueHits: 100,
          correlationWithGoldStandard: 0.9,
        },
        promotionThresholds: DEFAULT_PROMOTION_THRESHOLDS,
      } as ModelRegistryEntry);

      const result = await service.checkPromotionCriteria('nomic');

      expect(result.passed).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('should fail when sample queries insufficient', async () => {
      service.getModelConfig = jest.fn().mockResolvedValue({
        modelId: 'nomic',
        status: 'shadow',
        qualityMetrics: {
          sampleQueries: 500, // Below threshold
          avgRankContribution: 0.25,
          uniqueHits: 100,
          correlationWithGoldStandard: 0.9,
        },
        promotionThresholds: DEFAULT_PROMOTION_THRESHOLDS,
      } as ModelRegistryEntry);

      const result = await service.checkPromotionCriteria('nomic');

      expect(result.passed).toBe(false);
      expect(result.reasons.some((r) => r.includes('samples'))).toBe(true);
    });

    it('should fail when rank contribution too low', async () => {
      service.getModelConfig = jest.fn().mockResolvedValue({
        modelId: 'nomic',
        status: 'shadow',
        qualityMetrics: {
          sampleQueries: 2000,
          avgRankContribution: 0.05, // Below threshold
          uniqueHits: 100,
          correlationWithGoldStandard: 0.9,
        },
        promotionThresholds: DEFAULT_PROMOTION_THRESHOLDS,
      } as ModelRegistryEntry);

      const result = await service.checkPromotionCriteria('nomic');

      expect(result.passed).toBe(false);
      expect(result.reasons.some((r) => r.includes('contribution'))).toBe(true);
    });
  });

  describe('promoteModel', () => {
    it('should promote model when criteria met', async () => {
      service.checkPromotionCriteria = jest
        .fn()
        .mockResolvedValue({ passed: true, reasons: [] });
      service.updateModelStatus = jest.fn().mockResolvedValue(undefined);

      const result = await service.promoteModel('nomic');

      expect(result.success).toBe(true);
      expect(service.updateModelStatus).toHaveBeenCalledWith('nomic', 'active');
    });

    it('should reject promotion when criteria not met', async () => {
      service.checkPromotionCriteria = jest.fn().mockResolvedValue({
        passed: false,
        reasons: ['Insufficient samples'],
      });

      const result = await service.promoteModel('nomic');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient');
    });
  });

  describe('getModelWeights', () => {
    it('should return weights for all active models', async () => {
      prisma.ensembleModelConfig.findMany.mockResolvedValue([
        { modelId: 'bge-base', weight: 1.0 },
        { modelId: 'minilm', weight: 0.9 },
        { modelId: 'nomic', weight: 1.1 },
      ]);

      const weights = await service.getModelWeights();

      expect(weights['bge-base']).toBe(1.0);
      expect(weights['minilm']).toBe(0.9);
      expect(weights['nomic']).toBe(1.1);
    });
  });
});

// =============================================================================
// NightlyReembedService Tests
// =============================================================================

describe('NightlyReembedService', () => {
  let service: NightlyReembedService;
  let prisma: typeof mockPrismaService;

  const mockEnsembleService = {
    embedBatch: jest.fn(),
    upsert: jest.fn(),
    upsertEmbeddings: jest.fn(),
  };

  const mockDriftService = {
    measureBatchDrift: jest.fn(),
  };

  const mockCheckpointService = {
    get: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    findActiveCheckpoint: jest.fn(),
  };

  const mockModelRegistry = {
    getActiveAndShadowModels: jest.fn(),
    getActiveModels: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NightlyReembedService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ServicePrismaService, useValue: mockPrismaService },
        { provide: EmbeddingService, useValue: mockEmbeddingService },
        { provide: CloudEnsembleService, useValue: mockCloudEnsembleService },
        { provide: EnsembleService, useValue: mockEnsembleService },
        { provide: DriftDetectionService, useValue: mockDriftService },
        { provide: CheckpointService, useValue: mockCheckpointService },
        { provide: ModelRegistryService, useValue: mockModelRegistry },
        { provide: PgVectorEnsembleProvider, useValue: mockPgVectorProvider },
      ],
    }).compile();

    service = module.get<NightlyReembedService>(NightlyReembedService);
    prisma = mockPrismaService;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getActiveJobStatus', () => {
    it('should return null when no job running', () => {
      const status = service.getActiveJobStatus();
      expect(status).toBeNull();
    });
  });

  describe('cancelActiveJob', () => {
    it('should return false when no job running', async () => {
      const result = await service.cancelActiveJob();
      expect(result).toBe(false);
    });
  });

  describe('reembedMemories', () => {
    it('should re-embed specific memories and store in pgvector', async () => {
      prisma.memory.findMany.mockResolvedValue([
        { id: 'mem-1', raw: 'Test 1', userId: 'user-1' },
        { id: 'mem-2', raw: 'Test 2', userId: 'user-1' },
      ]);

      mockModelRegistry.getActiveModels.mockResolvedValue(['bge-base']);
      mockEnsembleService.embedBatch.mockResolvedValue({
        embeddings: [
          { model: 'bge-base', embedding: [0.1, 0.2], dimensions: 768 },
          { model: 'bge-base', embedding: [0.3, 0.4], dimensions: 768 },
        ],
        totalMs: 50,
      });
      mockDriftService.measureBatchDrift.mockResolvedValue([]);
      mockPgVectorProvider.upsertEmbeddings.mockResolvedValue(undefined);

      await service.reembedMemories(['mem-1', 'mem-2']);

      expect(prisma.memory.findMany).toHaveBeenCalled();
      expect(mockPgVectorProvider.upsertEmbeddings).toHaveBeenCalled();
    });

    it('should handle empty memory list', async () => {
      prisma.memory.findMany.mockResolvedValue([]);

      await service.reembedMemories([]);

      expect(mockEnsembleService.embedBatch).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// PgVectorEnsembleProvider Tests
// =============================================================================

describe('PgVectorEnsembleProvider', () => {
  let provider: PgVectorEnsembleProvider;
  let prisma: typeof mockPrismaService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PgVectorEnsembleProvider,
        { provide: ServicePrismaService, useValue: mockPrismaService },
        { provide: EmbeddingService, useValue: mockEmbeddingService },
        { provide: CloudEnsembleService, useValue: mockCloudEnsembleService },
      ],
    }).compile();

    provider = module.get<PgVectorEnsembleProvider>(PgVectorEnsembleProvider);
    prisma = mockPrismaService;
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });

  describe('upsertEmbedding', () => {
    it('should insert new embedding', async () => {
      prisma.$executeRawUnsafe.mockResolvedValue(1);

      await provider.upsertEmbedding({
        memoryId: 'mem-1',
        modelId: 'bge-base',
        embedding: [0.1, 0.2, 0.3],
        dimensions: 768,
      });

      expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
      const call = prisma.$executeRawUnsafe.mock.calls[0];
      expect(call[1]).toBe('mem-1');
      expect(call[2]).toBe('bge-base');
      expect(call[3]).toBe(768);
    });
  });

  describe('queryByModel', () => {
    it('should query embeddings for specific model', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        { memory_id: 'mem-1', score: 0.95 },
        { memory_id: 'mem-2', score: 0.85 },
      ]);

      const results = await provider.queryByModel({
        userId: 'user-1',
        modelId: 'bge-base',
        embedding: [0.1, 0.2, 0.3],
        limit: 10,
      });

      expect(results.length).toBe(2);
      expect(results[0].memoryId).toBe('mem-1');
      expect(results[0].score).toBe(0.95);
      expect(results[0].modelId).toBe('bge-base');
    });
  });

  describe('deleteByMemory', () => {
    it('should delete all embeddings for a memory', async () => {
      prisma.$executeRaw.mockResolvedValue(3);

      await provider.deleteByMemory('mem-1');

      expect(prisma.$executeRaw).toHaveBeenCalled();
    });
  });

  describe('getEmbeddingCountByModel', () => {
    it('should return counts grouped by model', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { model_id: 'bge-base', count: BigInt(1000) },
        { model_id: 'minilm', count: BigInt(950) },
      ]);

      const counts = await provider.getEmbeddingCountByModel();

      expect(counts['bge-base']).toBe(1000);
      expect(counts['minilm']).toBe(950);
    });
  });

  describe('getExistingEmbedding', () => {
    it('should return parsed embedding array', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        { embedding: '[0.1,0.2,0.3]' },
      ]);

      const embedding = await provider.getExistingEmbedding(
        'mem-1',
        'bge-base',
      );

      expect(embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('should return null when no embedding exists', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      const embedding = await provider.getExistingEmbedding(
        'mem-1',
        'bge-base',
      );

      expect(embedding).toBeNull();
    });
  });
});

// =============================================================================
// Integration-style Tests
// =============================================================================

describe('Ensemble Integration Tests', () => {
  describe('RRF Fusion with Nomic Model', () => {
    let service: EnsembleService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EnsembleService,
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PgVectorEnsembleProvider, useValue: mockPgVectorProvider },
          { provide: PrismaService, useValue: mockPrismaService },
          { provide: EmbeddingService, useValue: mockEmbeddingService },
          { provide: CloudEnsembleService, useValue: mockCloudEnsembleService },
        ],
      }).compile();

      service = module.get<EnsembleService>(EnsembleService);
    });

    it('should handle nomic model with prefix requirements', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.9 },
        { memoryId: 'mem-2', model: 'bge-base', rank: 2, score: 0.85 },
      ]);

      modelResults.set('nomic', [
        { memoryId: 'mem-1', model: 'nomic', rank: 1, score: 0.88 },
        { memoryId: 'mem-3', model: 'nomic', rank: 2, score: 0.82 },
      ]);

      modelResults.set('minilm', [
        { memoryId: 'mem-2', model: 'minilm', rank: 1, score: 0.91 },
        { memoryId: 'mem-1', model: 'minilm', rank: 2, score: 0.85 },
      ]);

      const results = service.reciprocalRankFusion(modelResults, 60);

      // mem-1 appears in all 3 models, should be top
      expect(results[0].memoryId).toBe('mem-1');
      expect(results[0].appearsInModels).toBe(3);

      // mem-2 appears in 2 models
      const mem2 = results.find((r) => r.memoryId === 'mem-2');
      expect(mem2?.appearsInModels).toBe(2);
    });
  });

  describe('Weighted RRF for Query Types', () => {
    let service: EnsembleService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EnsembleService,
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PgVectorEnsembleProvider, useValue: mockPgVectorProvider },
          { provide: PrismaService, useValue: mockPrismaService },
          { provide: EmbeddingService, useValue: mockEmbeddingService },
          { provide: CloudEnsembleService, useValue: mockCloudEnsembleService },
        ],
      }).compile();

      service = module.get<EnsembleService>(EnsembleService);
    });

    it('should boost minilm for entity queries', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.9 },
      ]);

      modelResults.set('minilm', [
        { memoryId: 'mem-2', model: 'minilm', rank: 1, score: 0.9 },
      ]);

      // Entity query should boost minilm
      const weights: Partial<Record<ModelId, number>> = {
        'bge-base': 0.9,
        minilm: 1.4,
        nomic: 0.8,
        'gte-base': 1.0,
      };

      const results = service.reciprocalRankFusion(modelResults, 60, weights);

      // minilm result should be ranked higher
      expect(results[0].memoryId).toBe('mem-2');
    });

    it('should boost nomic for conversational queries', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      modelResults.set('bge-base', [
        { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.9 },
      ]);

      modelResults.set('nomic', [
        { memoryId: 'mem-2', model: 'nomic', rank: 1, score: 0.9 },
      ]);

      // Conversational query should boost nomic
      const weights: Partial<Record<ModelId, number>> = {
        'bge-base': 0.9,
        nomic: 1.4,
        minilm: 0.7,
        'gte-base': 1.0,
      };

      const results = service.reciprocalRankFusion(modelResults, 60, weights);

      // nomic result should be ranked higher
      expect(results[0].memoryId).toBe('mem-2');
    });
  });

  describe('Consensus Boost', () => {
    let service: EnsembleService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EnsembleService,
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PgVectorEnsembleProvider, useValue: mockPgVectorProvider },
          { provide: PrismaService, useValue: mockPrismaService },
          { provide: EmbeddingService, useValue: mockEmbeddingService },
          { provide: CloudEnsembleService, useValue: mockCloudEnsembleService },
        ],
      }).compile();

      service = module.get<EnsembleService>(EnsembleService);
    });

    it('should favor memories with multi-model agreement', () => {
      const modelResults = new Map<ModelId, ModelSearchResult[]>();

      // mem-1 appears in all 3 at lower ranks
      // mem-2 appears in only 1 at rank 1
      modelResults.set('bge-base', [
        { memoryId: 'mem-2', model: 'bge-base', rank: 1, score: 0.95 },
        { memoryId: 'mem-1', model: 'bge-base', rank: 3, score: 0.8 },
      ]);

      modelResults.set('nomic', [
        { memoryId: 'mem-1', model: 'nomic', rank: 2, score: 0.85 },
      ]);

      modelResults.set('minilm', [
        { memoryId: 'mem-1', model: 'minilm', rank: 2, score: 0.85 },
      ]);

      const results = service.reciprocalRankFusion(modelResults, 60);

      // mem-1 should be first due to appearing in 3 models
      expect(results[0].memoryId).toBe('mem-1');
      expect(results[0].appearsInModels).toBe(3);
    });
  });
});

// =============================================================================
// Edge Case Tests
// =============================================================================

describe('Edge Cases', () => {
  let service: EnsembleService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnsembleService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PgVectorEnsembleProvider, useValue: mockPgVectorProvider },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: EmbeddingService, useValue: mockEmbeddingService },
        { provide: CloudEnsembleService, useValue: mockCloudEnsembleService },
      ],
    }).compile();

    service = module.get<EnsembleService>(EnsembleService);
  });

  it('should handle duplicate memory IDs in same model results', () => {
    const modelResults = new Map<ModelId, ModelSearchResult[]>();

    // Duplicate mem-1 in bge-base (shouldn't happen but testing robustness)
    modelResults.set('bge-base', [
      { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
      { memoryId: 'mem-1', model: 'bge-base', rank: 2, score: 0.9 },
    ]);

    const results = service.reciprocalRankFusion(modelResults, 60);

    // Should have combined scores
    expect(results.length).toBe(1);
    expect(results[0].memoryId).toBe('mem-1');
  });

  it('should handle very high ranks (low relevance)', () => {
    const modelResults = new Map<ModelId, ModelSearchResult[]>();

    modelResults.set('bge-base', [
      { memoryId: 'mem-1', model: 'bge-base', rank: 100, score: 0.3 },
    ]);

    const results = service.reciprocalRankFusion(modelResults, 60);

    // Score should be 1/(60+100) = 1/160
    expect(results[0].rrfScore).toBeCloseTo(1 / 160, 5);
  });

  it('should handle negative weights gracefully', () => {
    const modelResults = new Map<ModelId, ModelSearchResult[]>();

    modelResults.set('bge-base', [
      { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
    ]);

    // Negative weight (edge case)
    const weights: Partial<Record<ModelId, number>> = {
      'bge-base': -1.0,
      minilm: 1.0,
      nomic: 1.0,
      'gte-base': 1.0,
    };
    const results = service.reciprocalRankFusion(modelResults, 60, weights);

    // Score should be negative
    expect(results[0].rrfScore).toBeLessThan(0);
  });

  it('should handle very large k values', () => {
    const modelResults = new Map<ModelId, ModelSearchResult[]>();

    modelResults.set('bge-base', [
      { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
    ]);

    const results = service.reciprocalRankFusion(modelResults, 10000);

    // Score should be 1/(10000+1) ≈ 0.00009999
    expect(results[0].rrfScore).toBeCloseTo(1 / 10001, 7);
  });

  it('should handle k=0', () => {
    const modelResults = new Map<ModelId, ModelSearchResult[]>();

    modelResults.set('bge-base', [
      { memoryId: 'mem-1', model: 'bge-base', rank: 1, score: 0.95 },
    ]);

    const results = service.reciprocalRankFusion(modelResults, 0);

    // Score should be 1/(0+1) = 1
    expect(results[0].rrfScore).toBe(1);
  });
});
