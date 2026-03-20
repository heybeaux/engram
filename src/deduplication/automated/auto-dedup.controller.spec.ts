import { Test, TestingModule } from '@nestjs/testing';
import { AutoDedupController } from './auto-dedup.controller';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { DedupPipelineService } from './dedup-pipeline.service';
import { ApiKeyOrJwtGuard } from '../../common/guards/api-key-or-jwt.guard';

const mockMemory1 = {
  id: 'mem-1',
  raw: 'Memory one content',
  importanceScore: 0.8,
};
const mockMemory2 = {
  id: 'mem-2',
  raw: 'Memory two content',
  importanceScore: 0.7,
};

const mockCandidate = {
  id: 'candidate-1',
  status: 'CLASSIFIED',
  classification: 'DUPLICATE',
  classifiedAt: new Date('2026-03-12T00:00:00Z'),
  resolvedAt: null,
  reasoning: null,
  memory1: mockMemory1,
  memory2: mockMemory2,
};

const mockPrisma = {
  dedupCandidate: {
    findMany: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
  },
};

const mockPipeline = {
  runPipeline: jest.fn(),
};

describe('AutoDedupController', () => {
  let controller: AutoDedupController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AutoDedupController],
      providers: [
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: DedupPipelineService, useValue: mockPipeline },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AutoDedupController>(AutoDedupController);
  });

  // ─── getReviewQueue ───────────────────────────────────────────────────────

  describe('getReviewQueue()', () => {
    it('should return candidates needing review with default limit of 20', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([mockCandidate]);

      const result = await controller.getReviewQueue();

      expect(mockPrisma.dedupCandidate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'CLASSIFIED',
            classification: { notIn: ['RELATED'] },
          },
          take: 20,
        }),
      );
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should respect custom limit parameter', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([]);

      await controller.getReviewQueue('5');

      expect(mockPrisma.dedupCandidate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it('should include memory details in results', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([mockCandidate]);

      const result = await controller.getReviewQueue();

      expect(mockPrisma.dedupCandidate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            memory1: { select: { id: true, raw: true, importanceScore: true } },
            memory2: { select: { id: true, raw: true, importanceScore: true } },
          },
        }),
      );
      expect(result.items[0].memory1.id).toBe('mem-1');
    });

    it('should return empty queue when no candidates pending review', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([]);

      const result = await controller.getReviewQueue();
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should order results by classifiedAt ascending (oldest first)', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([mockCandidate]);

      await controller.getReviewQueue();

      expect(mockPrisma.dedupCandidate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { classifiedAt: 'asc' } }),
      );
    });
  });

  // ─── resolveCandidate ─────────────────────────────────────────────────────

  describe('resolveCandidate()', () => {
    it('should resolve a candidate with merge action', async () => {
      mockPrisma.dedupCandidate.update.mockResolvedValue({
        ...mockCandidate,
        status: 'RESOLVED',
        resolvedAt: new Date(),
        reasoning: 'Human action — merge',
      });

      const result = await controller.resolveCandidate('candidate-1', {
        action: 'merge',
      });

      expect(mockPrisma.dedupCandidate.update).toHaveBeenCalledWith({
        where: { id: 'candidate-1' },
        data: {
          status: 'RESOLVED',
          resolvedAt: expect.any(Date),
          reasoning: 'Human action — merge',
        },
      });
      expect(result).toEqual({
        success: true,
        id: 'candidate-1',
        action: 'merge',
      });
    });

    it('should include notes in reasoning when provided', async () => {
      mockPrisma.dedupCandidate.update.mockResolvedValue({});

      await controller.resolveCandidate('candidate-1', {
        action: 'reject',
        notes: 'Not the same entity',
      });

      expect(mockPrisma.dedupCandidate.update).toHaveBeenCalledWith({
        where: { id: 'candidate-1' },
        data: expect.objectContaining({
          reasoning: 'Human action — reject: Not the same entity',
        }),
      });
    });

    it('should handle keep-both action without notes', async () => {
      mockPrisma.dedupCandidate.update.mockResolvedValue({});

      const result = await controller.resolveCandidate('candidate-1', {
        action: 'keep-both',
      });

      expect(result.action).toBe('keep-both');
      expect(mockPrisma.dedupCandidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reasoning: 'Human action — keep-both',
          }),
        }),
      );
    });

    it('should return correct id in response', async () => {
      mockPrisma.dedupCandidate.update.mockResolvedValue({});

      const result = await controller.resolveCandidate('candidate-abc', {
        action: 'merge',
      });

      expect(result.success).toBe(true);
      expect(result.id).toBe('candidate-abc');
    });

    it('should set resolvedAt to current date', async () => {
      const before = new Date();
      mockPrisma.dedupCandidate.update.mockResolvedValue({});

      await controller.resolveCandidate('candidate-1', { action: 'merge' });
      const after = new Date();

      const callData = mockPrisma.dedupCandidate.update.mock.calls[0][0].data;
      expect(callData.resolvedAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(callData.resolvedAt.getTime()).toBeLessThanOrEqual(
        after.getTime(),
      );
    });
  });

  // ─── getPipelineStats & getAutoStats (shared logic) ──────────────────────

  describe('getPipelineStats()', () => {
    it('should return pipeline statistics with correct counts', async () => {
      mockPrisma.dedupCandidate.count
        .mockResolvedValueOnce(10) // pending
        .mockResolvedValueOnce(25) // classified
        .mockResolvedValueOnce(15) // resolved
        .mockResolvedValueOnce(50) // total
        .mockResolvedValueOnce(8); // reviewQueueDepth
      mockPrisma.dedupCandidate.groupBy.mockResolvedValue([
        { classification: 'DUPLICATE', _count: { id: 20 } },
      ]);

      const result = await controller.getPipelineStats();

      expect(result.pipeline).toEqual({
        pending: 10,
        classified: 25,
        resolved: 15,
        total: 50,
      });
      expect(result.reviewQueueDepth).toBe(8);
    });

    it('should calculate merge rate as percentage of resolved/total', async () => {
      mockPrisma.dedupCandidate.count
        .mockResolvedValueOnce(0) // pending
        .mockResolvedValueOnce(0) // classified
        .mockResolvedValueOnce(30) // resolved
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(0); // reviewQueueDepth
      mockPrisma.dedupCandidate.groupBy.mockResolvedValue([]);

      const result = await controller.getPipelineStats();
      expect(result.mergeRate).toBe('30.0%');
    });

    it('should return 0.0% merge rate when total is 0', async () => {
      mockPrisma.dedupCandidate.count.mockResolvedValue(0);
      mockPrisma.dedupCandidate.groupBy.mockResolvedValue([]);

      const result = await controller.getPipelineStats();
      expect(result.mergeRate).toBe('0.0%');
    });

    it('should map classification groups to readable format', async () => {
      mockPrisma.dedupCandidate.count.mockResolvedValue(10);
      mockPrisma.dedupCandidate.groupBy.mockResolvedValue([
        { classification: 'DUPLICATE', _count: { id: 7 } },
        { classification: 'SIMILAR', _count: { id: 3 } },
      ]);

      const result = await controller.getPipelineStats();

      expect(result.classifications).toContainEqual({
        type: 'DUPLICATE',
        count: 7,
      });
      expect(result.classifications).toContainEqual({
        type: 'SIMILAR',
        count: 3,
      });
    });
  });

  describe('getAutoStats()', () => {
    it('should return same shape as getPipelineStats', async () => {
      mockPrisma.dedupCandidate.count.mockResolvedValue(5);
      mockPrisma.dedupCandidate.groupBy.mockResolvedValue([]);

      const result = await controller.getAutoStats();

      expect(result).toHaveProperty('pipeline');
      expect(result).toHaveProperty('reviewQueueDepth');
      expect(result).toHaveProperty('mergeRate');
      expect(result).toHaveProperty('classifications');
    });
  });

  // ─── triggerPipelineRun ───────────────────────────────────────────────────

  describe('triggerPipelineRun()', () => {
    it('should invoke pipeline.runPipeline and return result', async () => {
      const pipelineResult = {
        candidatesDetected: 12,
        classified: 10,
        autoResolved: 8,
        durationMs: 1500,
      };
      mockPipeline.runPipeline.mockResolvedValue(pipelineResult);

      const result = await controller.triggerPipelineRun();

      expect(mockPipeline.runPipeline).toHaveBeenCalledTimes(1);
      expect(result).toEqual(pipelineResult);
    });

    it('should propagate errors from pipeline run', async () => {
      mockPipeline.runPipeline.mockRejectedValue(new Error('Pipeline failure'));

      await expect(controller.triggerPipelineRun()).rejects.toThrow(
        'Pipeline failure',
      );
    });
  });
});
