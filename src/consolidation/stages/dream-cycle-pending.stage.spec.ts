import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DreamCyclePendingStage } from './dream-cycle-pending.stage';
import { PrismaService } from '../../prisma/prisma.service';
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

const mockLlm = {
  json: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, def?: string) => {
    const vals: Record<string, string> = {
      DREAM_PENDING_BATCH_SIZE: '100',
    };
    return vals[key] ?? def;
  }),
};

function makeCandidate(overrides: Partial<any> = {}) {
  return {
    id: 'cand-1',
    userId: 'user-1',
    status: 'PENDING',
    similarity: 0.95,
    memoryIds: ['mem-1', 'mem-2'],
    suggestedSurvivorId: 'mem-1',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeMemory(id: string, overrides: Partial<any> = {}) {
  return {
    id,
    raw: `Memory content for ${id}`,
    effectiveScore: 5,
    memoryType: 'FACT',
    safetyCritical: false,
    ...overrides,
  };
}

describe('DreamCyclePendingStage', () => {
  let stage: DreamCyclePendingStage;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DreamCyclePendingStage,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LLMService, useValue: mockLlm },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    stage = module.get<DreamCyclePendingStage>(DreamCyclePendingStage);
    mockPrisma.memory.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.mergeCandidate.update.mockResolvedValue({});
    mockPrisma.memoryMergeEvent.create.mockResolvedValue({});
    mockPrisma.memory.update.mockResolvedValue({});
  });

  // --- No candidates ---
  it('should return zero result when no pending candidates', async () => {
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([]);

    const result = await stage.run('user-1', false);

    expect(result.processed).toBe(0);
    expect(result.autoMerged).toBe(0);
    expect(result.errors).toBe(0);
  });

  // --- Auto-merge (similarity >= 0.9) ---
  it('should auto-merge candidates with similarity >= 0.9', async () => {
    const candidate = makeCandidate({ similarity: 0.95 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    mockPrisma.memory.findMany.mockResolvedValue([
      makeMemory('mem-1', { effectiveScore: 10 }),
      makeMemory('mem-2', { effectiveScore: 5 }),
    ]);

    const result = await stage.run('user-1', false);

    expect(result.processed).toBe(1);
    expect(result.autoMerged).toBe(1);
    expect(result.autoRejected).toBe(0);
    expect(mockPrisma.memoryMergeEvent.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.mergeCandidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cand-1' },
        data: expect.objectContaining({
          status: 'MERGED',
          reviewNotes: 'Auto-merged: similarity >= 0.90',
        }),
      }),
    );
  });

  // --- Auto-reject (similarity < 0.82) ---
  it('should auto-reject candidates with similarity < 0.82', async () => {
    const candidate = makeCandidate({ similarity: 0.75 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);

    const result = await stage.run('user-1', false);

    expect(result.processed).toBe(1);
    expect(result.autoRejected).toBe(1);
    expect(result.autoMerged).toBe(0);
    expect(mockPrisma.mergeCandidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REJECTED',
          reviewNotes: 'Auto-rejected: similarity < 0.82',
        }),
      }),
    );
  });

  // --- LLM evaluation (0.82 <= similarity < 0.9, LLM approves) ---
  it('should use LLM for medium similarity and merge when approved', async () => {
    const candidate = makeCandidate({ similarity: 0.86 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    mockPrisma.memory.findMany
      .mockResolvedValueOnce([makeMemory('mem-1'), makeMemory('mem-2')]) // for llmMergeDecision
      .mockResolvedValueOnce([
        makeMemory('mem-1', { effectiveScore: 10 }),
        makeMemory('mem-2', { effectiveScore: 5 }),
      ]); // for performMerge
    mockLlm.json.mockResolvedValue({
      shouldMerge: true,
      confidence: 0.85,
      reason: 'Same fact',
    });

    const result = await stage.run('user-1', false, 5);

    expect(result.llmEvaluated).toBe(1);
    expect(result.llmMerged).toBe(1);
    expect(result.llmRejected).toBe(0);
    expect(result.llmCalls).toBe(1);
    expect(mockLlm.json).toHaveBeenCalledTimes(1);
  });

  // --- LLM evaluation rejects ---
  it('should reject when LLM declines merge', async () => {
    const candidate = makeCandidate({ similarity: 0.85 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    mockPrisma.memory.findMany.mockResolvedValue([
      makeMemory('mem-1'),
      makeMemory('mem-2'),
    ]);
    mockLlm.json.mockResolvedValue({
      shouldMerge: false,
      confidence: 0.9,
      reason: 'Different facts',
    });

    const result = await stage.run('user-1', false, 5);

    expect(result.llmEvaluated).toBe(1);
    expect(result.llmRejected).toBe(1);
    expect(result.llmMerged).toBe(0);
    expect(mockPrisma.mergeCandidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REJECTED',
          reviewNotes: 'LLM declined merge',
        }),
      }),
    );
  });

  // --- LLM low confidence ---
  it('should reject when LLM confidence is below 0.7', async () => {
    const candidate = makeCandidate({ similarity: 0.85 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    mockPrisma.memory.findMany.mockResolvedValue([
      makeMemory('mem-1'),
      makeMemory('mem-2'),
    ]);
    mockLlm.json.mockResolvedValue({
      shouldMerge: true,
      confidence: 0.5,
      reason: 'Uncertain',
    });

    const result = await stage.run('user-1', false, 5);

    expect(result.llmRejected).toBe(1);
    expect(result.llmMerged).toBe(0);
  });

  // --- Safety-critical memories ---
  it('should decline merge for safety-critical memories', async () => {
    const candidate = makeCandidate({ similarity: 0.86 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    mockPrisma.memory.findMany.mockResolvedValue([
      makeMemory('mem-1', { safetyCritical: true }),
      makeMemory('mem-2'),
    ]);

    const result = await stage.run('user-1', false, 5);

    expect(result.llmRejected).toBe(1);
    expect(mockLlm.json).not.toHaveBeenCalled();
  });

  // --- LLM call limit ---
  it('should stop processing when LLM call limit is reached', async () => {
    const candidates = [
      makeCandidate({ id: 'cand-1', similarity: 0.85 }),
      makeCandidate({ id: 'cand-2', similarity: 0.86 }),
      makeCandidate({ id: 'cand-3', similarity: 0.87 }),
    ];
    mockPrisma.mergeCandidate.findMany.mockResolvedValue(candidates);
    mockPrisma.memory.findMany.mockResolvedValue([
      makeMemory('mem-1'),
      makeMemory('mem-2'),
    ]);
    mockLlm.json.mockResolvedValue({
      shouldMerge: false,
      confidence: 0.9,
      reason: 'Different',
    });

    const result = await stage.run('user-1', false, 1);

    expect(result.llmCalls).toBe(1);
    // Should break after first LLM call since limit is 1
    expect(result.processed).toBe(2); // processes first, then hits limit on second and breaks
  });

  // --- No maxLlmCalls skips medium similarity ---
  it('should skip medium-similarity candidates when maxLlmCalls is undefined', async () => {
    const candidate = makeCandidate({ similarity: 0.85 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);

    const result = await stage.run('user-1', false);

    // maxLlmCalls is undefined, so the `else if (maxLlmCalls && ...)` is falsy → breaks
    expect(result.processed).toBe(1);
    expect(result.llmEvaluated).toBe(0);
  });

  // --- Dry run ---
  it('should not perform mutations in dry run mode', async () => {
    const candidates = [
      makeCandidate({ id: 'cand-1', similarity: 0.95 }),
      makeCandidate({ id: 'cand-2', similarity: 0.75 }),
    ];
    mockPrisma.mergeCandidate.findMany.mockResolvedValue(candidates);

    const result = await stage.run('user-1', true);

    expect(result.autoMerged).toBe(1);
    expect(result.autoRejected).toBe(1);
    expect(mockPrisma.memory.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.mergeCandidate.update).not.toHaveBeenCalled();
    expect(mockPrisma.memoryMergeEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.memory.updateMany).not.toHaveBeenCalled();
  });

  // --- Error handling ---
  it('should count errors and continue processing', async () => {
    const candidates = [
      makeCandidate({ id: 'cand-1', similarity: 0.95 }),
      makeCandidate({ id: 'cand-2', similarity: 0.95 }),
    ];
    mockPrisma.mergeCandidate.findMany.mockResolvedValue(candidates);
    mockPrisma.memory.findMany
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce([
        makeMemory('mem-1', { effectiveScore: 10 }),
        makeMemory('mem-2', { effectiveScore: 5 }),
      ]);

    const result = await stage.run('user-1', false);

    expect(result.errors).toBe(1);
    expect(result.autoMerged).toBe(1); // first errors in performMerge, second succeeds
  });

  // --- Error with lastDreamedAt update failure ---
  it('should handle error in lastDreamedAt update during error recovery', async () => {
    const candidate = makeCandidate({ similarity: 0.95 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    mockPrisma.memory.findMany.mockRejectedValue(new Error('DB error'));
    mockPrisma.memory.updateMany.mockRejectedValue(new Error('Update failed'));

    const result = await stage.run('user-1', false);

    expect(result.errors).toBe(1);
    expect(result.processed).toBe(1);
  });

  // --- performMerge: missing memories ---
  it('should error when some memories are not found during merge', async () => {
    const candidate = makeCandidate({ similarity: 0.95 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    // Return only 1 of 2 expected memories
    mockPrisma.memory.findMany.mockResolvedValue([makeMemory('mem-1')]);

    const result = await stage.run('user-1', false);

    expect(result.errors).toBe(1);
  });

  // --- performMerge uses suggestedSurvivorId ---
  it('should use suggestedSurvivorId for merge survivor', async () => {
    const candidate = makeCandidate({
      similarity: 0.95,
      suggestedSurvivorId: 'mem-2',
    });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    mockPrisma.memory.findMany.mockResolvedValue([
      makeMemory('mem-1', { effectiveScore: 10 }),
      makeMemory('mem-2', { effectiveScore: 5 }),
    ]);

    await stage.run('user-1', false);

    // mem-1 should be absorbed (mem-2 is survivor despite lower score)
    expect(mockPrisma.memory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'mem-1' },
        data: expect.objectContaining({
          consolidatedInto: 'mem-2',
        }),
      }),
    );
  });

  // --- LLM error falls back to false ---
  it('should return false (no merge) when LLM throws', async () => {
    const candidate = makeCandidate({ similarity: 0.86 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    mockPrisma.memory.findMany.mockResolvedValue([
      makeMemory('mem-1'),
      makeMemory('mem-2'),
    ]);
    mockLlm.json.mockRejectedValue(new Error('LLM timeout'));

    const result = await stage.run('user-1', false, 5);

    expect(result.llmRejected).toBe(1);
    expect(result.llmMerged).toBe(0);
  });

  // --- LLM with non-pair memories ---
  it('should decline merge when memory count is not 2 for LLM evaluation', async () => {
    const candidate = makeCandidate({
      similarity: 0.86,
      memoryIds: ['mem-1', 'mem-2', 'mem-3'],
    });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    mockPrisma.memory.findMany.mockResolvedValue([
      makeMemory('mem-1'),
      makeMemory('mem-2'),
      makeMemory('mem-3'),
    ]);

    const result = await stage.run('user-1', false, 5);

    expect(result.llmRejected).toBe(1);
    expect(mockLlm.json).not.toHaveBeenCalled();
  });

  // --- Mixed batch ---
  it('should handle mixed batch of auto-merge, auto-reject, and LLM candidates', async () => {
    const candidates = [
      makeCandidate({ id: 'c1', similarity: 0.95 }), // auto-merge
      makeCandidate({ id: 'c2', similarity: 0.7 }), // auto-reject
      makeCandidate({ id: 'c3', similarity: 0.85 }), // LLM
    ];
    mockPrisma.mergeCandidate.findMany.mockResolvedValue(candidates);
    mockPrisma.memory.findMany.mockResolvedValue([
      makeMemory('mem-1', { effectiveScore: 10 }),
      makeMemory('mem-2', { effectiveScore: 5 }),
    ]);
    mockLlm.json.mockResolvedValue({
      shouldMerge: true,
      confidence: 0.8,
      reason: 'Same',
    });

    const result = await stage.run('user-1', false, 5);

    expect(result.autoMerged).toBe(1);
    expect(result.autoRejected).toBe(1);
    expect(result.llmMerged).toBe(1);
    expect(result.processed).toBe(3);
  });

  // --- Boundary: exactly 0.9 similarity ---
  it('should auto-merge at exactly 0.9 similarity', async () => {
    const candidate = makeCandidate({ similarity: 0.9 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    mockPrisma.memory.findMany.mockResolvedValue([
      makeMemory('mem-1', { effectiveScore: 10 }),
      makeMemory('mem-2', { effectiveScore: 5 }),
    ]);

    const result = await stage.run('user-1', false);

    expect(result.autoMerged).toBe(1);
  });

  // --- Boundary: exactly 0.82 similarity ---
  it('should send to LLM at exactly 0.82 similarity (not auto-reject)', async () => {
    const candidate = makeCandidate({ similarity: 0.82 });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
    mockPrisma.memory.findMany.mockResolvedValue([
      makeMemory('mem-1'),
      makeMemory('mem-2'),
    ]);
    mockLlm.json.mockResolvedValue({
      shouldMerge: false,
      confidence: 0.9,
      reason: 'Different',
    });

    const result = await stage.run('user-1', false, 5);

    expect(result.llmEvaluated).toBe(1);
    expect(result.autoRejected).toBe(0);
  });

  // --- updateMemoriesLastDreamedAt with empty array ---
  it('should handle empty memoryIds gracefully in auto-reject', async () => {
    const candidate = makeCandidate({ similarity: 0.75, memoryIds: [] });
    mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);

    const result = await stage.run('user-1', false);

    expect(result.autoRejected).toBe(1);
    // updateMany should not be called for empty array
    expect(mockPrisma.memory.updateMany).not.toHaveBeenCalled();
  });
});
