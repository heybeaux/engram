import { DedupQueueProcessor } from './dedup-queue.processor';
import { MergeService } from './merge.service';
import { LineageService } from './lineage.service';
import { SafetyService } from './safety.service';
import { ReviewService } from './review.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { DEDUP_JOBS } from './dedup.queue';
import { CandidateStatus } from './dto/deduplication.dto';

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockPrisma = {
  mergeCandidate: {
    findMany: jest.fn(),
    update: jest.fn(),
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

// ── Job factory helpers ────────────────────────────────────────────────────
function makeJob(name: string, data: Record<string, any>): any {
  return {
    name,
    data,
    updateProgress: jest.fn().mockResolvedValue(undefined),
  };
}

function makeCandidate(
  overrides: Partial<{
    id: string;
    userId: string;
    memoryIds: string[];
    similarity: number;
    suggestedStrategy: string;
    suggestedSurvivorId: string;
    safetyFlags: string;
    status: string;
  }> = {},
): any {
  return {
    id: 'cand-1',
    userId: 'user-1',
    memoryIds: ['mem-a', 'mem-b'],
    similarity: 0.9,
    suggestedStrategy: 'MERGE_INTO_SURVIVOR',
    suggestedSurvivorId: 'mem-a',
    safetyFlags: '[]',
    status: CandidateStatus.PENDING,
    ...overrides,
  };
}

// ── Suite ──────────────────────────────────────────────────────────────────
describe('DedupQueueProcessor', () => {
  let processor: DedupQueueProcessor;

  beforeEach(() => {
    jest.clearAllMocks();

    processor = new DedupQueueProcessor(
      mockPrisma as unknown as ServicePrismaService,
      mockMergeService as unknown as MergeService,
      mockLineageService as unknown as LineageService,
      mockSafetyService as unknown as SafetyService,
      mockReviewService as unknown as ReviewService,
    );

    // Default mocks
    mockPrisma.dedupConfig.findUnique.mockResolvedValue(null); // use defaults
    mockPrisma.dedupBatchRun.create.mockResolvedValue({});
    mockReviewService.processBacklog.mockResolvedValue({
      approved: 0,
      skippedSafety: 0,
      errors: 0,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // process() — routing
  // ──────────────────────────────────────────────────────────────────────────
  describe('process()', () => {
    it('routes PROCESS_BATCH jobs correctly', async () => {
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([]);
      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, {
        trigger: 'manual',
        batchSize: 10,
      });
      const result = await processor.process(job);
      expect(result).toBeDefined();
      expect(result.processed).toBe(0);
    });

    it('routes PROCESS_BACKLOG jobs correctly', async () => {
      mockReviewService.processBacklog.mockResolvedValue({
        approved: 3,
        skippedSafety: 1,
        errors: 0,
      });
      const job = makeJob(DEDUP_JOBS.PROCESS_BACKLOG, {
        minSimilarity: 0.9,
        minAgeHours: 24,
      });
      const result = await processor.process(job);
      expect(result.approved).toBe(3);
    });

    it('does not throw for unknown job name (returns undefined)', async () => {
      const job = makeJob('unknown:job', {});
      const result = await processor.process(job);
      expect(result).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // processBatch — happy paths
  // ──────────────────────────────────────────────────────────────────────────
  describe('processBatch()', () => {
    it('returns zero stats when no pending candidates', async () => {
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([]);
      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      const result = await processor.process(job);
      expect(result.processed).toBe(0);
      expect(result.autoMerged).toBe(0);
    });

    it('auto-merges high-similarity safe candidates', async () => {
      const candidate = makeCandidate({ similarity: 0.95 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true },
        { isProtected: false, canAutoMerge: true },
      ]);
      mockMergeService.merge.mockResolvedValue({
        survivorId: 'mem-a',
        mergedIds: ['mem-b'],
      });
      mockLineageService.recordMerge.mockResolvedValue({});
      mockPrisma.mergeCandidate.update.mockResolvedValue({});

      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      const result = await processor.process(job);

      expect(result.autoMerged).toBe(1);
      expect(result.processed).toBe(1);
      expect(mockMergeService.merge).toHaveBeenCalledWith(
        ['mem-a', 'mem-b'],
        'MERGE_INTO_SURVIVOR',
        { survivorId: 'mem-a' },
      );
    });

    it('auto-resolves medium-confidence candidates via review service', async () => {
      // similarity between autoResolveThreshold (0.82) and autoMergeThreshold (0.88)
      const candidate = makeCandidate({ similarity: 0.85 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true },
        { isProtected: false, canAutoMerge: true },
      ]);
      mockReviewService.approve.mockResolvedValue({});

      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      const result = await processor.process(job);

      expect(mockReviewService.approve).toHaveBeenCalledWith(
        candidate.id,
        { strategy: candidate.suggestedStrategy },
        'auto-resolve',
      );
      expect(result.autoMerged).toBe(1);
    });

    it('leaves low-confidence candidates for manual review', async () => {
      const candidate = makeCandidate({ similarity: 0.7 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true },
        { isProtected: false, canAutoMerge: true },
      ]);

      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      const result = await processor.process(job);

      expect(result.leftForReview).toBe(1);
      expect(result.autoMerged).toBe(0);
      expect(mockMergeService.merge).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Safety checks
  // ──────────────────────────────────────────────────────────────────────────
  describe('safety enforcement', () => {
    it('NEVER auto-merges protected (CONSTRAINT) memories', async () => {
      const candidate = makeCandidate({ similarity: 0.99 }); // extremely high
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: true, canAutoMerge: false },
        { isProtected: false, canAutoMerge: true },
      ]);

      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      const result = await processor.process(job);

      expect(result.skippedSafety).toBe(1);
      expect(result.autoMerged).toBe(0);
      expect(mockMergeService.merge).not.toHaveBeenCalled();
    });

    it('skips merge even when canAutoMerge=false despite high similarity', async () => {
      const candidate = makeCandidate({ similarity: 0.95 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: false },
        { isProtected: false, canAutoMerge: false },
      ]);

      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      const result = await processor.process(job);

      expect(mockMergeService.merge).not.toHaveBeenCalled();
      expect(result.leftForReview).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Error handling
  // ──────────────────────────────────────────────────────────────────────────
  describe('error handling', () => {
    it('increments errors counter when candidate processing fails', async () => {
      const candidate = makeCandidate();
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockSafetyService.checkMultipleSafety.mockRejectedValue(
        new Error('safety svc down'),
      );

      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      const result = await processor.process(job);

      expect(result.errors).toBe(1);
      expect(result.processed).toBe(0);
    });

    it('throws when fetching candidates fails entirely', async () => {
      mockPrisma.mergeCandidate.findMany.mockRejectedValue(
        new Error('DB connection lost'),
      );
      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      await expect(processor.process(job)).rejects.toThrow(
        'DB connection lost',
      );
    });

    it('continues processing batch even if backlog cleanup fails', async () => {
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([]);
      mockReviewService.processBacklog.mockRejectedValue(
        new Error('backlog error'),
      );

      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      // Should not throw — backlog errors are swallowed
      const result = await processor.process(job);
      expect(result).toBeDefined();
    });

    it('handles malformed safetyFlags JSON gracefully', async () => {
      const candidate = makeCandidate({
        safetyFlags: 'not-json',
        similarity: 0.95,
      });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true },
        { isProtected: false, canAutoMerge: true },
      ]);
      mockMergeService.merge.mockResolvedValue({
        survivorId: 'mem-a',
        mergedIds: ['mem-b'],
      });
      mockLineageService.recordMerge.mockResolvedValue({});
      mockPrisma.mergeCandidate.update.mockResolvedValue({});

      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      // Should not throw — malformed flags default to empty array
      const result = await processor.process(job);
      expect(result.errors).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Config caching
  // ──────────────────────────────────────────────────────────────────────────
  describe('config caching', () => {
    it('uses DB config thresholds when available', async () => {
      const candidate = makeCandidate({
        similarity: 0.91,
        userId: 'user-custom',
      });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.dedupConfig.findUnique.mockResolvedValue({
        autoMergeThreshold: 0.9,
        autoResolveThreshold: 0.85,
      });
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true },
        { isProtected: false, canAutoMerge: true },
      ]);
      mockMergeService.merge.mockResolvedValue({
        survivorId: 'mem-a',
        mergedIds: ['mem-b'],
      });
      mockLineageService.recordMerge.mockResolvedValue({});
      mockPrisma.mergeCandidate.update.mockResolvedValue({});

      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'manual' });
      const result = await processor.process(job);
      expect(result.autoMerged).toBe(1);
    });

    it('only fetches config once per userId within a batch', async () => {
      const candidates = [
        makeCandidate({ id: 'c1', similarity: 0.5, userId: 'same-user' }),
        makeCandidate({ id: 'c2', similarity: 0.5, userId: 'same-user' }),
      ];
      mockPrisma.mergeCandidate.findMany.mockResolvedValue(candidates);
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true },
        { isProtected: false, canAutoMerge: true },
      ]);

      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      await processor.process(job);

      // Config should only be fetched once even for two candidates of same user
      expect(mockPrisma.dedupConfig.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Batch run recording
  // ──────────────────────────────────────────────────────────────────────────
  describe('batch run recording', () => {
    it('records batch run as COMPLETED when no errors', async () => {
      const candidate = makeCandidate({ similarity: 0.5 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockSafetyService.checkMultipleSafety.mockResolvedValue([
        { isProtected: false, canAutoMerge: true },
        { isProtected: false, canAutoMerge: true },
      ]);
      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'cron' });
      await processor.process(job);

      expect(mockPrisma.dedupBatchRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'COMPLETED' }),
        }),
      );
    });

    it('records batch run as COMPLETED_WITH_ERRORS when errors > 0', async () => {
      const candidate = makeCandidate();
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockSafetyService.checkMultipleSafety.mockRejectedValue(
        new Error('oops'),
      );

      const job = makeJob(DEDUP_JOBS.PROCESS_BATCH, { trigger: 'manual' });
      await processor.process(job);

      expect(mockPrisma.dedupBatchRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'COMPLETED_WITH_ERRORS' }),
        }),
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // processBacklogJob
  // ──────────────────────────────────────────────────────────────────────────
  describe('processBacklogJob (PROCESS_BACKLOG)', () => {
    it('delegates to reviewService.processBacklog with job params', async () => {
      mockReviewService.processBacklog.mockResolvedValue({
        approved: 5,
        skippedSafety: 2,
        errors: 0,
      });

      const job = makeJob(DEDUP_JOBS.PROCESS_BACKLOG, {
        minSimilarity: 0.88,
        minAgeHours: 12,
      });
      const result = await processor.process(job);

      expect(mockReviewService.processBacklog).toHaveBeenCalledWith(0.88, 12);
      expect(result.approved).toBe(5);
      expect(result.skippedSafety).toBe(2);
    });

    it('handles undefined optional params', async () => {
      mockReviewService.processBacklog.mockResolvedValue({
        approved: 0,
        skippedSafety: 0,
        errors: 0,
      });

      const job = makeJob(DEDUP_JOBS.PROCESS_BACKLOG, {});
      const result = await processor.process(job);
      expect(mockReviewService.processBacklog).toHaveBeenCalledWith(
        undefined,
        undefined,
      );
      expect(result).toBeDefined();
    });
  });
});
