import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DreamCycleDedupStage } from './dream-cycle-dedup.stage';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingService } from '../../memory/embedding.service';
import { LLMService } from '../../llm/llm.service';
import { TemporalSamplingService } from '../temporal-sampling.service';

const defaultStats = { totalAvailable: 0, sampleSize: 0, tierBreakdown: { recent: 0, midRange: 0, deep: 0, random: 0 } };

function mockSample(memories: any[]) {
  const sampled = memories.map((m: any) => ({ ...m, tier: 'recent', retrievalCount: 0, layer: m.layer ?? 'GENERAL' }));
  mockTemporalSampling.sampleMemories.mockResolvedValue({
    memories: sampled,
    totalAvailable: sampled.length,
    tierStats: { recent: sampled.length, midRange: 0, deep: 0, random: 0 },
  });
}

const mockTemporalSampling = {
  sampleMemories: jest.fn().mockResolvedValue({ memories: [], totalAvailable: 0, tierStats: { recent: 0, midRange: 0, deep: 0, random: 0 } }),
  getSamplingStats: jest.fn().mockResolvedValue({ totalAvailable: 0 }),
};

const mockPrisma = {
  memory: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  memoryMergeEvent: { create: jest.fn() },
  mergeCandidate: { create: jest.fn() },
  $queryRawUnsafe: jest.fn(),
};

const mockEmbedding = { search: jest.fn() };
const mockLlm = { json: jest.fn() };
const mockConfig = {
  get: jest.fn((key: string, def?: string) => {
    const vals: Record<string, string> = {
      DREAM_DEDUP_THRESHOLD: '0.85',
      DREAM_MAX_MERGES: '200',
      DREAM_MAX_LLM_CALLS: '50',
    };
    return vals[key] ?? def;
  }),
};

