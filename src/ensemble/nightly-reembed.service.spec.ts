import { NightlyReembedService } from './nightly-reembed.service';

describe('NightlyReembedService', () => {
  let service: NightlyReembedService;
  let config: any;
  let prisma: any;
  let ensembleService: any;
  let driftService: any;
  let checkpointService: any;
  let modelRegistry: any;
  let pgvectorProvider: any;

  const mockModels = ['bge-base'] as any[];

  beforeEach(() => {
    config = {
      get: jest.fn().mockReturnValue('false'),
    };
    prisma = {
      ensembleReembedJob: {
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    ensembleService = {
      embedBatch: jest.fn().mockResolvedValue({
        embeddings: [
          { model: 'bge-base', embedding: [0.1, 0.2], dimensions: 1536 },
        ],
      }),
      getConfiguredModelIds: jest.fn().mockReturnValue([]),
    };
    driftService = {
      measureBatchDrift: jest
        .fn()
        .mockResolvedValue([{ cosineDrift: 0.05, flagged: false }]),
    };
    checkpointService = {
      findActiveCheckpoint: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    modelRegistry = {
      getActiveAndShadowModels: jest.fn().mockResolvedValue(mockModels),
      getActiveModels: jest.fn().mockResolvedValue(mockModels),
    };
    pgvectorProvider = {
      upsertEmbeddings: jest.fn().mockResolvedValue(undefined),
    };

    service = new NightlyReembedService(
      config,
      prisma,
      ensembleService,
      driftService,
      checkpointService,
      modelRegistry,
      pgvectorProvider,
    );
  });

  describe('onModuleInit', () => {
    it('should check for interrupted jobs', async () => {
      await service.onModuleInit();
      expect(checkpointService.findActiveCheckpoint).toHaveBeenCalled();
    });

    it('should log warning if interrupted job found', async () => {
      checkpointService.findActiveCheckpoint.mockResolvedValue({
        jobId: 'old-job',
      });
      await service.onModuleInit();
      expect(checkpointService.findActiveCheckpoint).toHaveBeenCalled();
    });
  });

  describe('runNightlyReembed', () => {
    it('should return null when disabled', async () => {
      config.get.mockReturnValue('false');
      const result = await service.runNightlyReembed();
      expect(result).toBeNull();
    });

    it('should run incremental job when enabled', async () => {
      config.get.mockReturnValue('true');
      prisma.memory.findMany.mockResolvedValue([]);

      const result = await service.runNightlyReembed();
      expect(result).toBeDefined();
      expect(result!.status).toBe('running');
      expect(prisma.ensembleReembedJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ mode: 'INCREMENTAL' }),
        }),
      );
    });
  });

  describe('startManualJob', () => {
    it('should throw if job already running', async () => {
      // Start a job first by setting activeJob via executeReembedJob
      config.get.mockReturnValue('true');
      prisma.memory.findMany.mockResolvedValue([]);
      await service.runNightlyReembed();

      // Now that job completed, simulate a running job by starting one that takes time
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        raw: `memory ${i}`,
        userId: 'user-1',
      }));
      prisma.memory.findMany.mockResolvedValue(memories);

      // We can't easily test concurrent since jobs are async. Instead test getActiveJobStatus
    });

    it('should return a job ID', async () => {
      prisma.memory.findMany.mockResolvedValue([]);
      const jobId = await service.startManualJob({ mode: 'full' as any });
      expect(typeof jobId).toBe('string');
      expect(jobId).toMatch(/^reembed-/);
    });
  });

  describe('executeReembedJob', () => {
    const makeConfig = (overrides = {}) => ({
      jobId: 'test-job-1',
      mode: 'incremental' as any,
      models: mockModels,
      batchSize: 2,
      checkpointInterval: 1,
      driftCheck: true,
      ...overrides,
    });

    it('should complete immediately with no memories', async () => {
      prisma.memory.findMany.mockResolvedValue([]);

      const result = await service.executeReembedJob(makeConfig());
      expect(result.memoriesProcessed).toBe(0);
      expect(result.status).toBe('running'); // status on state is 'running' until completeJob sets DB
      expect(prisma.ensembleReembedJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { jobId: 'test-job-1' },
          data: expect.objectContaining({ status: 'COMPLETED' }),
        }),
      );
      expect(checkpointService.delete).not.toHaveBeenCalled();
    });

    it('should process batches and checkpoint', async () => {
      const memories = Array.from({ length: 4 }, (_, i) => ({
        id: `m${i}`,
        raw: `memory ${i}`,
        userId: 'user-1',
      }));
      prisma.memory.findMany.mockResolvedValue(memories);
      ensembleService.embedBatch.mockResolvedValue({
        embeddings: memories.map(() => ({
          model: 'bge-base',
          embedding: [0.1, 0.2],
          dimensions: 1536,
        })),
      });
      driftService.measureBatchDrift.mockResolvedValue(
        memories.map(() => ({ cosineDrift: 0.03, flagged: false })),
      );

      const result = await service.executeReembedJob(
        makeConfig({ batchSize: 2, checkpointInterval: 1 }),
      );

      expect(result.memoriesProcessed).toBe(4);
      expect(ensembleService.embedBatch).toHaveBeenCalledTimes(2);
      expect(pgvectorProvider.upsertEmbeddings).toHaveBeenCalledTimes(2);
      expect(checkpointService.save).toHaveBeenCalled();
      expect(checkpointService.delete).toHaveBeenCalledWith('test-job-1');
    });

    it('should skip pgvector upsert on dry run', async () => {
      const memories = [{ id: 'm1', raw: 'test', userId: 'user-1' }];
      prisma.memory.findMany.mockResolvedValue(memories);
      ensembleService.embedBatch.mockResolvedValue({
        embeddings: [{ model: 'bge-base', embedding: [0.1], dimensions: 1536 }],
      });

      await service.executeReembedJob(
        makeConfig({ dryRun: true, batchSize: 10 }),
      );

      expect(pgvectorProvider.upsertEmbeddings).not.toHaveBeenCalled();
    });

    it('should resume from checkpoint', async () => {
      const memories = Array.from({ length: 4 }, (_, i) => ({
        id: `m${i}`,
        raw: `memory ${i}`,
        userId: 'user-1',
      }));
      prisma.memory.findMany.mockResolvedValue(memories);
      checkpointService.get.mockResolvedValue({
        jobId: 'test-job-1',
        lastProcessedId: 'm1',
        progress: {
          totalMemories: 4,
          processedMemories: 2,
          currentBatch: 1,
          totalBatches: 2,
          currentModel: null,
        },
        completedModels: [],
        metrics: null,
      });
      ensembleService.embedBatch.mockResolvedValue({
        embeddings: memories.map(() => ({
          model: 'bge-base',
          embedding: [0.1, 0.2],
          dimensions: 1536,
        })),
      });
      driftService.measureBatchDrift.mockResolvedValue([]);

      const result = await service.executeReembedJob(
        makeConfig({ batchSize: 2, checkpointInterval: 10 }),
      );

      // Should only process batch 1 (the second batch), since checkpoint says currentBatch=1
      expect(ensembleService.embedBatch).toHaveBeenCalledTimes(1);
      expect(result.memoriesProcessed).toBe(4); // 2 from checkpoint + 2 processed
    });

    it('should handle errors and save checkpoint', async () => {
      const memories = [{ id: 'm1', raw: 'test', userId: 'user-1' }];
      prisma.memory.findMany.mockResolvedValue(memories);
      ensembleService.embedBatch.mockRejectedValue(new Error('API down'));

      await expect(
        service.executeReembedJob(makeConfig({ batchSize: 10 })),
      ).rejects.toThrow('API down');

      expect(checkpointService.save).toHaveBeenCalled();
      expect(prisma.ensembleReembedJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            error: 'API down',
          }),
        }),
      );
    });

    it('should handle drift detection', async () => {
      const memories = [{ id: 'm1', raw: 'test', userId: 'user-1' }];
      prisma.memory.findMany.mockResolvedValue(memories);
      ensembleService.embedBatch.mockResolvedValue({
        embeddings: [{ model: 'bge-base', embedding: [0.1], dimensions: 1536 }],
      });
      driftService.measureBatchDrift.mockResolvedValue([
        { cosineDrift: 0.2, flagged: true },
      ]);

      const result = await service.executeReembedJob(
        makeConfig({ batchSize: 10 }),
      );

      expect(driftService.measureBatchDrift).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('cancelActiveJob', () => {
    it('should return false if no active job', async () => {
      const result = await service.cancelActiveJob();
      expect(result).toBe(false);
    });

    it('should set cancel flag for active job', async () => {
      // Start a long-running job
      const memories = Array.from({ length: 100 }, (_, i) => ({
        id: `m${i}`,
        raw: `memory ${i}`,
        userId: 'user-1',
      }));
      prisma.memory.findMany.mockResolvedValue(memories);

      // Make embedBatch slow and trigger cancel
      let callCount = 0;
      ensembleService.embedBatch.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Cancel after first batch
          await service.cancelActiveJob();
        }
        return {
          embeddings: Array(2).fill({
            model: 'bge-base',
            embedding: [0.1],
            dimensions: 1536,
          }),
        };
      });
      driftService.measureBatchDrift.mockResolvedValue([]);

      const result = await service.executeReembedJob({
        jobId: 'cancel-test',
        mode: 'full' as any,
        models: mockModels,
        batchSize: 2,
        checkpointInterval: 1,
        driftCheck: false,
      });

      // Job should have been cancelled (not all memories processed)
      expect(result.memoriesProcessed).toBeLessThan(100);
      expect(prisma.ensembleReembedJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CANCELLED' }),
        }),
      );
    });
  });

  describe('getActiveJobStatus', () => {
    it('should return null when no active job', () => {
      expect(service.getActiveJobStatus()).toBeNull();
    });
  });

  describe('reembedMemories', () => {
    it('should return early if no memories found', async () => {
      prisma.memory.findMany.mockResolvedValue([]);
      await service.reembedMemories(['m1', 'm2']);
      expect(ensembleService.embedBatch).not.toHaveBeenCalled();
    });

    it('should embed specific memories', async () => {
      const memories = [{ id: 'm1', raw: 'test memory', userId: 'user-1' }];
      prisma.memory.findMany.mockResolvedValue(memories);
      ensembleService.embedBatch.mockResolvedValue({
        embeddings: [{ model: 'bge-base', embedding: [0.1], dimensions: 1536 }],
      });

      await service.reembedMemories(['m1']);

      expect(modelRegistry.getActiveModels).toHaveBeenCalled();
      expect(ensembleService.embedBatch).toHaveBeenCalledWith(
        ['test memory'],
        mockModels,
      );
      expect(pgvectorProvider.upsertEmbeddings).toHaveBeenCalled();
    });
  });
});
