import { Test, TestingModule } from '@nestjs/testing';
import { EmbeddingQueueProcessor } from './embedding-queue.processor';
import { MemoryPipelineService } from './memory-pipeline.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { MemoryDedupService } from './memory-dedup.service';
import { MemoryLayer, MemorySource } from '@prisma/client';
import { Job } from 'bullmq';
import { EmbedMemoryJobData } from './embedding.queue';
import { EMBEDDING_QUEUE } from './embedding.queue';

describe('EmbeddingQueueProcessor', () => {
  it('should register with concurrency 2', () => {
    const processorMeta = Reflect.getMetadata(
      'bullmq:processor_metadata',
      EmbeddingQueueProcessor,
    );
    expect(processorMeta).toBeDefined();
    expect(processorMeta.name).toBe(EMBEDDING_QUEUE);

    const workerMeta = Reflect.getMetadata(
      'bullmq:worker_metadata',
      EmbeddingQueueProcessor,
    );
    expect(workerMeta).toBeDefined();
    expect(workerMeta.concurrency).toBe(2);
  });
  let processor: EmbeddingQueueProcessor;
  let mockPipeline: jest.Mocked<Partial<MemoryPipelineService>>;
  let mockPrisma: any;
  let mockDedupService: jest.Mocked<Partial<MemoryDedupService>>;

  const baseMemory = {
    id: 'mem-123',
    embeddingStatus: 'PENDING',
    deletedAt: null,
    layer: MemoryLayer.SESSION,
    source: MemorySource.EXPLICIT_STATEMENT,
    sessionId: null,
  };

  function makeJob(data: Partial<EmbedMemoryJobData>): Job<EmbedMemoryJobData> {
    return {
      data: {
        memoryId: 'mem-123',
        userId: 'user-456',
        raw: 'Test content',
        runDedup: true,
        ...data,
      },
    } as Job<EmbedMemoryJobData>;
  }

  beforeEach(async () => {
    mockPipeline = {
      extractAndEmbed: jest.fn().mockResolvedValue(undefined),
    };

    mockPrisma = {
      memory: {
        findUnique: jest.fn().mockResolvedValue(baseMemory),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    mockDedupService = {
      findDuplicateV2: jest.fn().mockResolvedValue({ action: 'create' }),
      autoMergeMemory: jest.fn().mockResolvedValue(undefined),
      reinforceMemory: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbeddingQueueProcessor,
        { provide: MemoryPipelineService, useValue: mockPipeline },
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: MemoryDedupService, useValue: mockDedupService },
      ],
    }).compile();

    processor = module.get<EmbeddingQueueProcessor>(EmbeddingQueueProcessor);
  });

  describe('process', () => {
    it('should call extractAndEmbed for a PENDING memory', async () => {
      await processor.process(makeJob({}));

      expect(mockPipeline.extractAndEmbed).toHaveBeenCalledWith(
        'mem-123',
        'Test content',
        'user-456',
      );
    });

    it('should skip already-COMPLETE memory', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        ...baseMemory,
        embeddingStatus: 'COMPLETE',
      });

      await processor.process(makeJob({}));

      expect(mockPipeline.extractAndEmbed).not.toHaveBeenCalled();
    });

    it('should skip already-DUPLICATE memory', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        ...baseMemory,
        embeddingStatus: 'DUPLICATE',
      });

      await processor.process(makeJob({}));

      expect(mockPipeline.extractAndEmbed).not.toHaveBeenCalled();
    });

    it('should skip deleted memory', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        ...baseMemory,
        deletedAt: new Date(),
      });

      await processor.process(makeJob({}));

      expect(mockPipeline.extractAndEmbed).not.toHaveBeenCalled();
    });

    it('should mark memory as FAILED and rethrow on pipeline error', async () => {
      const error = new Error('Embedding API down');
      (mockPipeline.extractAndEmbed as jest.Mock).mockRejectedValue(error);

      await expect(processor.process(makeJob({}))).rejects.toThrow(
        'Embedding API down',
      );

      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        data: { embeddingStatus: 'FAILED' },
      });
    });

    it('should not run dedup when runDedup is false', async () => {
      await processor.process(makeJob({ runDedup: false }));

      expect(mockDedupService.findDuplicateV2).not.toHaveBeenCalled();
    });

    it('should not run dedup when runDedup is undefined', async () => {
      await processor.process(makeJob({ runDedup: undefined }));

      expect(mockDedupService.findDuplicateV2).not.toHaveBeenCalled();
    });
  });

  describe('dedup (runDedup=true)', () => {
    it('should call findDuplicateV2 after successful embedding', async () => {
      await processor.process(makeJob({ runDedup: true }));

      expect(mockDedupService.findDuplicateV2).toHaveBeenCalledWith(
        'user-456',
        'Test content',
        undefined, // SESSION layer uses default threshold
      );
    });

    it('should use INSIGHT threshold for INSIGHT layer memories', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        ...baseMemory,
        layer: MemoryLayer.INSIGHT,
      });

      await processor.process(makeJob({ runDedup: true }));

      expect(mockDedupService.findDuplicateV2).toHaveBeenCalledWith(
        'user-456',
        'Test content',
        0.92, // INSIGHT_DEDUP_THRESHOLD
      );
    });

    it('should mark memory as DUPLICATE and set isDuplicateOf on merged duplicate', async () => {
      const existingMemory = {
        id: 'mem-existing',
        raw: 'Existing content',
      } as any;
      (mockDedupService.findDuplicateV2 as jest.Mock).mockResolvedValue({
        action: 'merged',
        existingMemory,
        similarityScore: 0.95,
      });

      await processor.process(makeJob({ runDedup: true }));

      expect(mockDedupService.autoMergeMemory).toHaveBeenCalledWith(
        'mem-existing',
        'Test content',
        MemorySource.EXPLICIT_STATEMENT,
      );
      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        data: {
          embeddingStatus: 'DUPLICATE',
          isDuplicateOf: 'mem-existing',
        },
      });
    });

    it('should mark memory as DUPLICATE and set isDuplicateOf on reinforced duplicate', async () => {
      const existingMemory = {
        id: 'mem-existing',
        raw: 'Existing content',
      } as any;
      (mockDedupService.findDuplicateV2 as jest.Mock).mockResolvedValue({
        action: 'reinforced',
        existingMemory,
        similarityScore: 0.87,
      });

      await processor.process(makeJob({ runDedup: true }));

      expect(mockDedupService.reinforceMemory).toHaveBeenCalledWith(
        'mem-existing',
        undefined, // sessionId is null → undefined
      );
      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        data: {
          embeddingStatus: 'DUPLICATE',
          isDuplicateOf: 'mem-existing',
        },
      });
    });

    it('should leave memory as COMPLETE (not update) when no duplicate found', async () => {
      (mockDedupService.findDuplicateV2 as jest.Mock).mockResolvedValue({
        action: 'create',
      });

      await processor.process(makeJob({ runDedup: true }));

      // Should NOT call update with DUPLICATE status
      expect(mockPrisma.memory.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ embeddingStatus: 'DUPLICATE' }),
        }),
      );
    });

    it('should not throw when dedup fails — embedding success is preserved', async () => {
      (mockDedupService.findDuplicateV2 as jest.Mock).mockRejectedValue(
        new Error('Dedup service unavailable'),
      );

      // Should NOT throw — dedup failure is non-fatal
      await expect(
        processor.process(makeJob({ runDedup: true })),
      ).resolves.toBeUndefined();

      // extractAndEmbed was still called
      expect(mockPipeline.extractAndEmbed).toHaveBeenCalled();
    });
  });
});