describe('DreamCycleDedupStage', () => {
  let stage: DreamCycleDedupStage;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DreamCycleDedupStage,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbeddingService, useValue: mockEmbedding },
        { provide: LLMService, useValue: mockLlm },
        { provide: ConfigService, useValue: mockConfig },
        { provide: TemporalSamplingService, useValue: mockTemporalSampling },
      ],
    }).compile();
    stage = module.get<DreamCycleDedupStage>(DreamCycleDedupStage);
  });

  it('should return zeros when fewer than 2 memories', async () => {
    mockPrisma.memory.findMany.mockResolvedValue([{ id: '1', raw: 'test' }]);
    mockSample([{ id: '1', raw: 'test' }]);
    const result = await stage.run('user1', false);
    expect(result).toEqual(expect.objectContaining({ merged: 0, flagged: 0, scanned: 1, llmCalls: 0 }));
  });

  it('should skip memories without embeddings', async () => {
    const mems = [
      { id: '1', raw: 'a', importanceScore: 1, effectiveScore: 1, memoryType: 'FACT' },
      { id: '2', raw: 'b', importanceScore: 1, effectiveScore: 1, memoryType: 'FACT' },
    ];
    mockPrisma.memory.findMany.mockResolvedValue(mems);
    mockSample(mems);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    const result = await stage.run('user1', false);
    expect(result.merged).toBe(0);
    expect(result.scanned).toBe(2);
  });

  it('should auto-merge high similarity non-protected memories', async () => {
    const memories = [
      {
        id: '1',
        raw: 'fact A',
        importanceScore: 5,
        effectiveScore: 5,
        memoryType: 'FACT',
        createdAt: new Date(),
      },
      {
        id: '2',
        raw: 'fact A again',
        importanceScore: 3,
        effectiveScore: 3,
        memoryType: 'FACT',
        createdAt: new Date(),
      },
    ];
    mockPrisma.memory.findMany.mockResolvedValue(memories);
    mockSample(memories);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ embedding: '[0.1,0.2]' }]);
    mockEmbedding.search.mockResolvedValue([
      { id: '2', score: 0.96 }, // above 0.95 auto-merge threshold
    ]);
    mockPrisma.memory.findUnique.mockResolvedValue({ userId: 'user1' });
    mockPrisma.memoryMergeEvent.create.mockResolvedValue({});
    mockPrisma.memory.update.mockResolvedValue({});

    const result = await stage.run('user1', false);
    expect(result.merged).toBe(1);
    expect(mockPrisma.memoryMergeEvent.create).toHaveBeenCalled();
  });

  it('should not auto-merge protected memory types (CONSTRAINT/LESSON)', async () => {
    const memories = [
      {
        id: '1',
        raw: 'rule',
        importanceScore: 5,
        effectiveScore: 5,
        memoryType: 'FACT',
        createdAt: new Date(),
      },
      {
        id: '2',
        raw: 'rule copy',
        importanceScore: 3,
        effectiveScore: 3,
        memoryType: 'CONSTRAINT',
        createdAt: new Date(),
      },
    ];
    mockPrisma.memory.findMany.mockResolvedValue(memories);
    mockSample(memories);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ embedding: '[0.1,0.2]' }]);
    mockEmbedding.search.mockResolvedValue([
      { id: '2', score: 0.96 }, // above 0.95 but match is protected
    ]);
    // Should fall through to LLM decision since protected needs 0.98
    mockLlm.json.mockResolvedValue({ shouldMerge: false, reason: 'protected' });
    mockPrisma.mergeCandidate.create.mockResolvedValue({});

    const result = await stage.run('user1', false);
    expect(result.merged).toBe(0);
    expect(result.flagged).toBe(1);
    expect(result.llmCalls).toBe(1);
  });

  it('should auto-merge at 0.90 without LLM (below old threshold, above new)', async () => {
    const memories = [
      {
        id: '1',
        raw: 'likes coffee',
        importanceScore: 5,
        effectiveScore: 5,
        memoryType: 'FACT',
        createdAt: new Date(),
      },
      {
        id: '2',
        raw: 'enjoys coffee',
        importanceScore: 3,
        effectiveScore: 3,
        memoryType: 'FACT',
        createdAt: new Date(),
      },
    ];
    mockPrisma.memory.findMany.mockResolvedValue(memories);
    mockSample(memories);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ embedding: '[0.1]' }]);
    mockEmbedding.search.mockResolvedValue([
      { id: '2', score: 0.9 }, // above 0.88 auto-merge threshold
    ]);
    mockPrisma.memory.findUnique.mockResolvedValue({ userId: 'user1' });
    mockPrisma.memoryMergeEvent.create.mockResolvedValue({});
    mockPrisma.memory.update.mockResolvedValue({});

    const result = await stage.run('user1', false);
    expect(result.merged).toBe(1);
    expect(result.llmCalls).toBe(0); // No LLM needed, auto-merged directly
  });

  it('should respect dryRun mode', async () => {
    const memories = [
      {
        id: '1',
        raw: 'a',
        importanceScore: 5,
        effectiveScore: 5,
        memoryType: 'FACT',
        createdAt: new Date(),
      },
      {
        id: '2',
        raw: 'a',
        importanceScore: 3,
        effectiveScore: 3,
        memoryType: 'FACT',
        createdAt: new Date(),
      },
    ];
    mockPrisma.memory.findMany.mockResolvedValue(memories);
    mockSample(memories);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ embedding: '[0.1]' }]);
    mockEmbedding.search.mockResolvedValue([{ id: '2', score: 0.96 }]);

    const result = await stage.run('user1', true);
    expect(result.merged).toBe(1);
    expect(mockPrisma.memoryMergeEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.memory.update).not.toHaveBeenCalled();
  });

  it('should handle embedding query errors gracefully', async () => {
    mockPrisma.memory.findMany.mockResolvedValue([
      {
        id: '1',
        raw: 'a',
        importanceScore: 1,
        effectiveScore: 1,
        memoryType: 'FACT',
      },
      {
        id: '2',
        raw: 'b',
        importanceScore: 1,
        effectiveScore: 1,
        memoryType: 'FACT',
      },
    ]);
    mockPrisma.$queryRawUnsafe.mockRejectedValue(new Error('db error'));
    const result = await stage.run('user1', false);
    expect(result.merged).toBe(0);
  });

  it('should handle LLM errors gracefully (default to no merge)', async () => {
    const memories = [
      {
        id: '1',
        raw: 'x',
        importanceScore: 5,
        effectiveScore: 5,
        memoryType: 'FACT',
        createdAt: new Date(),
      },
      {
        id: '2',
        raw: 'y',
        importanceScore: 3,
        effectiveScore: 3,
        memoryType: 'FACT',
        createdAt: new Date(),
      },
    ];
    mockPrisma.memory.findMany.mockResolvedValue(memories);
    mockSample(memories);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ embedding: '[0.1]' }]);
    mockEmbedding.search.mockResolvedValue([{ id: '2', score: 0.86 }]);
    mockLlm.json.mockRejectedValue(new Error('LLM timeout'));
    mockPrisma.mergeCandidate.create.mockResolvedValue({});

    const result = await stage.run('user1', false);
    expect(result.merged).toBe(0);
    // LLM returned false on error, so it flags
    expect(result.llmCalls).toBe(1);
  });
});
