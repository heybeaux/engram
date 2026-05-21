import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  DreamCyclePendingStage,
  PendingStageResult,
} from './dream-cycle-pending.stage';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { LLMService } from '../../llm/llm.service';

const mockPrisma = {
  mergeCandidate: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  memory: {
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  memoryMergeEvent: {
    create: jest.fn(),
  },
};

const mockLLM = {
  json: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const cfg: Record<string, string> = {
      DREAM_PENDING_BATCH_SIZE: '100',
    };
    return cfg[key] ?? defaultValue;
  }),
};

const makeCandidate = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'cand-1',
  userId: 'user-1',
  memoryIds: ['mem-a', 'mem-b'],
  suggestedSurvivorId: 'mem-a',
  similarity: 0.85,
  status: 'PENDING',
  createdAt: new Date('2026-03-01'),
  ...overrides,
});

const makeMemory = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'mem-a',
  raw: 'I prefer dark chocolate',
  memoryType: 'FACT',
  effectiveScore: 0.8,
  safetyCritical: false,
  deletedAt: null,
  ...overrides,
});

describe('DreamCyclePendingStage', () => {
  let stage: DreamCyclePendingStage;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DreamCyclePendingStage,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: LLMService, useValue: mockLLM },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    stage = module.get<DreamCyclePendingStage>(DreamCyclePendingStage);

    // Default stubs
    mockPrisma.memory.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.memory.update.mockResolvedValue({});
    mockPrisma.mergeCandidate.update.mockResolvedValue({});
    mockPrisma.memoryMergeEvent.create.mockResolvedValue({});
  });

  describe('run() — no candidates', () => {
    it('should return zeros when no PENDING candidates exist', async () => {
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([]);

      const result = await stage.run('user-1', false);

      expect(result).toEqual<PendingStageResult>({
        processed: 0,
        autoMerged: 0,
        autoRejected: 0,
        llmEvaluated: 0,
        llmMerged: 0,
        llmRejected: 0,
        llmCalls: 0,
        errors: 0,
      });
      expect(mockPrisma.memory.update).not.toHaveBeenCalled();
    });
  });

  describe('run() — auto-merge (similarity >= 0.9)', () => {
    it('should auto-merge high-similarity candidates', async () => {
      const candidate = makeCandidate({ similarity: 0.95 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a', effectiveScore: 0.8 }),
        makeMemory({ id: 'mem-b', effectiveScore: 0.6 }),
      ]);

      const result = await stage.run('user-1', false);

      expect(result.autoMerged).toBe(1);
      expect(result.processed).toBe(1);
      expect(result.autoRejected).toBe(0);
      expect(result.llmCalls).toBe(0);

      // Merge event should be created
      expect(mockPrisma.memoryMergeEvent.create).toHaveBeenCalled();

      // Candidate status updated to MERGED
      expect(mockPrisma.mergeCandidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cand-1' },
          data: expect.objectContaining({ status: 'MERGED' }),
        }),
      );
    });

    it('should NOT merge in dry-run mode', async () => {
      const candidate = makeCandidate({ similarity: 0.95 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);

      const result = await stage.run('user-1', true /* dryRun */);

      expect(result.autoMerged).toBe(1);
      expect(mockPrisma.memoryMergeEvent.create).not.toHaveBeenCalled();
      expect(mockPrisma.mergeCandidate.update).not.toHaveBeenCalled();
    });

    it('should use suggestedSurvivorId when provided', async () => {
      const candidate = makeCandidate({
        similarity: 0.95,
        suggestedSurvivorId: 'mem-b', // B is suggested, even though A has higher score
      });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a', effectiveScore: 0.9 }),
        makeMemory({ id: 'mem-b', effectiveScore: 0.5 }),
      ]);

      await stage.run('user-1', false);

      // Survivor should be mem-b (suggested), absorbed should be mem-a
      expect(mockPrisma.memoryMergeEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ survivorMemoryId: 'mem-b' }),
        }),
      );
    });

    it('should fall back to highest effectiveScore if no suggestedSurvivorId', async () => {
      const candidate = makeCandidate({
        similarity: 0.95,
        suggestedSurvivorId: null,
      });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a', effectiveScore: 0.3 }),
        makeMemory({ id: 'mem-b', effectiveScore: 0.9 }),
      ]);

      await stage.run('user-1', false);

      // mem-b has higher score, should be survivor
      expect(mockPrisma.memoryMergeEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ survivorMemoryId: 'mem-b' }),
        }),
      );
    });
  });

  describe('run() — auto-reject (similarity < 0.82)', () => {
    it('should auto-reject low-similarity candidates', async () => {
      const candidate = makeCandidate({ similarity: 0.75 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);

      const result = await stage.run('user-1', false);

      expect(result.autoRejected).toBe(1);
      expect(result.autoMerged).toBe(0);
      expect(result.llmCalls).toBe(0);

      expect(mockPrisma.mergeCandidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'REJECTED' }),
        }),
      );
      expect(mockPrisma.memoryMergeEvent.create).not.toHaveBeenCalled();
    });

    it('should NOT update status in dry-run mode', async () => {
      const candidate = makeCandidate({ similarity: 0.5 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);

      const result = await stage.run('user-1', true);

      expect(result.autoRejected).toBe(1);
      expect(mockPrisma.mergeCandidate.update).not.toHaveBeenCalled();
    });
  });

  describe('run() — LLM evaluation (0.82 <= similarity < 0.90)', () => {
    it('should send medium-similarity candidates to LLM', async () => {
      const candidate = makeCandidate({ similarity: 0.85 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a' }),
        makeMemory({ id: 'mem-b' }),
      ]);
      mockLLM.json.mockResolvedValue({
        shouldMerge: true,
        confidence: 0.9,
        reason: 'Same core fact',
      });

      const result = await stage.run('user-1', false, 5 /* maxLlmCalls */);

      expect(result.llmEvaluated).toBe(1);
      expect(result.llmMerged).toBe(1);
      expect(result.llmRejected).toBe(0);
      expect(result.llmCalls).toBe(1);
    });

    it('should reject when LLM returns shouldMerge: false', async () => {
      const candidate = makeCandidate({ similarity: 0.85 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a' }),
        makeMemory({ id: 'mem-b' }),
      ]);
      mockLLM.json.mockResolvedValue({
        shouldMerge: false,
        confidence: 0.9,
        reason: 'Subtle but meaningful difference',
      });

      const result = await stage.run('user-1', false, 5);

      expect(result.llmMerged).toBe(0);
      expect(result.llmRejected).toBe(1);

      expect(mockPrisma.mergeCandidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'REJECTED' }),
        }),
      );
    });

    it('should reject when LLM confidence < 0.7 even if shouldMerge: true', async () => {
      const candidate = makeCandidate({ similarity: 0.85 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a' }),
        makeMemory({ id: 'mem-b' }),
      ]);
      mockLLM.json.mockResolvedValue({
        shouldMerge: true,
        confidence: 0.5, // low confidence
        reason: 'Unsure',
      });

      const result = await stage.run('user-1', false, 5);

      expect(result.llmMerged).toBe(0);
      expect(result.llmRejected).toBe(1);
    });

    it('should skip LLM evaluation if maxLlmCalls is 0', async () => {
      const candidate = makeCandidate({ similarity: 0.85 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);

      const result = await stage.run('user-1', false, 0 /* maxLlmCalls=0 */);

      expect(result.llmCalls).toBe(0);
      expect(mockLLM.json).not.toHaveBeenCalled();
    });

    it('should stop processing after reaching maxLlmCalls limit', async () => {
      const candidates = [
        makeCandidate({ id: 'c1', similarity: 0.85 }),
        makeCandidate({ id: 'c2', similarity: 0.86 }),
        makeCandidate({ id: 'c3', similarity: 0.87 }),
      ];
      mockPrisma.mergeCandidate.findMany.mockResolvedValue(candidates);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a' }),
        makeMemory({ id: 'mem-b' }),
      ]);
      mockLLM.json.mockResolvedValue({
        shouldMerge: false,
        confidence: 0.9,
        reason: 'diff',
      });

      const result = await stage.run('user-1', false, 1 /* maxLlmCalls=1 */);

      // Only one LLM call allowed, second candidate should cause break
      expect(result.llmCalls).toBe(1);
      expect(result.processed).toBeLessThan(3);
    });

    it('should not merge safety-critical memories', async () => {
      const candidate = makeCandidate({ similarity: 0.85 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a', safetyCritical: true }),
        makeMemory({ id: 'mem-b' }),
      ]);

      const result = await stage.run('user-1', false, 5);

      expect(result.llmMerged).toBe(0);
      expect(result.llmRejected).toBe(1);
      // LLM should not be called for safety-critical
      expect(mockLLM.json).not.toHaveBeenCalled();
    });

    it('should return false (reject) when LLM throws', async () => {
      const candidate = makeCandidate({ similarity: 0.85 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a' }),
        makeMemory({ id: 'mem-b' }),
      ]);
      mockLLM.json.mockRejectedValue(new Error('LLM timeout'));

      const result = await stage.run('user-1', false, 5);

      // LLM error → conservative reject
      expect(result.llmMerged).toBe(0);
      expect(result.llmRejected).toBe(1);
    });
  });

  describe('run() — error handling', () => {
    it('should increment errors counter and continue on candidate errors', async () => {
      const candidates = [
        makeCandidate({ id: 'c1', similarity: 0.95 }),
        makeCandidate({ id: 'c2', similarity: 0.95 }),
      ];
      mockPrisma.mergeCandidate.findMany.mockResolvedValue(candidates);
      mockPrisma.memory.findMany
        .mockRejectedValueOnce(new Error('DB error for c1'))
        .mockResolvedValueOnce([
          makeMemory({ id: 'mem-a' }),
          makeMemory({ id: 'mem-b' }),
        ]);

      const result = await stage.run('user-1', false);

      expect(result.errors).toBe(1);
      expect(result.processed).toBe(2); // both processed, one with error
      expect(result.autoMerged).toBe(1); // second one still succeeds
    });

    it('should still update lastDreamedAt even when processing errors', async () => {
      const candidate = makeCandidate({ similarity: 0.95 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      // Fail the main merge but succeed updateMany
      mockPrisma.memory.findMany.mockRejectedValue(new Error('DB failure'));
      mockPrisma.memory.updateMany.mockResolvedValue({ count: 2 });

      await stage.run('user-1', false);

      // lastDreamedAt should still be updated for tracking
      expect(mockPrisma.memory.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: { in: ['mem-a', 'mem-b'] },
            userId: 'user-1',
            deletedAt: null,
          },
          data: { lastDreamedAt: expect.any(Date) },
        }),
      );
    });

    it('should throw when performMerge finds fewer memories than expected', async () => {
      const candidate = makeCandidate({ similarity: 0.95 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      // Only return 1 memory when 2 are expected
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a' }),
      ]);

      const result = await stage.run('user-1', false);

      expect(result.errors).toBe(1);
    });
  });

  describe('run() — account isolation (userId scoping)', () => {
    it('should include userId in performMerge memory query', async () => {
      const candidate = makeCandidate({ similarity: 0.95, userId: 'user-1' });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a', effectiveScore: 0.8 }),
        makeMemory({ id: 'mem-b', effectiveScore: 0.6 }),
      ]);

      await stage.run('user-1', false);

      // performMerge should scope memory lookup by userId
      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1' }),
        }),
      );
    });

    it('should include userId in LLM merge decision memory query', async () => {
      const candidate = makeCandidate({ similarity: 0.85, userId: 'user-1' });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a' }),
        makeMemory({ id: 'mem-b' }),
      ]);
      mockLLM.json.mockResolvedValue({
        shouldMerge: false,
        confidence: 0.9,
        reason: 'diff',
      });

      await stage.run('user-1', false, 5);

      // llmMergeDecision should scope memory lookup by userId
      const findManyCalls = mockPrisma.memory.findMany.mock.calls;
      const llmCall = findManyCalls.find(
        (call: any) =>
          call[0]?.where?.id?.in &&
          call[0]?.select?.safetyCritical !== undefined,
      );
      expect(llmCall?.[0]?.where).toHaveProperty('userId', 'user-1');
    });

    it('should include userId in updateMemoriesLastDreamedAt', async () => {
      const candidate = makeCandidate({ similarity: 0.95 });
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a', effectiveScore: 0.8 }),
        makeMemory({ id: 'mem-b', effectiveScore: 0.6 }),
      ]);

      await stage.run('user-1', false);

      expect(mockPrisma.memory.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1' }),
        }),
      );
    });
  });

  describe('run() — mixed scenarios', () => {
    it('should handle a batch with all three action types', async () => {
      const candidates = [
        makeCandidate({ id: 'c-high', similarity: 0.95 }),
        makeCandidate({ id: 'c-mid', similarity: 0.85 }),
        makeCandidate({ id: 'c-low', similarity: 0.7 }),
      ];
      mockPrisma.mergeCandidate.findMany.mockResolvedValue(candidates);
      mockPrisma.memory.findMany.mockResolvedValue([
        makeMemory({ id: 'mem-a' }),
        makeMemory({ id: 'mem-b' }),
      ]);
      mockLLM.json.mockResolvedValue({
        shouldMerge: true,
        confidence: 0.8,
        reason: 'ok',
      });

      const result = await stage.run('user-1', false, 5);

      expect(result.autoMerged).toBe(1);
      expect(result.llmMerged).toBe(1);
      expect(result.autoRejected).toBe(1);
      expect(result.processed).toBe(3);
    });
  });
});
