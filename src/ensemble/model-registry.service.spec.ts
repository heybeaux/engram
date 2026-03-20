import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ModelRegistryService } from './model-registry.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import {
  DEFAULT_PROMOTION_THRESHOLDS,
  DEFAULT_ACTIVE_MODELS,
  MODEL_CONFIGS,
} from './ensemble.types';

describe('ModelRegistryService', () => {
  let service: ModelRegistryService;
  let prisma: jest.Mocked<ServicePrismaService>;

  const mockModel = (overrides: Record<string, unknown> = {}) => ({
    modelId: 'bge-base',
    status: 'ACTIVE',
    weight: 1.0,
    addedAt: new Date('2026-01-01'),
    promotedAt: new Date('2026-01-01'),
    deprecatedAt: null,
    queryTypeWeights: null,
    qualityMetrics: {
      sampleQueries: 500,
      avgRankContribution: 0.3,
      uniqueHits: 100,
      correlationWithGoldStandard: 0.85,
    },
    promotionThresholds: DEFAULT_PROMOTION_THRESHOLDS,
    ...overrides,
  });

  beforeEach(async () => {
    const mockPrisma = {
      ensembleModelConfig: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelRegistryService,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get(ModelRegistryService);
    prisma = module.get(ServicePrismaService);

    // Mock create to return what was passed
    (prisma.ensembleModelConfig.create as jest.Mock).mockImplementation(
      async ({ data }) => ({
        ...data,
        addedAt: new Date(),
        deprecatedAt: null,
        queryTypeWeights: null,
      }),
    );
  });

  describe('onModuleInit', () => {
    it('should initialize with defaults when registry is empty', async () => {
      (prisma.ensembleModelConfig.findMany as jest.Mock).mockResolvedValue([]);

      await service.onModuleInit();

      expect(prisma.ensembleModelConfig.create).toHaveBeenCalledTimes(
        DEFAULT_ACTIVE_MODELS.length,
      );
    });

    it('should load existing models from DB', async () => {
      const existing = [mockModel(), mockModel({ modelId: 'minilm' })];
      (prisma.ensembleModelConfig.findMany as jest.Mock).mockResolvedValue(
        existing,
      );

      await service.onModuleInit();

      // Should still create missing default models
      const createdCount = DEFAULT_ACTIVE_MODELS.length - 2;
      expect(prisma.ensembleModelConfig.create).toHaveBeenCalledTimes(
        createdCount,
      );
    });
  });

  describe('getActiveModels', () => {
    it('should return only active model IDs', async () => {
      (prisma.ensembleModelConfig.findMany as jest.Mock).mockResolvedValue([
        { modelId: 'bge-base' },
        { modelId: 'minilm' },
      ]);

      const result = await service.getActiveModels();
      expect(result).toEqual(['bge-base', 'minilm']);
      expect(prisma.ensembleModelConfig.findMany).toHaveBeenCalledWith({
        where: { status: 'ACTIVE' },
        select: { modelId: true },
      });
    });
  });

  describe('getActiveAndShadowModels', () => {
    it('should return active and shadow model IDs', async () => {
      (prisma.ensembleModelConfig.findMany as jest.Mock).mockResolvedValue([
        { modelId: 'bge-base' },
        { modelId: 'nomic' },
      ]);

      const result = await service.getActiveAndShadowModels();
      expect(result).toEqual(['bge-base', 'nomic']);
      expect(prisma.ensembleModelConfig.findMany).toHaveBeenCalledWith({
        where: { status: { in: ['ACTIVE', 'SHADOW'] } },
        select: { modelId: true },
      });
    });
  });

  describe('getModelConfig', () => {
    it('should return null for unknown model', async () => {
      (prisma.ensembleModelConfig.findUnique as jest.Mock).mockResolvedValue(
        null,
      );

      const result = await service.getModelConfig('bge-base');
      expect(result).toBeNull();
    });

    it('should fetch from DB and cache', async () => {
      const model = mockModel();
      (prisma.ensembleModelConfig.findUnique as jest.Mock).mockResolvedValue(
        model,
      );

      const result = await service.getModelConfig('bge-base');
      expect(result).toBeDefined();
      expect(result!.modelId).toBe('bge-base');
      expect(result!.status).toBe('active');

      // Second call should use cache (no additional DB call)
      await service.getModelConfig('bge-base');
      expect(prisma.ensembleModelConfig.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('addModel', () => {
    it('should create model with defaults', async () => {
      const result = await service.addModel({ modelId: 'bge-base' });

      expect(prisma.ensembleModelConfig.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          modelId: 'bge-base',
          status: 'SHADOW',
          weight: 1.0,
        }),
      });
      expect(result.modelId).toBe('bge-base');
    });

    it('should create active model with promotedAt', async () => {
      await service.addModel({
        modelId: 'minilm',
        status: 'active',
        weight: 0.8,
      });

      expect(prisma.ensembleModelConfig.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          modelId: 'minilm',
          status: 'ACTIVE',
          weight: 0.8,
          promotedAt: expect.any(Date),
        }),
      });
    });
  });

  describe('updateModelStatus', () => {
    it('should update status to active with promotedAt', async () => {
      await service.updateModelStatus('bge-base', 'active');

      expect(prisma.ensembleModelConfig.update).toHaveBeenCalledWith({
        where: { modelId: 'bge-base' },
        data: { status: 'ACTIVE', promotedAt: expect.any(Date) },
      });
    });

    it('should update status to deprecated with deprecatedAt', async () => {
      await service.updateModelStatus('bge-base', 'deprecated');

      expect(prisma.ensembleModelConfig.update).toHaveBeenCalledWith({
        where: { modelId: 'bge-base' },
        data: { status: 'DEPRECATED', deprecatedAt: expect.any(Date) },
      });
    });
  });

  describe('updateModelWeight', () => {
    it('should update weight in DB and cache', async () => {
      // Populate cache first
      (prisma.ensembleModelConfig.findUnique as jest.Mock).mockResolvedValue(
        mockModel(),
      );
      await service.getModelConfig('bge-base');

      await service.updateModelWeight('bge-base', 1.5);

      expect(prisma.ensembleModelConfig.update).toHaveBeenCalledWith({
        where: { modelId: 'bge-base' },
        data: { weight: 1.5 },
      });
    });
  });

  describe('checkPromotionCriteria', () => {
    it('should fail when model not found', async () => {
      (prisma.ensembleModelConfig.findUnique as jest.Mock).mockResolvedValue(
        null,
      );

      const result = await service.checkPromotionCriteria('bge-base');
      expect(result.passed).toBe(false);
      expect(result.reasons).toContain('Model not found');
    });

    it('should pass when all criteria met', async () => {
      (prisma.ensembleModelConfig.findUnique as jest.Mock).mockResolvedValue(
        mockModel({
          qualityMetrics: {
            sampleQueries: 2000,
            avgRankContribution: 0.3,
            uniqueHits: 500,
            correlationWithGoldStandard: 0.9,
          },
        }),
      );

      const result = await service.checkPromotionCriteria('bge-base');
      expect(result.passed).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('should fail with insufficient samples', async () => {
      (prisma.ensembleModelConfig.findUnique as jest.Mock).mockResolvedValue(
        mockModel({
          qualityMetrics: {
            sampleQueries: 100,
            avgRankContribution: 0.3,
            uniqueHits: 50,
            correlationWithGoldStandard: 0.9,
          },
        }),
      );

      const result = await service.checkPromotionCriteria('bge-base');
      expect(result.passed).toBe(false);
      expect(result.reasons[0]).toContain('Insufficient samples');
    });
  });

  describe('promoteModel', () => {
    it('should fail if criteria not met', async () => {
      (prisma.ensembleModelConfig.findUnique as jest.Mock).mockResolvedValue(
        mockModel({
          qualityMetrics: {
            sampleQueries: 10,
            avgRankContribution: 0.01,
            uniqueHits: 1,
            correlationWithGoldStandard: 0.1,
          },
        }),
      );

      const result = await service.promoteModel('bge-base');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Promotion criteria not met');
    });

    it('should succeed if criteria met', async () => {
      (prisma.ensembleModelConfig.findUnique as jest.Mock).mockResolvedValue(
        mockModel({
          qualityMetrics: {
            sampleQueries: 2000,
            avgRankContribution: 0.3,
            uniqueHits: 500,
            correlationWithGoldStandard: 0.9,
          },
        }),
      );

      const result = await service.promoteModel('bge-base');
      expect(result.success).toBe(true);
    });
  });

  describe('getModelWeights', () => {
    it('should return weights for active and shadow models', async () => {
      (prisma.ensembleModelConfig.findMany as jest.Mock).mockResolvedValue([
        { modelId: 'bge-base', weight: 1.0 },
        { modelId: 'minilm', weight: 0.8 },
      ]);

      const result = await service.getModelWeights();
      expect(result).toEqual({ 'bge-base': 1.0, minilm: 0.8 });
    });
  });

  describe('clearCache', () => {
    it('should clear the in-memory cache', async () => {
      // Populate cache
      (prisma.ensembleModelConfig.findUnique as jest.Mock).mockResolvedValue(
        mockModel(),
      );
      await service.getModelConfig('bge-base');

      service.clearCache();

      // Next call should hit DB again
      await service.getModelConfig('bge-base');
      expect(prisma.ensembleModelConfig.findUnique).toHaveBeenCalledTimes(2);
    });
  });
});
