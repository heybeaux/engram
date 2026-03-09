import { DreamCyclePatternsStage, PatternsStageResult } from './dream-cycle-patterns.stage';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { ConsolidationService } from '../../memory/consolidation.service';
import { LLMService } from '../../llm/llm.service';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockPrisma = {
  memory: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
  },
  memoryChainLink: {
    create: jest.fn(),
  },
};

const mockConsolidation = {
  promoteRecurringPatterns: jest.fn(),
};

const mockLLM = {
  json: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: string) => {
    const map: Record<string, string> = { DREAM_PATTERN_MIN_SIZE: '3' };
    return map[key] ?? defaultValue;
  }),
};

const mockEventEmitter = {
  emit: jest.fn(),
};

// ── Factory ────────────────────────────────────────────────────────────────
function makeStage(eventEmitter?: EventEmitter2): DreamCyclePatternsStage {
  return new DreamCyclePatternsStage(
    mockPrisma as unknown as ServicePrismaService,
    mockConsolidation as unknown as ConsolidationService,
    mockLLM as unknown as LLMService,
    mockConfig as unknown as ConfigService,
    eventEmitter,
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────
function makeClusterDetail(overrides: Partial<{
  canonicalId: string;
  duplicateIds: string[];
}> = {}) {
  return {
    canonicalId: 'mem-1',
    duplicateIds: ['mem-2', 'mem-3'],
    ...overrides,
  };
}

function makeMemories(ids: string[]) {
  return ids.map((id, i) => ({ id, raw: `Memory content ${i + 1}` }));
}

// ── Suite ──────────────────────────────────────────────────────────────────
describe('DreamCyclePatternsStage', () => {
  let stage: DreamCyclePatternsStage;

  beforeEach(() => {
    jest.clearAllMocks();
    stage = makeStage(mockEventEmitter as unknown as EventEmitter2);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // No clusters found
  // ──────────────────────────────────────────────────────────────────────────
  describe('when no clusters found', () => {
    it('returns zero stats without calling LLM', async () => {
      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 0,
        details: [],
      });

      const result = await stage.run('user-1', false, 10);

      expect(result).toEqual<PatternsStageResult>({
        patternsCreated: 0,
        clustersFound: 0,
        llmCalls: 0,
      });
      expect(mockLLM.json).not.toHaveBeenCalled();
    });

    it('returns zero stats when remainingLlmBudget is 0', async () => {
      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 3,
        details: [makeClusterDetail()],
      });

      const result = await stage.run('user-1', false, 0);

      expect(result.patternsCreated).toBe(0);
      expect(result.clustersFound).toBe(3);
      expect(mockLLM.json).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Happy path — pattern creation
  // ──────────────────────────────────────────────────────────────────────────
  describe('pattern creation (live run)', () => {
    beforeEach(() => {
      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 1,
        details: [makeClusterDetail()],
      });
      mockPrisma.memory.findMany.mockResolvedValue(makeMemories(['mem-1', 'mem-2', 'mem-3']));
      mockPrisma.memory.findFirst
        .mockResolvedValueOnce(null) // no existing pattern
        .mockResolvedValueOnce({ id: 'pattern-mem-1' }); // after create
      mockPrisma.memory.create.mockResolvedValue({ id: 'pattern-mem-1' });
      mockPrisma.memoryChainLink.create.mockResolvedValue({});
      mockLLM.json.mockResolvedValue({ summary: 'User prefers mornings', confidence: 0.8 });
    });

    it('creates a pattern memory when confidence >= 0.6', async () => {
      const result = await stage.run('user-1', false, 5);

      expect(result.patternsCreated).toBe(1);
      expect(result.llmCalls).toBe(1);
      expect(mockPrisma.memory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            raw: 'User prefers mornings',
            layer: 'IDENTITY',
            source: 'PATTERN_DETECTED',
          }),
        }),
      );
    });

    it('creates chain links from source memories to pattern', async () => {
      await stage.run('user-1', false, 5);

      // Should create one link per source memory
      expect(mockPrisma.memoryChainLink.create).toHaveBeenCalledTimes(3);
      expect(mockPrisma.memoryChainLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            targetId: 'pattern-mem-1',
            linkType: 'SUPPORTS',
            createdBy: 'dream-cycle',
          }),
        }),
      );
    });

    it('emits dream.pattern_found event', async () => {
      await stage.run('user-1', false, 5);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'dream.pattern_found',
        expect.objectContaining({ patternId: 'pattern-mem-1' }),
      );
    });

    it('does NOT write to DB in dry-run mode but still counts pattern', async () => {
      const result = await stage.run('user-1', true, 5);

      expect(result.patternsCreated).toBe(1);
      expect(mockPrisma.memory.create).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Low confidence — no pattern
  // ──────────────────────────────────────────────────────────────────────────
  describe('when LLM confidence is below threshold', () => {
    it('does not create a pattern when confidence < 0.6', async () => {
      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 1,
        details: [makeClusterDetail()],
      });
      mockPrisma.memory.findMany.mockResolvedValue(makeMemories(['mem-1', 'mem-2', 'mem-3']));
      mockPrisma.memory.findFirst.mockResolvedValue(null);
      mockLLM.json.mockResolvedValue({ summary: 'Weak pattern', confidence: 0.4 });

      const result = await stage.run('user-1', false, 5);

      expect(result.patternsCreated).toBe(0);
      expect(mockPrisma.memory.create).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Skip conditions
  // ──────────────────────────────────────────────────────────────────────────
  describe('skip conditions', () => {
    it('skips cluster when memories fetched < minSize (3)', async () => {
      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 1,
        details: [makeClusterDetail()],
      });
      // Only 2 memories returned (below minSize of 3)
      mockPrisma.memory.findMany.mockResolvedValue(makeMemories(['mem-1', 'mem-2']));
      mockPrisma.memory.findFirst.mockResolvedValue(null);

      const result = await stage.run('user-1', false, 5);

      expect(result.patternsCreated).toBe(0);
      expect(mockLLM.json).not.toHaveBeenCalled();
    });

    it('skips cluster when existing pattern already covers those memories', async () => {
      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 1,
        details: [makeClusterDetail()],
      });
      mockPrisma.memory.findMany.mockResolvedValue(makeMemories(['mem-1', 'mem-2', 'mem-3']));
      // Existing pattern found
      mockPrisma.memory.findFirst.mockResolvedValue({ id: 'existing-pattern' });

      const result = await stage.run('user-1', false, 5);

      expect(result.patternsCreated).toBe(0);
      expect(mockLLM.json).not.toHaveBeenCalled();
    });

    it('respects LLM budget — stops after budget exhausted', async () => {
      const details = [makeClusterDetail(), makeClusterDetail({ canonicalId: 'mem-4', duplicateIds: ['mem-5', 'mem-6'] })];
      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 2,
        details,
      });
      mockPrisma.memory.findMany.mockResolvedValue(makeMemories(['mem-1', 'mem-2', 'mem-3']));
      mockPrisma.memory.findFirst
        .mockResolvedValue(null); // no existing patterns
      mockPrisma.memory.create.mockResolvedValue({});
      mockPrisma.memory.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      mockLLM.json.mockResolvedValue({ summary: 'Pattern', confidence: 0.8 });

      // Budget of 1 — only first cluster processed
      const result = await stage.run('user-1', false, 1);

      expect(result.llmCalls).toBe(1);
      expect(mockLLM.json).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Error handling
  // ──────────────────────────────────────────────────────────────────────────
  describe('error handling', () => {
    it('catches LLM errors per-cluster and continues', async () => {
      const details = [
        makeClusterDetail({ canonicalId: 'mem-1', duplicateIds: ['mem-2', 'mem-3'] }),
        makeClusterDetail({ canonicalId: 'mem-4', duplicateIds: ['mem-5', 'mem-6'] }),
      ];
      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 2,
        details,
      });
      mockPrisma.memory.findMany.mockResolvedValue(makeMemories(['mem-1', 'mem-2', 'mem-3']));
      mockPrisma.memory.findFirst.mockResolvedValue(null);
      mockPrisma.memory.create.mockResolvedValue({});
      mockPrisma.memory.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'p1' });

      // First call fails, second succeeds
      mockLLM.json
        .mockRejectedValueOnce(new Error('LLM timeout'))
        .mockResolvedValueOnce({ summary: 'Good pattern', confidence: 0.85 });

      const result = await stage.run('user-1', false, 5);

      // Stage should not throw; second cluster still processed
      expect(result.llmCalls).toBe(1); // only the successful call
    });

    it('handles missing eventEmitter gracefully (no crash)', async () => {
      const stageWithoutEmitter = makeStage(undefined);

      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 1,
        details: [makeClusterDetail()],
      });
      mockPrisma.memory.findMany.mockResolvedValue(makeMemories(['mem-1', 'mem-2', 'mem-3']));
      mockPrisma.memory.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'pattern-x' });
      mockPrisma.memory.create.mockResolvedValue({});
      mockPrisma.memoryChainLink.create.mockResolvedValue({});
      mockLLM.json.mockResolvedValue({ summary: 'A pattern', confidence: 0.75 });

      // Should not throw even without event emitter
      await expect(stageWithoutEmitter.run('user-1', false, 5)).resolves.toBeDefined();
    });

    it('handles chain link creation failure without crashing (swallowed)', async () => {
      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 1,
        details: [makeClusterDetail()],
      });
      mockPrisma.memory.findMany.mockResolvedValue(makeMemories(['mem-1', 'mem-2', 'mem-3']));
      mockPrisma.memory.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'pattern-y' });
      mockPrisma.memory.create.mockResolvedValue({});
      mockPrisma.memoryChainLink.create.mockRejectedValue(new Error('unique constraint'));
      mockLLM.json.mockResolvedValue({ summary: 'Pattern', confidence: 0.9 });

      // Chain link errors are swallowed — should not throw
      await expect(stage.run('user-1', false, 5)).resolves.toBeDefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Config — custom minSize
  // ──────────────────────────────────────────────────────────────────────────
  describe('DREAM_PATTERN_MIN_SIZE config', () => {
    it('uses configured minSize when checking cluster validity', async () => {
      // Stage with minSize=5
      const configWith5 = {
        get: jest.fn((key: string, defaultValue?: string) =>
          key === 'DREAM_PATTERN_MIN_SIZE' ? '5' : defaultValue,
        ),
      };
      const stageWith5 = new DreamCyclePatternsStage(
        mockPrisma as unknown as ServicePrismaService,
        mockConsolidation as unknown as ConsolidationService,
        mockLLM as unknown as LLMService,
        configWith5 as unknown as ConfigService,
        undefined,
      );

      mockConsolidation.promoteRecurringPatterns.mockResolvedValue({
        clustersFound: 1,
        details: [makeClusterDetail()],
      });
      // Only 3 memories — below minSize of 5
      mockPrisma.memory.findMany.mockResolvedValue(makeMemories(['mem-1', 'mem-2', 'mem-3']));
      mockPrisma.memory.findFirst.mockResolvedValue(null);

      const result = await stageWith5.run('user-1', false, 5);
      expect(result.patternsCreated).toBe(0);
      expect(mockLLM.json).not.toHaveBeenCalled();
    });
  });
});
