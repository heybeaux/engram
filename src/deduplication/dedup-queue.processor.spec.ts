import { Test, TestingModule } from '@nestjs/testing';
import { DedupQueueProcessor } from './dedup-queue.processor';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { MergeService } from './merge.service';
import { LineageService } from './lineage.service';
import { SafetyService } from './safety.service';
import { ReviewService } from './review.service';
import { DEDUP_JOBS } from './dedup.queue';
import { CandidateStatus, MergeStrategy } from './dto/deduplication.dto';
import { Job } from 'bullmq';

describe('DedupQueueProcessor', () => {
  let processor: DedupQueueProcessor;

  const mockPrisma = {
    mergeCandidate: {
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    dedupConfig: {
      findUnique: jest.fn(),
    },
    dedupBatchRun: {
      create: jest.fn(),
    },
  };

  const mockMergeService = {
    merge: jest.fn(),
  };

  const mockLineageService = {
    recordMerge: jest.fn(),
  };

  const mockSafetyService = {
    checkMultipleSafety: jest.fn(),
  };

  const mockReviewService = {
    approve: jest.fn(),
    processBacklog: jest.fn(),
  };

  const createMockJob = (name: string, data: any): Partial<Job> => ({
    name,
    data,
    updateProgress: jest.fn(),
    id: 'test-job-1',
  });

  const createMockCandidate = (overrides: Partial<any> = {}) => ({
    id: 'candidate-1',
    userId: 'user-1',
    memoryIds: ['mem-1', 'mem-2'],
    similarity: 0.92,
    suggestedStrategy: MergeStrategy.KEEP_DETAILED,
    suggestedSurvivorId: 'mem-1',
    safetyFlags: '[]',
    status: CandidateStatus.PENDING,
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DedupQueueProcessor,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: MergeService, useValue: mockMergeService },
        { provide: LineageService, useValue: mockLineageService },
        { provide: SafetyService, useValue: mockSafetyService },
        { provide: ReviewService, useValue: mockReviewService },
      ],
    }).compile();

    processor = module.get<DedupQueueProcessor>(DedupQueueProcessor);
  });

  describe('PROCESS_BATCH', () => {
    it('should process pending candidates and auto-merge high similarity', async () => {
      const candidate = createMockCandidate({ similarity: 0.95 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.dedupConfig.findUnique.mockResolvedValue({
        autoMergeThreshold: 0.88,
        autoResolveThreshold: 0.82,
      });
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true, requiresReview: false, reasons: [] },
        { isProtected: false, canAutoMerge: true, requiresReview: false, reasons: [] },
      ]);
      mockMergeService.merge.mockResolvedValue({
        survivorId: 'mem-1',
        absorbedIds: ['mem-2'],
        mergedContent: 'merged',
        strategy: MergeStrategy.KEEP_DETAILED,
        contentChanged: true,
      });
      mockLineageService.recordMerge.mockResolvedValue({ id: 'event-1' });
      mockPrisma.mergeCandidate.update.mockResolvedValue({});
      mockPrisma.dedupBatchRun.create.mockResolvedValue({});
      mockReviewService.processBacklog.mockResolvedValue({
        approved: 0,
        skippedSafety: 0,
        errors: 0,
      });

      const job = createMockJob(DEDUP_JOBS.PROCESS_BATCH, {
        trigger: 'cron',
        batchSize: 50,
      });

      const result = await processor.process(job as Job);

      expect(result.autoMerged).toBe(1);
      expect(result.processed).toBe(1);
      expect(mockMergeService.merge).toHaveBeenCalledWith(
        ['mem-1', 'mem-2'],
        MergeStrategy.KEEP_DETAILED,
        { survivorId: 'mem-1' },
      );
      expect(mockLineageService.recordMerge).toHaveBeenCalled();
      expect(mockPrisma.mergeCandidate.update).toHaveBeenCalledWith({
        where: { id: 'candidate-1' },
        data: expect.objectContaining({
          status: CandidateStatus.APPROVED,
          reviewedBy: 'dedup-pipeline',
        }),
      });
    });

    it('should skip protected/safety-critical memories', async () => {
      const candidate = createMockCandidate({ similarity: 0.95 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.dedupConfig.findUnique.mockResolvedValue({
        autoMergeThreshold: 0.88,
        autoResolveThreshold: 0.82,
      });
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: true, canAutoMerge: false, requiresReview: true, reasons: [{ type: 'PROTECTED_TYPE' }] },
        { isProtected: false, canAutoMerge: true, requiresReview: false, reasons: [] },
      ]);
      mockPrisma.dedupBatchRun.create.mockResolvedValue({});
      mockReviewService.processBacklog.mockResolvedValue({
        approved: 0,
        skippedSafety: 0,
        errors: 0,
      });

      const job = createMockJob(DEDUP_JOBS.PROCESS_BATCH, {
        trigger: 'cron',
        batchSize: 50,
      });

      const result = await processor.process(job as Job);

      expect(result.skippedSafety).toBe(1);
      expect(result.autoMerged).toBe(0);
      expect(mockMergeService.merge).not.toHaveBeenCalled();
    });

    it('should auto-resolve candidates between thresholds', async () => {
      const candidate = createMockCandidate({ similarity: 0.85 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.dedupConfig.findUnique.mockResolvedValue({
        autoMergeThreshold: 0.88,
        autoResolveThreshold: 0.82,
      });
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true, requiresReview: false, reasons: [] },
        { isProtected: false, canAutoMerge: true, requiresReview: false, reasons: [] },
      ]);
      mockReviewService.approve.mockResolvedValue({ success: true });
      mockPrisma.dedupBatchRun.create.mockResolvedValue({});
      mockReviewService.processBacklog.mockResolvedValue({
        approved: 0,
        skippedSafety: 0,
        errors: 0,
      });

      const job = createMockJob(DEDUP_JOBS.PROCESS_BATCH, {
        trigger: 'cron',
        batchSize: 50,
      });

      const result = await processor.process(job as Job);

      expect(result.autoMerged).toBe(1);
      expect(mockReviewService.approve).toHaveBeenCalledWith(
        'candidate-1',
        { strategy: MergeStrategy.KEEP_DETAILED },
        'auto-resolve',
      );
    });

    it('should leave low-confidence candidates in review queue', async () => {
      const candidate = createMockCandidate({ similarity: 0.78 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.dedupConfig.findUnique.mockResolvedValue({
        autoMergeThreshold: 0.88,
        autoResolveThreshold: 0.82,
      });
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true, requiresReview: false, reasons: [] },
        { isProtected: false, canAutoMerge: true, requiresReview: false, reasons: [] },
      ]);
      mockPrisma.dedupBatchRun.create.mockResolvedValue({});
      mockReviewService.processBacklog.mockResolvedValue({
        approved: 0,
        skippedSafety: 0,
        errors: 0,
      });

      const job = createMockJob(DEDUP_JOBS.PROCESS_BATCH, {
        trigger: 'cron',
        batchSize: 50,
      });

      const result = await processor.process(job as Job);

      expect(result.leftForReview).toBe(1);
      expect(result.autoMerged).toBe(0);
      expect(mockMergeService.merge).not.toHaveBeenCalled();
      expect(mockReviewService.approve).not.toHaveBeenCalled();
    });

    it('should handle empty candidate list', async () => {
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([]);

      const job = createMockJob(DEDUP_JOBS.PROCESS_BATCH, {
        trigger: 'cron',
        batchSize: 50,
      });

      const result = await processor.process(job as Job);

      expect(result.processed).toBe(0);
      expect(result.autoMerged).toBe(0);
    });

    it('should use default config when no user config exists', async () => {
      const candidate = createMockCandidate({ similarity: 0.90 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.dedupConfig.findUnique.mockResolvedValue(null);
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true, requiresReview: false, reasons: [] },
        { isProtected: false, canAutoMerge: true, requiresReview: false, reasons: [] },
      ]);
      mockMergeService.merge.mockResolvedValue({
        survivorId: 'mem-1',
        absorbedIds: ['mem-2'],
        mergedContent: 'merged',
        strategy: MergeStrategy.KEEP_DETAILED,
        contentChanged: true,
      });
      mockLineageService.recordMerge.mockResolvedValue({ id: 'event-1' });
      mockPrisma.mergeCandidate.update.mockResolvedValue({});
      mockPrisma.dedupBatchRun.create.mockResolvedValue({});
      mockReviewService.processBacklog.mockResolvedValue({
        approved: 0,
        skippedSafety: 0,
        errors: 0,
      });

      const job = createMockJob(DEDUP_JOBS.PROCESS_BATCH, {
        trigger: 'cron',
        batchSize: 50,
      });

      const result = await processor.process(job as Job);

      // Default threshold 0.88, candidate at 0.90 should auto-merge
      expect(result.autoMerged).toBe(1);
    });

    it('should run backlog cleanup after processing candidates', async () => {
      const candidate = createMockCandidate({ similarity: 0.95 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.dedupConfig.findUnique.mockResolvedValue({
        autoMergeThreshold: 0.88,
        autoResolveThreshold: 0.82,
      });
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true, requiresReview: false, reasons: [] },
        { isProtected: false, canAutoMerge: true, requiresReview: false, reasons: [] },
      ]);
      mockMergeService.merge.mockResolvedValue({
        survivorId: 'mem-1',
        absorbedIds: ['mem-2'],
        mergedContent: 'merged',
        strategy: MergeStrategy.KEEP_DETAILED,
        contentChanged: true,
      });
      mockLineageService.recordMerge.mockResolvedValue({ id: 'event-1' });
      mockPrisma.mergeCandidate.update.mockResolvedValue({});
      mockPrisma.dedupBatchRun.create.mockResolvedValue({});
      mockReviewService.processBacklog.mockResolvedValue({
        approved: 5,
        skippedSafety: 2,
        errors: 0,
      });

      const job = createMockJob(DEDUP_JOBS.PROCESS_BATCH, {
        trigger: 'manual',
        batchSize: 50,
      });

      await processor.process(job as Job);

      expect(mockReviewService.processBacklog).toHaveBeenCalled();
    });
  });

  describe('PROCESS_BACKLOG', () => {
    it('should delegate to ReviewService.processBacklog', async () => {
      mockReviewService.processBacklog.mockResolvedValue({
        approved: 10,
        skippedSafety: 3,
        errors: 1,
      });

      const job = createMockJob(DEDUP_JOBS.PROCESS_BACKLOG, {
        minSimilarity: 0.93,
        minAgeHours: 24,
      });

      const result = await processor.process(job as Job);

      expect(result).toEqual({
        approved: 10,
        skippedSafety: 3,
        errors: 1,
      });
      expect(mockReviewService.processBacklog).toHaveBeenCalledWith(0.93, 24);
    });
  });
});
