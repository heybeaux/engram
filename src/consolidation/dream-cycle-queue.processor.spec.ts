/**
 * Tests for DreamCycleQueueProcessor
 *
 * This processor handles all Dream Cycle stages via BullMQ jobs.
 * Since this file depends on newer branch code, we mock all imports
 * and test the processor's routing, error handling, and tracking logic.
 */

// Mock all deep dependencies before imports
jest.mock('../prisma/service-prisma.service', () => ({
  ServicePrismaService: jest.fn(),
}));
jest.mock('./dream-cycle-run-tracker.service', () => ({
  DreamCycleRunTrackerService: jest.fn(),
}));
jest.mock('./stages/dream-cycle-pending.stage', () => ({
  DreamCyclePendingStage: jest.fn(),
}));
jest.mock('./stages/dream-cycle-tiering.stage', () => ({
  DreamCycleTieringStage: jest.fn(),
}));
jest.mock('./stages/dream-cycle-patterns.stage', () => ({
  DreamCyclePatternsStage: jest.fn(),
}));
jest.mock('./stages/dream-cycle-drift.stage', () => ({
  DreamCycleDriftStage: jest.fn(),
}));
jest.mock('./stages/dream-cycle-identity.stage', () => ({
  DreamCycleIdentityStage: jest.fn(),
}));
jest.mock('@nestjs/bullmq', () => ({
  Processor: () => (target: any) => target,
  WorkerHost: class WorkerHost {
    process(_job: any): Promise<any> {
      throw new Error('Not implemented');
    }
  },
}));

import { Job } from 'bullmq';
import { DreamCycleQueueProcessor } from './dream-cycle-queue.processor';
import { DREAM_CYCLE_JOBS } from './dream-cycle.queue';

