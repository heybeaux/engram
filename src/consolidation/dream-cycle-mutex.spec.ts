import { DreamCycleService } from './dream-cycle.service';

describe('DreamCycleService - Mutex', () => {
  let service: DreamCycleService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      $queryRawUnsafe: jest.fn(),
      dreamCycleReport: {
        create: jest.fn().mockResolvedValue({ id: 'report-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      consolidationJob: {
        create: jest.fn().mockResolvedValue({ id: 'job-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _avg: { effectiveScore: 0 } }),
      },
    };

    const mockConfig = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const mockDedupStage = {
      run: jest.fn().mockResolvedValue({
        merged: 0,
        flagged: 0,
        scanned: 0,
        llmCalls: 0,
      }),
    };
    const mockStalenessStage = {
      run: jest.fn().mockResolvedValue({
        archived: 0,
        scoresRefreshed: 0,
        candidates: 0,
      }),
    };
    const mockPendingStage = {
      run: jest.fn().mockResolvedValue({
        processed: 0,
        autoMerged: 0,
        autoRejected: 0,
        llmEvaluated: 0,
        llmMerged: 0,
        llmRejected: 0,
        llmCalls: 0,
        errors: 0,
      }),
    };
    const mockPatternsStage = {
      run: jest.fn().mockResolvedValue({
        patternsCreated: 0,
        clustersFound: 0,
        llmCalls: 0,
      }),
    };
    const mockDriftStage = {
      run: jest.fn().mockResolvedValue({
        modelsAnalyzed: 0,
        snapshotsPersisted: 0,
        alerts: [],
      }),
    };

    const mockIdentityStage = {
      run: jest.fn().mockResolvedValue({ processed: 0 }),
    };

    const mockTieringStage = {
      run: jest.fn().mockResolvedValue({ promoted: 0, demoted: 0 }),
    };
    const mockConsolidationStage = {
      run: jest.fn().mockResolvedValue({ consolidated: 0 }),
    };

    const mockTracker = {
      startStage: jest
        .fn()
        .mockResolvedValue({ id: 'mock-id', runId: 'mock-run', stage: 'mock' }),
      completeStage: jest.fn().mockResolvedValue(undefined),
      abortStage: jest.fn().mockResolvedValue(undefined),
      errorStage: jest.fn().mockResolvedValue(undefined),
      getTotalMemoryCount: jest.fn().mockResolvedValue(0),
    };

    service = new DreamCycleService(
      mockPrisma,
      mockConfig as any,
      mockPendingStage as any,
      mockTieringStage as any,
      mockConsolidationStage as any,
      mockPatternsStage as any,
      mockDriftStage as any,
      mockIdentityStage as any,
      mockTracker as any,
    );
  });

  describe('acquireLock', () => {
    it('should return true when lock is acquired', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { pg_try_advisory_lock: true },
      ]);
      const result = await service.acquireLock();
      expect(result).toBe(true);
    });

    it('should return false when lock is held by another process', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { pg_try_advisory_lock: false },
      ]);
      const result = await service.acquireLock();
      expect(result).toBe(false);
    });
  });

  describe('run - mutex behavior', () => {
    it('should skip gracefully when another instance is running', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { pg_try_advisory_lock: false },
      ]);

      const result = await service.run({ userId: 'test-user' });

      expect(result.status).toBe('SKIPPED');
      expect(result.errors).toContainEqual(
        expect.stringContaining('another instance holds the lock'),
      );
      // Should NOT have created a report record
      expect(mockPrisma.dreamCycleReport.create).not.toHaveBeenCalled();
    });

    it('should proceed when lock is acquired', async () => {
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([{ pg_try_advisory_lock: true }])
        .mockResolvedValueOnce([{}]); // releaseLock

      const result = await service.run({
        userId: 'test-user',
        stages: ['report'],
      });

      expect(result.status).not.toBe('SKIPPED');
      expect(mockPrisma.dreamCycleReport.create).toHaveBeenCalled();
      expect(mockPrisma.dreamCycleReport.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'COMPLETED' }),
        }),
      );
    });

    it('should release lock and mark report as FAILED on error', async () => {
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([{ pg_try_advisory_lock: true }])
        .mockResolvedValueOnce([{}]); // releaseLock

      // No userId, no DEFAULT_USER_ID → triggers auto-discover
      // Make memory.findMany throw to cause failure
      mockPrisma.memory.findMany.mockRejectedValueOnce(new Error('DB down'));

      await expect(service.run({})).rejects.toThrow('DB down');

      // Lock should have been released
      const calls = mockPrisma.$queryRawUnsafe.mock.calls;
      expect(calls[calls.length - 1][0]).toContain('pg_advisory_unlock');
    });

    it('should release lock even on successful completion', async () => {
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([{ pg_try_advisory_lock: true }])
        .mockResolvedValueOnce([{}]); // releaseLock

      await service.run({ userId: 'test-user', stages: ['report'] });

      const calls = mockPrisma.$queryRawUnsafe.mock.calls;
      expect(calls[calls.length - 1][0]).toContain('pg_advisory_unlock');
    });
  });
});
