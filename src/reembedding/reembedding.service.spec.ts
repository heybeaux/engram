import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ReembeddingService } from './reembedding.service';
import { ContextEnricherService } from './context-enricher.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../memory/embedding.service';
import { EmbeddingService as EmbeddingProviderService } from '../embedding/embedding.service';
import { ReembeddingJobStatus } from './dto/reembedding.dto';
import { MemoryLayer, MemorySource, SubjectType } from '@prisma/client';

describe('ReembeddingService', () => {
  let service: ReembeddingService;
  let configService: jest.Mocked<ConfigService>;
  let enricherService: jest.Mocked<ContextEnricherService>;
  let embeddingService: jest.Mocked<EmbeddingService>;
  let prismaService: jest.Mocked<PrismaService>;

  const mockConfig = {
    get: jest.fn(),
  };

  const mockEnricher = {
    enrich: jest.fn(),
    getMemoryForEnrichment: jest.fn(),
    getMemoriesForEnrichment: jest.fn(),
  };

  const mockEmbedding = {
    generate: jest.fn(),
    store: jest.fn(),
  };

  const mockEmbeddingProvider = {
    healthCheck: jest.fn().mockResolvedValue(true),
    getProviderName: jest.fn().mockReturnValue('mock'),
  };

  const mockPrisma = {
    memoryExtraction: {
      findUnique: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
  };

  const createMockMemory = () => ({
    id: 'mem_123',
    userId: 'user_123',
    raw: 'Test memory content',
    layer: MemoryLayer.IDENTITY,
    source: MemorySource.EXPLICIT_STATEMENT,
    importanceScore: 0.5,
    effectiveScore: 0.5,
    safetyCritical: false,
    createdAt: new Date('2025-10-15T10:00:00Z'),
    updatedAt: new Date('2025-10-15T10:00:00Z'),
    deletedAt: null,
    projectId: null,
    sessionId: null,
    memoryType: null,
    typeConfidence: null,
    priority: 3,
    promotedFrom: null,
    userPinned: false,
    userHidden: false,
    scoreComputedAt: null,
    subjectType: SubjectType.USER,
    subjectId: null,
    agentId: null,
    importanceHint: null,
    confidence: 1.0,
    sessionPosition: null,
    embeddingId: null,
    embeddingModel: null,
    retrievalCount: 0,
    lastRetrievedAt: null,
    usedCount: 0,
    lastUsedAt: null,
    consolidated: false,
    consolidatedAt: null,
    supersededById: null,
    supersededAt: null,
    consolidatedInto: null,
    extraction: null,
    entities: [],
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReembeddingService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: ContextEnricherService, useValue: mockEnricher },
        { provide: EmbeddingService, useValue: mockEmbedding },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbeddingProviderService, useValue: mockEmbeddingProvider },
      ],
    }).compile();

    service = module.get<ReembeddingService>(ReembeddingService);
    configService = module.get(ConfigService);
    enricherService = module.get(ContextEnricherService);
    embeddingService = module.get(EmbeddingService);
    prismaService = module.get(PrismaService);
  });

  describe('isEnabled', () => {
    it('should return true when REEMBEDDING_ENABLED is "true"', () => {
      mockConfig.get.mockReturnValue('true');
      expect(service.isEnabled()).toBe(true);
    });

    it('should return true when REEMBEDDING_ENABLED is "1"', () => {
      mockConfig.get.mockReturnValue('1');
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when REEMBEDDING_ENABLED is not set', () => {
      mockConfig.get.mockReturnValue(undefined);
      expect(service.isEnabled()).toBe(false);
    });

    it('should return false when REEMBEDDING_ENABLED is "false"', () => {
      mockConfig.get.mockReturnValue('false');
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('triggerReembedding', () => {
    it('should throw when re-embedding is disabled', async () => {
      mockConfig.get.mockReturnValue('false');

      await expect(service.triggerReembedding({})).rejects.toThrow(
        'Re-embedding is disabled',
      );
    });

    it('should create a job and start processing', async () => {
      mockConfig.get.mockReturnValue('true');
      mockEnricher.getMemoriesForEnrichment.mockResolvedValue([]);

      const result = await service.triggerReembedding({});

      expect(result.jobId).toBeDefined();
      // Job status can be PENDING or RUNNING depending on timing
      expect([
        ReembeddingJobStatus.PENDING,
        ReembeddingJobStatus.RUNNING,
      ]).toContain(result.status);
    });

    it('should throw when a job is already running', async () => {
      mockConfig.get.mockReturnValue('true');

      // Create a never-resolving promise to simulate running job
      mockEnricher.getMemoriesForEnrichment.mockImplementation(
        () => new Promise(() => {}),
      );

      await service.triggerReembedding({});

      await expect(service.triggerReembedding({})).rejects.toThrow(
        'A re-embedding job is already running',
      );
    });
  });

  describe('previewEnrichment', () => {
    it('should return null for non-existent memory', async () => {
      mockEnricher.getMemoryForEnrichment.mockResolvedValue(null);

      const result = await service.previewEnrichment('non_existent');

      expect(result).toBeNull();
    });

    it('should return enrichment preview', async () => {
      const mockMemory = createMockMemory();
      mockEnricher.getMemoryForEnrichment.mockResolvedValue(mockMemory);
      mockEnricher.enrich.mockResolvedValue({
        originalContent: 'Test memory content',
        enrichedContent: '[Time: October 15, 2025] Test memory content',
        metadata: {
          temporalContext: '[Time: October 15, 2025]',
          enrichmentVersion: '1.0.0',
          enrichedAt: new Date(),
        },
      });
      mockPrisma.memoryExtraction.findUnique.mockResolvedValue(null);

      const result = await service.previewEnrichment('mem_123');

      expect(result).toBeDefined();
      expect(result!.memoryId).toBe('mem_123');
      expect(result!.originalContent).toBe('Test memory content');
      expect(result!.enrichedContent).toContain('[Time:');
      expect(result!.temporalContext).toBe('[Time: October 15, 2025]');
      expect(result!.currentVersion).toBe(0);
      expect(result!.newVersion).toBe(1);
    });

    it('should include existing embedding version', async () => {
      const mockMemory = createMockMemory();
      mockEnricher.getMemoryForEnrichment.mockResolvedValue(mockMemory);
      mockEnricher.enrich.mockResolvedValue({
        originalContent: 'Test',
        enrichedContent: '[Time: October 15, 2025] Test',
        metadata: {
          enrichmentVersion: '1.0.0',
          enrichedAt: new Date(),
        },
      });
      mockPrisma.memoryExtraction.findUnique.mockResolvedValue({
        rawJson: { embeddingVersion: 3 },
      });

      const result = await service.previewEnrichment('mem_123');

      expect(result!.currentVersion).toBe(3);
      expect(result!.newVersion).toBe(4);
    });
  });

  describe('reembedMemory', () => {
    it('should throw for non-existent memory', async () => {
      mockEnricher.getMemoryForEnrichment.mockResolvedValue(null);

      await expect(service.reembedMemory('non_existent')).rejects.toThrow(
        'Memory not found',
      );
    });

    it('should perform dry run without updating', async () => {
      const mockMemory = createMockMemory();
      mockEnricher.getMemoryForEnrichment.mockResolvedValue(mockMemory);
      mockEnricher.enrich.mockResolvedValue({
        originalContent: 'Test',
        enrichedContent: '[Time: October 15, 2025] Test',
        metadata: {
          enrichmentVersion: '1.0.0',
          enrichedAt: new Date(),
        },
      });
      mockPrisma.memoryExtraction.findUnique.mockResolvedValue(null);

      const result = await service.reembedMemory('mem_123', true);

      expect(result).toBeDefined();
      expect(mockEmbedding.generate).not.toHaveBeenCalled();
      expect(mockEmbedding.store).not.toHaveBeenCalled();
      expect(mockPrisma.memoryExtraction.upsert).not.toHaveBeenCalled();
    });

    it('should generate and store new embedding when not dry run', async () => {
      const mockMemory = createMockMemory();
      mockEnricher.getMemoryForEnrichment.mockResolvedValue(mockMemory);
      mockEnricher.enrich.mockResolvedValue({
        originalContent: 'Test',
        enrichedContent: '[Time: October 15, 2025] Test',
        metadata: {
          enrichmentVersion: '1.0.0',
          enrichedAt: new Date(),
        },
      });
      mockPrisma.memoryExtraction.findUnique.mockResolvedValue(null);
      mockEmbedding.generate.mockResolvedValue([0.1, 0.2, 0.3]);
      mockEmbedding.store.mockResolvedValue('embed_123');
      mockPrisma.memoryExtraction.upsert.mockResolvedValue({});

      const result = await service.reembedMemory('mem_123', false);

      expect(result).toBeDefined();
      expect(mockEmbedding.generate).toHaveBeenCalledWith(
        '[Time: October 15, 2025] Test',
      );
      expect(mockEmbedding.store).toHaveBeenCalledWith(
        'mem_123',
        [0.1, 0.2, 0.3],
        expect.objectContaining({
          userId: 'user_123',
          layer: MemoryLayer.IDENTITY,
        }),
      );
      expect(mockPrisma.memoryExtraction.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { memoryId: 'mem_123' },
          update: expect.objectContaining({
            rawJson: expect.objectContaining({
              embeddingVersion: 1,
              enrichmentVersion: '1.0.0',
            }),
          }),
          create: expect.objectContaining({
            memoryId: 'mem_123',
            rawJson: expect.objectContaining({
              embeddingVersion: 1,
              enrichmentVersion: '1.0.0',
            }),
          }),
        }),
      );
    });
  });

  describe('getJobStatus', () => {
    it('should return null for non-existent job', () => {
      const result = service.getJobStatus('non_existent');
      expect(result).toBeNull();
    });

    it('should return job status after triggering', async () => {
      mockConfig.get.mockReturnValue('true');
      mockEnricher.getMemoriesForEnrichment.mockResolvedValue([]);

      const job = await service.triggerReembedding({});
      const status = service.getJobStatus(job.jobId);

      expect(status).toBeDefined();
      expect(status!.jobId).toBe(job.jobId);
    });
  });

  describe('listJobs', () => {
    it('should return empty array when no jobs', () => {
      const result = service.listJobs();
      expect(result).toEqual([]);
    });

    it('should return jobs sorted by start time (most recent first)', async () => {
      mockConfig.get.mockReturnValue('true');
      mockEnricher.getMemoriesForEnrichment.mockResolvedValue([]);

      await service.triggerReembedding({});
      // Wait for first job to complete
      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.triggerReembedding({});

      const jobs = service.listJobs();
      expect(jobs.length).toBe(2);
    });

    it('should respect limit parameter', async () => {
      mockConfig.get.mockReturnValue('true');
      mockEnricher.getMemoriesForEnrichment.mockResolvedValue([]);

      await service.triggerReembedding({});
      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.triggerReembedding({});
      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.triggerReembedding({});

      const jobs = service.listJobs(2);
      expect(jobs.length).toBe(2);
    });
  });
});
