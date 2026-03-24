import { Test, TestingModule } from '@nestjs/testing';
import { DreamCycleService } from './dream-cycle.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { ConsolidationService } from '../memory/consolidation.service';
import { ImportanceScorerService } from '../memory/intelligence/importance-scorer.service';
import { EmbeddingService } from '../memory/embedding.service';
import { LLMService } from '../llm/llm.service';
import { ConfigService } from '@nestjs/config';
import {
  DreamCyclePatternsStage,
  DreamCycleDriftStage,
  DreamCycleIdentityStage,
  DreamCyclePendingStage,
  DreamCycleTieringStage,
  DreamCycleConsolidationStage,
  DreamCycleTimelineSynthesisStage,
} from './stages';
import { DreamCycleRunTrackerService } from './dream-cycle-run-tracker.service';

const mockPrisma = {
  $queryRawUnsafe: jest.fn(),
  memory: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  dreamCycleRun: { create: jest.fn(), update: jest.fn() },
  dreamCycleReport: { create: jest.fn(), update: jest.fn() },
  consolidationJob: { create: jest.fn(), update: jest.fn() },
  mergeCandidate: { create: jest.fn() },
  memoryMergeEvent: { create: jest.fn() },
  memoryChainLink: { create: jest.fn() },
};

const mockConsolidation = {
  promoteRecurringPatterns: jest.fn(),
};

const mockScorer = {
  computeScore: jest.fn(),
};

const mockEmbedding = {
  search: jest.fn(),
};

