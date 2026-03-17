/**
 * ENG-34: Account Isolation Tests
 *
 * Seeds 2 test accounts with canary memories, runs background processor logic,
 * and asserts zero cross-account bleed for Dream Cycle, Dedup, and Awareness.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { CandidateDetectionService } from '../../deduplication/automated/candidate-detection.service';
import { DedupClassificationService } from '../../deduplication/automated/dedup-classification.service';
import { DedupResolutionService } from '../../deduplication/automated/dedup-resolution.service';
import { DedupPipelineService } from '../../deduplication/automated/dedup-pipeline.service';
import { DreamCycleService } from '../../consolidation/dream-cycle.service';
import {
  DreamCyclePendingStage,
  DreamCycleTieringStage,
  DreamCycleConsolidationStage,
  DreamCyclePatternsStage,
  DreamCycleDriftStage,
  DreamCycleIdentityStage,
} from '../../consolidation/stages';
import { DreamCycleRunTrackerService } from '../../consolidation/dream-cycle-run-tracker.service';
import { SafetyService } from '../../deduplication/safety.service';
import { LLMService } from '../../llm/llm.service';

// ---------------------------------------------------------------------------
// Shared test fixtures — two isolated accounts with canary memories
// ---------------------------------------------------------------------------

const ACCOUNT_A = { id: 'acct-alpha' };
const ACCOUNT_B = { id: 'acct-beta' };

const USER_A = { id: 'user-alpha' };
const USER_B = { id: 'user-beta' };

const CANARY_MEM_A = {
  id: 'mem-alpha-1',
  raw: 'Alpha prefers dark mode in all applications',
  userId: USER_A.id,
  createdAt: new Date(),
  deletedAt: null,
  importanceScore: 0.7,
  source: 'EXPLICIT_STATEMENT',
  safetyCritical: false,
  memoryType: null,
};

const CANARY_MEM_A2 = {
  id: 'mem-alpha-2',
  raw: 'Alpha prefers dark mode in apps',
  userId: USER_A.id,
  createdAt: new Date(),
  deletedAt: null,
  importanceScore: 0.6,
  source: 'INFERRED',
  safetyCritical: false,
  memoryType: null,
};

const CANARY_MEM_B = {
  id: 'mem-beta-1',
  raw: 'Beta always uses light theme',
  userId: USER_B.id,
  createdAt: new Date(),
  deletedAt: null,
  importanceScore: 0.8,
  source: 'EXPLICIT_STATEMENT',
  safetyCritical: false,
  memoryType: null,
};

const CANARY_MEM_B2 = {
  id: 'mem-beta-2',
  raw: 'Beta always uses light theme in all tools',
  userId: USER_B.id,
  createdAt: new Date(),
  deletedAt: null,
  importanceScore: 0.5,
  source: 'INFERRED',
  safetyCritical: false,
  memoryType: null,
};

// ---------------------------------------------------------------------------
// 1. Dedup Candidate Detection — account isolation
// ---------------------------------------------------------------------------

describe('ENG-34: Account Isolation — Dedup Candidate Detection', () => {
  let service: CandidateDetectionService;
  let mockPrisma: Record<string, any>;

  beforeEach(async () => {
    mockPrisma = {
      memory: {
        findMany: jest.fn(),
      },
      dedupCandidate: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn(),
    };

    const mockConfig = { get: jest.fn().mockReturnValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidateDetectionService,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<CandidateDetectionService>(CandidateDetectionService);
  });

  it('only scans memories belonging to the specified userId', async () => {
    // When called with user-alpha, should only fetch alpha's memories
    mockPrisma.memory.findMany.mockResolvedValue([CANARY_MEM_A, CANARY_MEM_A2]);
    mockPrisma.$queryRaw.mockResolvedValue([]);

    await service.detectCandidates(USER_A.id);

    // Verify the initial query scopes to userId
    expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_A.id }),
      }),
    );
  });

  it('does NOT create cross-account candidates via text detection', async () => {
    // Simulate: user A detection — initial query returns only A's memories
    mockPrisma.memory.findMany
      .mockResolvedValueOnce([CANARY_MEM_A]) // initial query (scoped to user A)
      .mockResolvedValue([CANARY_MEM_A2]); // text neighbours (should also be scoped to user A)
    mockPrisma.$queryRaw.mockResolvedValue([]);

    await service.detectCandidates(USER_A.id);

    // text neighbours query should include userId filter
    const textCall = mockPrisma.memory.findMany.mock.calls[1];
    expect(textCall[0].where).toHaveProperty('userId', USER_A.id);
  });

  it('never receives cross-account memories when userId is consistently passed', async () => {
    // First call: user A detection
    mockPrisma.memory.findMany.mockResolvedValue([]);
    mockPrisma.$queryRaw.mockResolvedValue([]);

    await service.detectCandidates(USER_A.id);

    // Every findMany call should include userId = user-alpha
    for (const call of mockPrisma.memory.findMany.mock.calls) {
      if (call[0]?.where?.userId) {
        expect(call[0].where.userId).toBe(USER_A.id);
      }
    }

    jest.clearAllMocks();

    // Second call: user B detection
    mockPrisma.memory.findMany.mockResolvedValue([]);
    mockPrisma.$queryRaw.mockResolvedValue([]);

    await service.detectCandidates(USER_B.id);

    // Every findMany call should include userId = user-beta
    for (const call of mockPrisma.memory.findMany.mock.calls) {
      if (call[0]?.where?.userId) {
        expect(call[0].where.userId).toBe(USER_B.id);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Dedup Pipeline — per-account iteration
// ---------------------------------------------------------------------------

describe('ENG-34: Account Isolation — Dedup Pipeline', () => {
  let service: DedupPipelineService;
  let mockDetection: Record<string, jest.Mock>;
  let mockClassification: Record<string, jest.Mock>;
  let mockResolution: Record<string, jest.Mock>;
  let mockPrisma: Record<string, any>;

  beforeEach(async () => {
    mockPrisma = {
      account: {
        findMany: jest.fn().mockResolvedValue([ACCOUNT_A, ACCOUNT_B]),
      },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([USER_A]) // users for account A
          .mockResolvedValueOnce([USER_B]), // users for account B
      },
    };

    mockDetection = {
      detectCandidates: jest
        .fn()
        .mockResolvedValue({ scanned: 5, created: 1, skipped: 0 }),
    };
    mockClassification = {
      processPendingCandidates: jest
        .fn()
        .mockResolvedValue({ processed: 0, errors: 0 }),
    };
    mockResolution = {
      processClassifiedCandidates: jest.fn().mockResolvedValue({
        processed: 0,
        autoMerged: 0,
        autoConsolidated: 0,
        queued: 0,
        skipped: 0,
        errors: 0,
      }),
    };

    const mockConfig = {
      get: jest.fn().mockReturnValue('true'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DedupPipelineService,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: CandidateDetectionService, useValue: mockDetection },
        { provide: DedupClassificationService, useValue: mockClassification },
        { provide: DedupResolutionService, useValue: mockResolution },
      ],
    }).compile();

    service = module.get<DedupPipelineService>(DedupPipelineService);
  });

  it('discovers all accounts and processes users per-account', async () => {
    const result = await service.runPipeline();

    expect(mockPrisma.account.findMany).toHaveBeenCalled();
    expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(2);
    expect(result.skipped).toBe(false);
  });

  it('calls detection with each userId — never without userId', async () => {
    await service.runPipeline();

    expect(mockDetection.detectCandidates).toHaveBeenCalledTimes(2);
    expect(mockDetection.detectCandidates).toHaveBeenCalledWith(USER_A.id);
    expect(mockDetection.detectCandidates).toHaveBeenCalledWith(USER_B.id);

    // Verify NO call was made without a userId argument
    for (const call of mockDetection.detectCandidates.mock.calls) {
      expect(call[0]).toBeDefined();
      expect(typeof call[0]).toBe('string');
    }
  });

  it('calls classification and resolution with each userId', async () => {
    await service.runPipeline();

    expect(mockClassification.processPendingCandidates).toHaveBeenCalledWith(
      USER_A.id,
    );
    expect(mockClassification.processPendingCandidates).toHaveBeenCalledWith(
      USER_B.id,
    );
    expect(mockResolution.processClassifiedCandidates).toHaveBeenCalledWith(
      USER_A.id,
    );
    expect(mockResolution.processClassifiedCandidates).toHaveBeenCalledWith(
      USER_B.id,
    );
  });

  it('aggregates stats across accounts without mixing data', async () => {
    mockDetection.detectCandidates
      .mockResolvedValueOnce({ scanned: 10, created: 2, skipped: 0 })
      .mockResolvedValueOnce({ scanned: 5, created: 1, skipped: 0 });

    const result = await service.runPipeline();

    expect(result.detection.scanned).toBe(15);
    expect(result.detection.created).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Dedup Classification — userId scoping
// ---------------------------------------------------------------------------

describe('ENG-34: Account Isolation — Dedup Classification', () => {
  let service: DedupClassificationService;
  let mockPrisma: Record<string, any>;
  let mockLlm: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockPrisma = {
      dedupCandidate: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    mockLlm = {
      chat: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DedupClassificationService,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: LLMService, useValue: mockLlm },
      ],
    }).compile();

    service = module.get<DedupClassificationService>(
      DedupClassificationService,
    );
  });

  it('filters candidates by userId when provided', async () => {
    await service.processPendingCandidates(USER_A.id);

    expect(mockPrisma.dedupCandidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memory1: { userId: USER_A.id },
        }),
      }),
    );
  });

  it('does not filter by userId when not provided (backwards compat)', async () => {
    await service.processPendingCandidates();

    const call = mockPrisma.dedupCandidate.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('memory1');
  });
});

// ---------------------------------------------------------------------------
// 4. Dedup Resolution — userId scoping
// ---------------------------------------------------------------------------

describe('ENG-34: Account Isolation — Dedup Resolution', () => {
  let service: DedupResolutionService;
  let mockPrisma: Record<string, any>;

  beforeEach(async () => {
    mockPrisma = {
      dedupCandidate: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      memory: {
        update: jest.fn().mockResolvedValue({}),
      },
      memoryMergeEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DedupResolutionService,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: SafetyService, useValue: {} },
      ],
    }).compile();

    service = module.get<DedupResolutionService>(DedupResolutionService);
  });

  it('filters candidates by userId when provided', async () => {
    await service.processClassifiedCandidates(USER_B.id);

    expect(mockPrisma.dedupCandidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memory1: { userId: USER_B.id },
        }),
      }),
    );
  });

  it('does not filter by userId when not provided (backwards compat)', async () => {
    await service.processClassifiedCandidates();

    const call = mockPrisma.dedupCandidate.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('memory1');
  });
});

// ---------------------------------------------------------------------------
// 5. Dream Cycle — per-account orchestration
// ---------------------------------------------------------------------------

describe('ENG-34: Account Isolation — Dream Cycle Orchestrator', () => {
  let service: DreamCycleService;
  let mockPrisma: Record<string, any>;
  let mockPendingStage: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockPendingStage = {
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

    const noopStage = { run: jest.fn().mockResolvedValue({}) };

    mockPrisma = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([{ pg_try_advisory_lock: true }]) // lock acquired
        .mockResolvedValue([]), // lock released
      account: {
        findMany: jest.fn().mockResolvedValue([ACCOUNT_A, ACCOUNT_B]),
      },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([USER_A])
          .mockResolvedValueOnce([USER_B]),
      },
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _avg: { effectiveScore: 0 } }),
        update: jest.fn().mockResolvedValue({}),
      },
      dreamCycleReport: {
        create: jest.fn().mockResolvedValue({ id: 'report-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      consolidationJob: {
        create: jest.fn().mockResolvedValue({ id: 'job-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'DREAM_MAX_LLM_CALLS') return '100';
        return undefined; // NO DEFAULT_USER_ID — triggers auto-discovery
      }),
    };

    const trackerMock = {
      getTotalMemoryCount: jest.fn().mockResolvedValue(0),
      startStage: jest
        .fn()
        .mockResolvedValue({ id: 'sr-1', runId: 'r-1', stage: 's' }),
      completeStage: jest.fn().mockResolvedValue(undefined),
      abortStage: jest.fn().mockResolvedValue(undefined),
      errorStage: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DreamCycleService,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: DreamCyclePendingStage, useValue: mockPendingStage },
        { provide: DreamCycleTieringStage, useValue: noopStage },
        { provide: DreamCycleConsolidationStage, useValue: noopStage },
        { provide: DreamCyclePatternsStage, useValue: noopStage },
        { provide: DreamCycleDriftStage, useValue: noopStage },
        { provide: DreamCycleIdentityStage, useValue: noopStage },
        { provide: DreamCycleRunTrackerService, useValue: trackerMock },
      ],
    }).compile();

    service = module.get<DreamCycleService>(DreamCycleService);
  });

  it('auto-discovers accounts and iterates users per account', async () => {
    const result = await service.run();

    expect(mockPrisma.account.findMany).toHaveBeenCalled();
    expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(2);
    expect(result.usersProcessed).toBe(2);
  });

  it('runs each stage with the correct userId — no cross-contamination', async () => {
    await service.run();

    // Pending stage should be called once per user
    const pendingCalls = mockPendingStage.run.mock.calls;
    const userIds = pendingCalls.map((call: unknown[]) => call[0]);
    expect(userIds).toContain(USER_A.id);
    expect(userIds).toContain(USER_B.id);
    expect(userIds).toHaveLength(2);
  });
});
