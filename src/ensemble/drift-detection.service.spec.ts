/**
 * Drift Detection Service Tests
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DriftDetectionService } from './drift-detection.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { ModelId } from './ensemble.types';

const mockPrismaService = {
  $queryRawUnsafe: jest.fn(),
  driftSnapshot: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
};

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const config: Record<string, any> = {
      ENSEMBLE_DRIFT_THRESHOLD: 0.15,
      ENSEMBLE_DRIFT_ALERT: 0.25,
    };
    return config[key] ?? defaultValue;
  }),
};

describe('DriftDetectionService', () => {
  let service: DriftDetectionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriftDetectionService,
        { provide: ServicePrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<DriftDetectionService>(DriftDetectionService);
    jest.clearAllMocks();
  });

  describe('measureDrift', () => {
    it('should return zero drift when no old embedding exists', async () => {
      const result = await service.measureDrift(
        'mem-1',
        null,
        [1, 0, 0],
        'bge-base',
      );
      expect(result.cosineDrift).toBe(0);
      expect(result.flagged).toBe(false);
    });

    it('should return zero drift for identical embeddings', async () => {
      const embedding = [1, 0, 0];
      const result = await service.measureDrift(
        'mem-1',
        embedding,
        embedding,
        'bge-base',
      );
      expect(result.cosineDrift).toBeCloseTo(0, 5);
      expect(result.flagged).toBe(false);
    });

    it('should flag high drift', async () => {
      const result = await service.measureDrift(
        'mem-1',
        [1, 0, 0],
        [0, 1, 0],
        'bge-base',
      );
      // Cosine distance between orthogonal vectors = 1
      expect(result.cosineDrift).toBeCloseTo(1, 5);
      expect(result.flagged).toBe(true);
    });
  });

  describe('measureBatchDrift', () => {
    it('should measure drift for a batch of memories', async () => {
      mockPrismaService.$queryRawUnsafe.mockResolvedValue([
        { memory_id: 'mem-1', embedding: '[1,0,0]' },
        { memory_id: 'mem-2', embedding: '[0,1,0]' },
      ]);

      const memories = [
        { id: 'mem-1', raw: 'test 1' },
        { id: 'mem-2', raw: 'test 2' },
      ];
      const newEmbeddings = [
        [1, 0, 0],
        [0, 1, 0],
      ];

      const results = await service.measureBatchDrift(
        memories,
        newEmbeddings,
        'bge-base',
      );
      expect(results).toHaveLength(2);
      expect(results[0].cosineDrift).toBeCloseTo(0, 5); // identical
      expect(results[1].cosineDrift).toBeCloseTo(0, 5); // identical
    });

    it('should handle missing old embeddings', async () => {
      mockPrismaService.$queryRawUnsafe.mockResolvedValue([]);

      const memories = [{ id: 'mem-1', raw: 'test' }];
      const newEmbeddings = [[1, 0, 0]];

      const results = await service.measureBatchDrift(
        memories,
        newEmbeddings,
        'bge-base',
      );
      expect(results).toHaveLength(1);
      expect(results[0].cosineDrift).toBe(0);
    });
  });

  describe('summarizeDrift', () => {
    it('should return empty summary for no analyses', () => {
      const summary = service.summarizeDrift([]);
      expect(summary.measured).toBe(false);
      expect(summary.avgCosineDrift).toBe(0);
    });

    it('should compute correct summary statistics', () => {
      const analyses = [
        {
          memoryId: 'm1',
          model: 'bge-base' as ModelId,
          cosineDrift: 0.1,
          oldEmbeddingVersion: 'prev',
          newEmbeddingVersion: 'curr',
          flagged: false,
        },
        {
          memoryId: 'm2',
          model: 'bge-base' as ModelId,
          cosineDrift: 0.3,
          oldEmbeddingVersion: 'prev',
          newEmbeddingVersion: 'curr',
          flagged: true,
        },
      ];

      const summary = service.summarizeDrift(analyses);
      expect(summary.measured).toBe(true);
      expect(summary.avgCosineDrift).toBeCloseTo(0.2, 5);
      expect(summary.maxCosineDrift).toBeCloseTo(0.3, 5);
      expect(summary.memoriesWithHighDrift).toBe(1);
      expect(summary.byModel['bge-base']).toBeDefined();
    });

    it('should group by model', () => {
      const analyses = [
        {
          memoryId: 'm1',
          model: 'bge-base' as ModelId,
          cosineDrift: 0.1,
          oldEmbeddingVersion: 'prev',
          newEmbeddingVersion: 'curr',
          flagged: false,
        },
        {
          memoryId: 'm2',
          model: 'nomic' as ModelId,
          cosineDrift: 0.2,
          oldEmbeddingVersion: 'prev',
          newEmbeddingVersion: 'curr',
          flagged: true,
        },
      ];

      const summary = service.summarizeDrift(analyses);
      expect(summary.byModel['bge-base'].avg).toBeCloseTo(0.1, 5);
      expect(summary.byModel['nomic'].avg).toBeCloseTo(0.2, 5);
    });
  });

  describe('getThresholds', () => {
    it('should return configured thresholds', () => {
      const thresholds = service.getThresholds();
      expect(thresholds.drift).toBe(0.15);
      expect(thresholds.alert).toBe(0.25);
    });
  });

  describe('shouldAlert / isHighDrift', () => {
    it('shouldAlert returns true above alert threshold', () => {
      expect(service.shouldAlert(0.26)).toBe(true);
      expect(service.shouldAlert(0.24)).toBe(false);
    });

    it('isHighDrift returns true above drift threshold', () => {
      expect(service.isHighDrift(0.16)).toBe(true);
      expect(service.isHighDrift(0.14)).toBe(false);
    });
  });
});