const mockLlm = {
  json: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const config: Record<string, string> = {
      DREAM_DEDUP_THRESHOLD: '0.85',
      DREAM_STALENESS_SCORE: '0.35',
      DREAM_STALENESS_DAYS: '21',
      DREAM_MAX_MERGES: '200',
      DREAM_MAX_ARCHIVALS: '50',
      DREAM_MAX_LLM_CALLS: '100',
      DREAM_PATTERN_MIN_CLUSTER: '3',
      DEFAULT_USER_ID: 'test-user',
    };
    return config[key] ?? defaultValue;
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
  run: jest
    .fn()
    .mockResolvedValue({ patternsCreated: 0, clustersFound: 0, llmCalls: 0 }),
};
const mockIdentityStage = {
  run: jest.fn().mockResolvedValue({
    snapshotId: null,
    capabilitiesExtracted: 0,
    preferencesExtracted: 0,
    behavioralTraits: 0,
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

const mockTieringStage = {
  run: jest.fn().mockResolvedValue({
    promoted: 0,
    demoted: 0,
    evaluated: 0,
  }),
};

const mockConsolidationStage = {
  run: jest.fn().mockResolvedValue({
    consolidated: 0,
    clusters: 0,
    llmCalls: 0,
  }),
};

describe('DreamCycleService', () => {
  let service: DreamCycleService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset stage mocks to default success
    mockPendingStage.run.mockResolvedValue({
      processed: 0,
      autoMerged: 0,
      autoRejected: 0,
      llmEvaluated: 0,
      llmMerged: 0,
      llmRejected: 0,
      llmCalls: 0,
      errors: 0,
    });
    mockPatternsStage.run.mockResolvedValue({
      patternsCreated: 0,
      clustersFound: 0,
      llmCalls: 0,
    });
    mockDriftStage.run.mockResolvedValue({
      modelsAnalyzed: 0,
      snapshotsPersisted: 0,
      alerts: [],
    });
    mockTieringStage.run.mockResolvedValue({
      promoted: 0,
      demoted: 0,
      evaluated: 0,
    });
    mockConsolidationStage.run.mockResolvedValue({
      consolidated: 0,
      clusters: 0,
      llmCalls: 0,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DreamCycleService,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: ConsolidationService, useValue: mockConsolidation },
        { provide: ImportanceScorerService, useValue: mockScorer },
        { provide: EmbeddingService, useValue: mockEmbedding },
        { provide: LLMService, useValue: mockLlm },
        { provide: ConfigService, useValue: mockConfig },
        { provide: DreamCyclePendingStage, useValue: mockPendingStage },
        { provide: DreamCyclePatternsStage, useValue: mockPatternsStage },
        { provide: DreamCycleDriftStage, useValue: mockDriftStage },
        { provide: DreamCycleIdentityStage, useValue: mockIdentityStage },
        { provide: DreamCycleTieringStage, useValue: mockTieringStage },
        {
          provide: DreamCycleConsolidationStage,
          useValue: mockConsolidationStage,
        },
        {
          provide: DreamCycleTimelineSynthesisStage,
          useValue: { run: jest.fn().mockResolvedValue({ synthesesCreated: 0 }) },
        },
        {
          provide: DreamCycleRunTrackerService,
          useValue: {
            getTotalMemoryCount: jest.fn().mockResolvedValue(0),
            startStage: jest.fn().mockResolvedValue({
              id: 'stage-1',
              runId: 'run-1',
              stage: 'test',
            }),
            completeStage: jest.fn().mockResolvedValue(undefined),
            abortStage: jest.fn().mockResolvedValue(undefined),
            errorStage: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<DreamCycleService>(DreamCycleService);
  });

  // --- Lock acquisition ---

  describe('acquireLock', () => {
    it('should return true when lock is acquired', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { pg_try_advisory_lock: true },
      ]);
      expect(await service.acquireLock()).toBe(true);
    });

    it('should return false when lock is held by another', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { pg_try_advisory_lock: false },
      ]);
      expect(await service.acquireLock()).toBe(false);
    });

    it('should return false on empty result', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
      expect(await service.acquireLock()).toBe(false);
    });
  });

  describe('releaseLock', () => {
    it('should call pg_advisory_unlock', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
      await service.releaseLock();
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_unlock'),
      );
    });
  });

  // --- run() ---

  describe('run', () => {
    it('should return SKIPPED when lock cannot be acquired', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { pg_try_advisory_lock: false },
      ]);

      const result = await service.run();
      expect(result.status).toBe('SKIPPED');
      expect(result.errors).toContainEqual(
        expect.stringContaining('another instance holds the lock'),
      );
    });

    it('should create run record and execute stages when lock acquired', async () => {
      // Lock acquired
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { pg_try_advisory_lock: true },
      ]);

      // Run record
      mockPrisma.dreamCycleRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrisma.dreamCycleRun.update.mockResolvedValue({});

      // Report + job records
      mockPrisma.dreamCycleReport.create.mockResolvedValue({ id: 'report-1' });
      mockPrisma.consolidationJob.create.mockResolvedValue({ id: 'job-1' });

      // Dedup stage: no memories
      mockPrisma.memory.findMany.mockResolvedValue([]);

      // Staleness stage: no memories
      // (already empty from above)

      // Patterns stage
      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 0,
        details: [],
      });

      // Report stage
      mockPrisma.memory.count.mockResolvedValue(0);
      mockPrisma.memory.aggregate.mockResolvedValue({
        _avg: { effectiveScore: 0 },
      });

      // Update records
      mockPrisma.dreamCycleReport.update.mockResolvedValue({});
      mockPrisma.consolidationJob.update.mockResolvedValue({});

      // Release lock
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.run({ userId: 'test-user' });
      expect(result.status).toBe('COMPLETED');
      expect(mockPrisma.dreamCycleReport.create).toHaveBeenCalled();
    });

    it('should release lock even on failure', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { pg_try_advisory_lock: true },
      ]);
      mockPrisma.dreamCycleRun.create.mockResolvedValue({ id: 'run-1' });

      // Make internal run fail
      mockPrisma.dreamCycleReport.create.mockRejectedValue(
        new Error('DB error'),
      );
      mockPrisma.dreamCycleRun.update.mockResolvedValue({});

      await expect(service.run({ userId: 'test-user' })).rejects.toThrow(
        'DB error',
      );

      // Lock should still be released (last call to $queryRawUnsafe)
      const calls = mockPrisma.$queryRawUnsafe.mock.calls;
      expect(calls[calls.length - 1][0]).toContain('pg_advisory_unlock');
    });

    it('should support dryRun mode', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { pg_try_advisory_lock: true },
      ]);
      mockPrisma.dreamCycleRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrisma.dreamCycleRun.update.mockResolvedValue({});
      mockPrisma.dreamCycleReport.create.mockResolvedValue({ id: 'report-1' });
      mockPrisma.consolidationJob.create.mockResolvedValue({ id: 'job-1' });
      mockPrisma.memory.findMany.mockResolvedValue([]);
      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 0,
        details: [],
      });
      mockPrisma.memory.count.mockResolvedValue(5);
      mockPrisma.memory.aggregate.mockResolvedValue({
        _avg: { effectiveScore: 0.7 },
      });
      mockPrisma.dreamCycleReport.update.mockResolvedValue({});
      mockPrisma.consolidationJob.update.mockResolvedValue({});
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.run({ dryRun: true, userId: 'test-user' });
      expect(result.status).toBe('DRY_RUN');
    });

    it('should run only specified stages', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { pg_try_advisory_lock: true },
      ]);
      mockPrisma.dreamCycleRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrisma.dreamCycleRun.update.mockResolvedValue({});
      mockPrisma.dreamCycleReport.create.mockResolvedValue({ id: 'report-1' });
      mockPrisma.consolidationJob.create.mockResolvedValue({ id: 'job-1' });
      mockPrisma.memory.count.mockResolvedValue(10);
      mockPrisma.memory.aggregate.mockResolvedValue({
        _avg: { effectiveScore: 0.5 },
      });
      mockPrisma.dreamCycleReport.update.mockResolvedValue({});
      mockPrisma.consolidationJob.update.mockResolvedValue({});
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.run({
        stages: ['report'],
        userId: 'test-user',
      });
      expect(result.status).toBe('COMPLETED');
      // Pending not called since not in stages
      expect(mockPendingStage.run).not.toHaveBeenCalled();
    });
  });

  // --- Staleness stage error isolation ---

  describe('stage error isolation', () => {
    it('should continue to next stage when one fails', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { pg_try_advisory_lock: true },
      ]);
      mockPrisma.dreamCycleRun.create.mockResolvedValue({ id: 'run-1' });
      mockPrisma.dreamCycleRun.update.mockResolvedValue({});
      mockPrisma.dreamCycleReport.create.mockResolvedValue({ id: 'report-1' });
      mockPrisma.consolidationJob.create.mockResolvedValue({ id: 'job-1' });

      // Pending stage fails
      mockPendingStage.run.mockRejectedValueOnce(new Error('Pending DB error'));

      // Report stage
      mockPrisma.memory.count.mockResolvedValue(10);
      mockPrisma.memory.aggregate.mockResolvedValue({
        _avg: { effectiveScore: 0.5 },
      });

      mockPrisma.dreamCycleReport.update.mockResolvedValue({});
      mockPrisma.consolidationJob.update.mockResolvedValue({});
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.run({ userId: 'test-user' });
      expect(result.status).toBe('COMPLETED');
      expect(result.errors).toContainEqual(
        expect.stringContaining('Pending stage failed'),
      );
    });
  });
});