describe('DreamCycleQueueProcessor', () => {
  let processor: DreamCycleQueueProcessor;
  let prisma: any;
  let tracker: any;
  let pendingStage: any;
  let tieringStage: any;
  let patternsStage: any;
  let driftStage: any;
  let identityStage: any;

  const baseJobData = {
    runId: 'run-1',
    userId: 'user-1',
    dryRun: false,
    maxLlmCalls: 50,
    maxMemories: 1000,
  };

  function makeJob(name: string, data = baseJobData): Job {
    return { name, data } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();

    prisma = {
      memory: { count: jest.fn().mockResolvedValue(500) },
    };

    tracker = {
      startStage: jest.fn().mockResolvedValue({ id: 'record-1' }),
      completeStage: jest.fn().mockResolvedValue(undefined),
      abortStage: jest.fn().mockResolvedValue(undefined),
      errorStage: jest.fn().mockResolvedValue(undefined),
    };

    pendingStage = { run: jest.fn() };
    tieringStage = { run: jest.fn() };
    patternsStage = { run: jest.fn() };
    driftStage = { run: jest.fn() };
    identityStage = { run: jest.fn() };

    processor = new DreamCycleQueueProcessor(
      prisma,
      tracker,
      pendingStage,
      tieringStage,
      patternsStage,
      driftStage,
      identityStage,
    );
  });

  // =========================================================================
  // PENDING stage
  // =========================================================================
  describe('PENDING job', () => {
    it('should default to 0 when processed is undefined', async () => {
      pendingStage.run.mockResolvedValue({});

      await processor.process(makeJob(DREAM_CYCLE_JOBS.PENDING));

      expect(tracker.completeStage).toHaveBeenCalledWith(
        'record-1',
        0,
        expect.any(Date),
      );
    });

    it('should use processed count when available', async () => {
      pendingStage.run.mockResolvedValue({ processed: 25 });

      await processor.process(makeJob(DREAM_CYCLE_JOBS.PENDING));

      expect(tracker.completeStage).toHaveBeenCalledWith(
        'record-1',
        25,
        expect.any(Date),
      );
    });
  });

  // =========================================================================
  // TIERING stage
  // =========================================================================
  describe('TIERING job', () => {
    it('should sum promoted and demoted for tracking', async () => {
      tieringStage.run.mockResolvedValue({ promoted: 10, demoted: 3 });

      await processor.process(makeJob(DREAM_CYCLE_JOBS.TIERING));

      expect(tracker.completeStage).toHaveBeenCalledWith(
        'record-1',
        13,
        expect.any(Date),
      );
    });

    it('should handle undefined promoted/demoted', async () => {
      tieringStage.run.mockResolvedValue({});

      await processor.process(makeJob(DREAM_CYCLE_JOBS.TIERING));

      expect(tracker.completeStage).toHaveBeenCalledWith(
        'record-1',
        0,
        expect.any(Date),
      );
    });
  });

  // =========================================================================
  // PATTERNS stage
  // =========================================================================
  describe('PATTERNS job', () => {
    it('should pass maxLlmCalls from job data', async () => {
      patternsStage.run.mockResolvedValue({ patternsCreated: 7 });

      const result = await processor.process(
        makeJob(DREAM_CYCLE_JOBS.PATTERNS),
      );

      expect(patternsStage.run).toHaveBeenCalledWith('user-1', false, 50);
      expect(result).toEqual({ patternsCreated: 7 });
    });

    it('should default maxLlmCalls to 50 when undefined', async () => {
      patternsStage.run.mockResolvedValue({ patternsCreated: 0 });

      await processor.process(
        makeJob(DREAM_CYCLE_JOBS.PATTERNS, {
          ...baseJobData,
          maxLlmCalls: undefined as any,
        }),
      );

      expect(patternsStage.run).toHaveBeenCalledWith('user-1', false, 50);
    });
  });

  // =========================================================================
  // DRIFT stage
  // =========================================================================
  describe('DRIFT job', () => {
    it('should run drift and track with 0 count', async () => {
      driftStage.run.mockResolvedValue({ drifted: 3 });

      await processor.process(makeJob(DREAM_CYCLE_JOBS.DRIFT));

      expect(driftStage.run).toHaveBeenCalledWith('user-1', false);
      expect(tracker.completeStage).toHaveBeenCalledWith(
        'record-1',
        0,
        expect.any(Date),
      );
    });
  });

  // =========================================================================
  // IDENTITY stage
  // =========================================================================
  describe('IDENTITY job', () => {
    it('should run identity with maxLlmCalls', async () => {
      identityStage.run.mockResolvedValue({ updated: true });

      await processor.process(makeJob(DREAM_CYCLE_JOBS.IDENTITY));

      expect(identityStage.run).toHaveBeenCalledWith('user-1', false, 50);
      expect(tracker.completeStage).toHaveBeenCalledWith(
        'record-1',
        0,
        expect.any(Date),
      );
    });
  });

  // =========================================================================
  // REPORT stage
  // =========================================================================
  describe('REPORT job', () => {
    it('should return COMPLETED status', async () => {
      const result = await processor.process(makeJob(DREAM_CYCLE_JOBS.REPORT));

      expect(result).toEqual({ status: 'COMPLETED', runId: 'run-1' });
      expect(tracker.completeStage).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Unknown job
  // =========================================================================
  describe('unknown job', () => {
    it('should throw and track error for unknown job name', async () => {
      await expect(processor.process(makeJob('UNKNOWN_JOB'))).rejects.toThrow(
        'Unknown job: UNKNOWN_JOB',
      );

      expect(tracker.errorStage).toHaveBeenCalledWith(
        'record-1',
        expect.objectContaining({ message: 'Unknown job: UNKNOWN_JOB' }),
        expect.any(Date),
      );
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================
  describe('error handling', () => {
    it('should call errorStage on generic errors and rethrow', async () => {
      pendingStage.run.mockRejectedValue(new Error('DB connection lost'));

      await expect(
        processor.process(makeJob(DREAM_CYCLE_JOBS.PENDING)),
      ).rejects.toThrow('DB connection lost');

      expect(tracker.errorStage).toHaveBeenCalledWith(
        'record-1',
        expect.objectContaining({ message: 'DB connection lost' }),
        expect.any(Date),
      );
    });

    it('should not call abortStage for non-sanity errors', async () => {
      tieringStage.run.mockRejectedValue(new Error('timeout'));

      await expect(
        processor.process(makeJob(DREAM_CYCLE_JOBS.TIERING)),
      ).rejects.toThrow('timeout');

      expect(tracker.abortStage).not.toHaveBeenCalled();
      expect(tracker.errorStage).toHaveBeenCalled();
    });
  });
});
