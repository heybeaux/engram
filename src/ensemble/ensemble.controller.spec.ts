import { BadRequestException } from '@nestjs/common';
import { EnsembleController } from './ensemble.controller';
import { EnsembleService } from './ensemble.service';
import { NightlyReembedService } from './nightly-reembed.service';
import { DriftDetectionService } from './drift-detection.service';
import { DriftAnalysisJobService } from './drift-analysis-job.service';
import { PrismaService } from '../prisma/prisma.service';

describe('EnsembleController', () => {
  let controller: EnsembleController;
  let ensembleService: jest.Mocked<EnsembleService>;
  let nightlyReembedService: jest.Mocked<NightlyReembedService>;
  let driftDetectionService: jest.Mocked<DriftDetectionService>;
  let driftAnalysisJobService: jest.Mocked<DriftAnalysisJobService>;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(() => {
    ensembleService = {
      isEnabled: jest.fn().mockReturnValue(true),
      getConfig: jest.fn().mockReturnValue({
        models: ['text-embedding-3-small', 'nomic-embed-text-v1.5'],
        fusionMethod: 'rrf',
        k: 60,
      }),
      query: jest.fn(),
      upsert: jest.fn(),
      compare: jest.fn(),
      embedAll: jest.fn(),
      getModels: jest.fn(),
      getCoverage: jest.fn(),
      getMemoryEmbeddings: jest.fn(),
      getABTestResults: jest.fn(),
      embedBatchForMemories: jest.fn(),
    } as any;

    nightlyReembedService = {
      startManualJob: jest.fn(),
      getActiveJobStatus: jest.fn(),
    } as any;

    driftDetectionService = {
      getThresholds: jest.fn().mockReturnValue({ drift: 0.1, alert: 0.2 }),
      measureBatchDrift: jest.fn(),
      summarizeDrift: jest.fn(),
    } as any;

    driftAnalysisJobService = {
      enqueue: jest.fn(),
      getStatus: jest.fn(),
      getStatusOrThrow: jest.fn(),
      analyzeNow: jest.fn(),
    } as any;

    prisma = {
      $queryRawUnsafe: jest.fn(),
      driftSnapshot: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
      memory: {
        findMany: jest.fn(),
      },
    } as any;

    controller = new EnsembleController(
      ensembleService,
      nightlyReembedService,
      driftDetectionService,
      driftAnalysisJobService,
      prisma,
    );
  });

  // =========================================================================
  // getStatus
  // =========================================================================
  describe('getStatus', () => {
    it('should return ensemble status and config', () => {
      const result = controller.getStatus();
      expect(result.enabled).toBe(true);
      expect(result.models).toEqual([
        'text-embedding-3-small',
        'nomic-embed-text-v1.5',
      ]);
      expect(result.config).toBeDefined();
    });

    it('should return disabled when ensemble is off', () => {
      ensembleService.isEnabled.mockReturnValue(false);
      const result = controller.getStatus();
      expect(result.enabled).toBe(false);
    });
  });

  // =========================================================================
  // query
  // =========================================================================
  describe('query', () => {
    const dto = { query: 'test query', userId: 'user-1', limit: 10 };

    it('should return fused query results with serialized modelScores', async () => {
      const modelScores = new Map([
        ['text-embedding-3-small', { rank: 1, score: 0.95 }],
      ]);
      ensembleService.query.mockResolvedValue({
        results: [{ memoryId: 'm1', fusedScore: 0.9, modelScores }],
        totalMs: 50,
        modelsUsed: ['text-embedding-3-small'],
      } as any);

      const result = await controller.query(dto as any);
      expect(result.results[0].modelScores).toEqual({
        'text-embedding-3-small': { rank: 1, score: 0.95 },
      });
    });

    it('should throw BadRequestException when ensemble is disabled', async () => {
      ensembleService.isEnabled.mockReturnValue(false);
      await expect(controller.query(dto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when query is missing', async () => {
      await expect(controller.query({ userId: 'u1' } as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when userId is missing', async () => {
      await expect(controller.query({ query: 'q' } as any)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // =========================================================================
  // upsert
  // =========================================================================
  describe('upsert', () => {
    const dto = { memoryId: 'm1', content: 'hello', userId: 'u1' };

    it('should upsert and return success', async () => {
      ensembleService.upsert.mockResolvedValue(undefined);
      const result = await controller.upsert(dto as any);
      expect(result).toEqual({ success: true });
      expect(ensembleService.upsert).toHaveBeenCalledWith({
        memoryId: 'm1',
        content: 'hello',
        userId: 'u1',
        metadata: undefined,
      });
    });

    it('should throw when ensemble is disabled', async () => {
      ensembleService.isEnabled.mockReturnValue(false);
      await expect(controller.upsert(dto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw when required fields are missing', async () => {
      await expect(
        controller.upsert({ memoryId: 'm1' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // compare
  // =========================================================================
  describe('compare', () => {
    it('should throw when ensemble is disabled', async () => {
      ensembleService.isEnabled.mockReturnValue(false);
      await expect(
        controller.compare({ query: 'q', userId: 'u' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when query/userId missing', async () => {
      await expect(controller.compare({} as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return comparison results', async () => {
      const modelScores = new Map([
        ['text-embedding-3-small', { rank: 1, score: 0.9 }],
      ]);
      const singleModel = new Map([
        ['text-embedding-3-small', [{ memoryId: 'm1', rank: 1, score: 0.9 }]],
      ]);
      ensembleService.compare.mockResolvedValue({
        ensemble: {
          results: [{ memoryId: 'm1', fusedScore: 0.9, modelScores }],
          totalMs: 20,
          modelsUsed: ['text-embedding-3-small'],
        },
        singleModel,
      } as any);

      const result = await controller.compare({
        query: 'q',
        userId: 'u',
      } as any);
      expect(result.ensemble.results).toHaveLength(1);
      expect(result.singleModel['text-embedding-3-small']).toHaveLength(1);
    });
  });

  // =========================================================================
  // embed
  // =========================================================================
  describe('embed', () => {
    it('should throw when text is missing', async () => {
      await expect(controller.embed({} as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return embeddings without vectors', async () => {
      ensembleService.embedAll.mockResolvedValue({
        embeddings: [
          {
            model: 'text-embedding-3-small',
            dimensions: 1536,
            latencyMs: 10,
            embedding: [0.1],
          },
        ],
        totalMs: 10,
      } as any);

      const result = await controller.embed({ text: 'hello' });
      expect(result.embeddings[0]).not.toHaveProperty('embedding');
      expect(result.embeddings[0].dimensions).toBe(1536);
    });
  });

  // =========================================================================
  // reembed
  // =========================================================================
  describe('triggerReembed', () => {
    it('should start incremental reembed by default', async () => {
      nightlyReembedService.startManualJob.mockResolvedValue('job-1');
      const result = await controller.triggerReembed({} as any);
      expect(result.jobId).toBe('job-1');
      expect(nightlyReembedService.startManualJob).toHaveBeenCalledWith({
        mode: 'incremental',
        models: undefined,
        memoryIds: undefined,
      });
    });

    it('should pass full mode when specified', async () => {
      nightlyReembedService.startManualJob.mockResolvedValue('job-2');
      await controller.triggerReembed({ mode: 'full' } as any);
      expect(nightlyReembedService.startManualJob).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'full' }),
      );
    });
  });

  // =========================================================================
  // targetedReembed
  // =========================================================================
  describe('targetedReembed', () => {
    it('should throw when memoryIds is empty', async () => {
      await expect(
        controller.targetedReembed({ memoryIds: [], models: ['m1'] } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when models is empty', async () => {
      await expect(
        controller.targetedReembed({ memoryIds: ['m1'], models: [] } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return job info for valid request', async () => {
      const result = await controller.targetedReembed({
        memoryIds: ['m1', 'm2'],
        models: ['text-embedding-3-small'],
      } as any);
      expect(result.total).toBe(2);
      expect(result.jobId).toContain('targeted-');
    });
  });

  // =========================================================================
  // drift endpoints
  // =========================================================================
  describe('getLatestDrift', () => {
    it('should return per-model drift data', async () => {
      (prisma.driftSnapshot.findMany as jest.Mock).mockResolvedValue([
        { modelId: 'model-a' },
      ]);
      (prisma.driftSnapshot.findFirst as jest.Mock).mockResolvedValue({
        modelId: 'model-a',
        avgDrift: 0.05,
        maxDrift: 0.12,
        sampleCount: 100,
        alertLevel: 'normal',
        createdAt: new Date(),
      });

      const result = await controller.getLatestDrift({ accountId: 'acc-123' });
      expect(prisma.driftSnapshot.findMany).toHaveBeenCalledWith({
        where: { accountId: 'acc-123' },
        distinct: ['modelId'],
        select: { modelId: true },
        orderBy: { modelId: 'asc' },
      });
      expect(prisma.driftSnapshot.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { accountId: 'acc-123', modelId: 'model-a' },
        }),
      );
      expect(result.perModel).toHaveLength(1);
      expect(result.perModel[0].modelId).toBe('model-a');
      expect(result.thresholds).toEqual({ drift: 0.1, alert: 0.2 });
    });

    it('should handle no models', async () => {
      (prisma.driftSnapshot.findMany as jest.Mock).mockResolvedValue([]);
      const result = await controller.getLatestDrift({ accountId: 'acc-123' });
      expect(result.perModel).toHaveLength(0);
    });
  });

  describe('getDriftHistory', () => {
    it('should return drift snapshots', async () => {
      (prisma.driftSnapshot.findMany as jest.Mock).mockResolvedValue([
        {
          id: '1',
          modelId: 'model-a',
          avgDrift: 0.05,
          maxDrift: 0.1,
          sampleCount: 50,
          alertLevel: 'normal',
          createdAt: new Date(),
        },
      ]);

      const result = await controller.getDriftHistory();
      expect(result.snapshots).toHaveLength(1);
      expect(result.count).toBe(1);
    });

    it('should filter by modelId and since', async () => {
      (prisma.driftSnapshot.findMany as jest.Mock).mockResolvedValue([]);
      await controller.getDriftHistory('model-a', '10', '2026-01-01', {
        accountId: 'acc-123',
      });
      expect(prisma.driftSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            accountId: 'acc-123',
            modelId: 'model-a',
            createdAt: { gte: expect.any(Date) },
          },
          take: 10,
        }),
      );
    });
  });

  describe('analyzeDrift', () => {
    it('should queue a drift analysis job for the authenticated account', () => {
      driftAnalysisJobService.enqueue.mockReturnValue({
        jobId: 'drift-job-1',
        status: 'queued',
        createdAt: new Date(),
        progress: { current: 0, total: 0, message: 'Queued drift analysis' },
      });

      const result = controller.analyzeDrift({ accountId: 'acc-123' });

      expect(driftAnalysisJobService.enqueue).toHaveBeenCalledWith('acc-123');
      expect(result.jobId).toBe('drift-job-1');
      expect(result.status).toBe('queued');
    });

    it('should dedupe to the active job returned by the job service', () => {
      driftAnalysisJobService.enqueue.mockReturnValue({
        jobId: 'drift-existing',
        status: 'running',
        createdAt: new Date(),
        startedAt: new Date(),
        progress: { current: 1, total: 2, message: 'Analyzing drift' },
      });

      const result = controller.analyzeDrift({ accountId: 'acc-123' });

      expect(result.jobId).toBe('drift-existing');
      expect(result.status).toBe('running');
    });

    it('should allow LAN/global queueing when no accountId is present', () => {
      driftAnalysisJobService.enqueue.mockReturnValue({
        jobId: 'drift-global',
        status: 'queued',
        createdAt: new Date(),
        progress: { current: 0, total: 0 },
      });

      controller.analyzeDrift({});

      expect(driftAnalysisJobService.enqueue).toHaveBeenCalledWith(null);
    });
  });

  describe('getDriftAnalyzeJob', () => {
    it('should return drift analysis job status', () => {
      driftAnalysisJobService.getStatusOrThrow.mockReturnValue({
        jobId: 'drift-job-1',
        status: 'succeeded',
        createdAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
        progress: { current: 1, total: 1, message: 'done' },
        snapshots: [
          {
            modelId: 'model-a',
            avgDrift: 0.05,
            maxDrift: 0.08,
            sampleCount: 1,
            alertLevel: 'normal',
          },
        ],
        summary: 'All models within normal drift range',
      });

      const result = controller.getDriftAnalyzeJob('drift-job-1', {
        accountId: 'acc-123',
      });

      expect(driftAnalysisJobService.getStatusOrThrow).toHaveBeenCalledWith(
        'drift-job-1',
        'acc-123',
      );
      expect(result.status).toBe('succeeded');
      expect(result.summary).toContain('normal');
    });
  });

  // =========================================================================
  // coverage & models
  // =========================================================================
  describe('getCoverage', () => {
    it('should transform perModel to array format', async () => {
      ensembleService.getCoverage.mockResolvedValue({
        totalMemories: 100,
        memoriesWithAllModels: 80,
        coveragePercent: 80,
        perModel: {
          'text-embedding-3-small': { embeddingCount: 90, coveragePercent: 90 },
        },
      } as any);

      const result = await controller.getCoverage();
      expect(result.perModel).toEqual([
        expect.objectContaining({
          model: 'text-embedding-3-small',
          embeddedCount: 90,
        }),
      ]);
      expect(result.fullCoveragePercentage).toBe(80);
    });
  });

  describe('getMemoryEmbeddings', () => {
    it('should throw when memoryId is empty', async () => {
      await expect(controller.getMemoryEmbeddings('')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return embedding status', async () => {
      ensembleService.getMemoryEmbeddings.mockResolvedValue([
        { model: 'model-a', exists: true, dimensions: 1536 },
      ] as any);

      const result = await controller.getMemoryEmbeddings('m1');
      expect(result.memoryId).toBe('m1');
      expect(result.embeddings).toHaveLength(1);
    });
  });

  describe('getABTestResults', () => {
    it('should return results with default limit', async () => {
      ensembleService.getABTestResults.mockResolvedValue([]);
      const result = await controller.getABTestResults();
      expect(result.count).toBe(0);
      expect(ensembleService.getABTestResults).toHaveBeenCalledWith(
        undefined,
        100,
      );
    });

    it('should parse limit string', async () => {
      ensembleService.getABTestResults.mockResolvedValue([]);
      await controller.getABTestResults('test-1', '5');
      expect(ensembleService.getABTestResults).toHaveBeenCalledWith(
        'test-1',
        5,
      );
    });
  });
});
