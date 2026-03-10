import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RecallWeightService, RankedMemory } from './recall-weight.service';
import { PrismaService } from '../prisma/prisma.service';
import { Memory } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test-id',
    userId: 'user-1',
    raw: 'test',
    layer: 'SESSION',
    subjectType: 'USER',
    userPinned: false,
    userHidden: false,
    retrievalCount: 0,
    lastRetrievedAt: null,
    createdAt: new Date(Date.now() - 30 * DAY_MS),
    updatedAt: new Date(),
    deletedAt: null,
    importanceScore: 0.5,
    effectiveScore: null,
    confidence: 0.8,
    priority: 5,
    safetyCritical: false,
    supersededById: null,
    projectId: null,
    agentId: null,
    visibility: 'PRIVATE',
    usedCount: 0,
    lastUsedAt: null,
    source: 'EXPLICIT_STATEMENT',
    metadata: {},
    ...overrides,
  } as Memory;
}

function makeRankedMemory(
  memory: Partial<Memory> = {},
  score = 0.8,
  metadata = {},
): RankedMemory {
  return {
    memory: makeMemory(memory),
    score,
    metadata,
  };
}

describe('RecallWeightService', () => {
  let service: RecallWeightService;
  let mockPrismaService: any;

  const createService = async (envValue = 'true') => {
    mockPrismaService = {
      memory: {
        findMany: jest.fn(),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        RecallWeightService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue: string) =>
              key === 'RECALL_TIER_WEIGHT_ENABLED' ? envValue : defaultValue,
          },
        },
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    return module.get(RecallWeightService);
  };

  beforeEach(async () => {
    service = await createService();
  });

  describe('recallWeight', () => {
    const FROZEN_NOW = new Date('2026-03-04T12:00:00.000Z').getTime();

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(FROZEN_NOW);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns 1.0 for pinned memories', () => {
      const mem = makeMemory({ userPinned: true, lastRetrievedAt: null });
      expect(service.recallWeight(mem)).toBe(1.0);
    });

    it('returns 1.0 for HOT tier (accessed within 7 days)', () => {
      const mem = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 2 * DAY_MS),
      });
      expect(service.recallWeight(mem)).toBe(1.0);
    });

    it('returns 0.9 for WARM tier (accessed within 30 days)', () => {
      const mem = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 15 * DAY_MS),
      });
      expect(service.recallWeight(mem)).toBe(0.9);
    });

    it('returns 0.75 for COOLING tier (accessed within 90 days)', () => {
      const mem = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 60 * DAY_MS),
      });
      expect(service.recallWeight(mem)).toBe(0.75);
    });

    it('returns 0.8 for frequently accessed memories (> 0.1 retrievals/day)', () => {
      // 30 days old, 5 retrievals = 5/30 ≈ 0.167 > 0.1
      const mem = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 120 * DAY_MS),
        createdAt: new Date(Date.now() - 30 * DAY_MS),
        retrievalCount: 5,
      });
      expect(service.recallWeight(mem)).toBe(0.8);
    });

    it('returns 0.6 for COLD memories', () => {
      const mem = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 120 * DAY_MS),
        createdAt: new Date(Date.now() - 365 * DAY_MS),
        retrievalCount: 1,
      });
      expect(service.recallWeight(mem)).toBe(0.6);
    });

    it('returns 0.6 when lastRetrievedAt is null and not pinned', () => {
      const mem = makeMemory({
        lastRetrievedAt: null,
        createdAt: new Date(Date.now() - 365 * DAY_MS),
        retrievalCount: 0,
      });
      expect(service.recallWeight(mem)).toBe(0.6);
    });

    it('pinned overrides all other tiers', () => {
      const mem = makeMemory({
        userPinned: true,
        lastRetrievedAt: new Date(Date.now() - 200 * DAY_MS),
        retrievalCount: 0,
      });
      expect(service.recallWeight(mem)).toBe(1.0);
    });

    it('returns 1.0 for boundary: exactly 7 days', () => {
      const mem = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 7 * DAY_MS),
      });
      expect(service.recallWeight(mem)).toBe(1.0);
    });

    it('returns 0.9 for boundary: exactly 30 days', () => {
      const mem = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 30 * DAY_MS),
      });
      expect(service.recallWeight(mem)).toBe(0.9);
    });

    it('handles very new memory (age < 1 day) without division issues', () => {
      const mem = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 120 * DAY_MS),
        createdAt: new Date(), // just created
        retrievalCount: 0,
      });
      // ageInDays clamped to 1, 0/1 = 0 <= 0.1 → COLD
      expect(service.recallWeight(mem)).toBe(0.6);
    });
  });

  describe('env toggle', () => {
    it('returns 1.0 for all memories when disabled', async () => {
      const disabled = await createService('false');
      const cold = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 200 * DAY_MS),
        retrievalCount: 0,
      });
      expect(disabled.recallWeight(cold)).toBe(1.0);
    });

    it('applies weights when enabled', async () => {
      const enabled = await createService('true');
      const cold = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 200 * DAY_MS),
        createdAt: new Date(Date.now() - 365 * DAY_MS),
        retrievalCount: 0,
      });
      expect(enabled.recallWeight(cold)).toBe(0.6);
    });
  });

  describe('resolveDerivatives', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('passes through non-dream memories unchanged', async () => {
      const normalMemory = makeRankedMemory(
        { id: 'normal-1', source: 'EXPLICIT_STATEMENT' as any },
        0.9,
      );
      const results = await service.resolveDerivatives([normalMemory]);

      expect(results).toEqual([normalMemory]);
      expect(mockPrismaService.memory.findMany).not.toHaveBeenCalled();
    });

    it('keeps dream memory unchanged when no derivativeOf links', async () => {
      const dreamMemory = makeRankedMemory(
        {
          id: 'dream-1',
          source: 'DREAM_CYCLE' as any,
          metadata: {},
        },
        0.8,
      );

      const results = await service.resolveDerivatives([dreamMemory]);

      expect(results).toEqual([dreamMemory]);
      expect(mockPrismaService.memory.findMany).not.toHaveBeenCalled();
    });

    it('resolves dream memory to source facts via derivativeOf', async () => {
      const sourceMemory1 = makeMemory({
        id: 'source-1',
        raw: 'Source fact 1',
      });
      const sourceMemory2 = makeMemory({
        id: 'source-2',
        raw: 'Source fact 2',
      });

      mockPrismaService.memory.findMany.mockResolvedValue([
        sourceMemory1,
        sourceMemory2,
      ]);

      const dreamMemory = makeRankedMemory(
        {
          id: 'dream-1',
          source: 'DREAM_CYCLE' as any,
          metadata: { derivativeOf: ['source-1', 'source-2'] },
        },
        0.8,
        { originalRank: 1 },
      );

      const results = await service.resolveDerivatives([dreamMemory]);

      expect(results).toHaveLength(2);
      expect(results[0].memory).toEqual(sourceMemory1);
      expect(results[0].score).toBe(0.8);
      expect(results[0].metadata).toEqual({
        originalRank: 1,
        resolved: true,
        resolvedFrom: 'dream-1',
      });

      expect(results[1].memory).toEqual(sourceMemory2);
      expect(results[1].score).toBe(0.8);
      expect(results[1].metadata).toEqual({
        originalRank: 1,
        resolved: true,
        resolvedFrom: 'dream-1',
      });

      expect(mockPrismaService.memory.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['source-1', 'source-2'] } },
        take: 3,
      });
    });

    it('works with CONSOLIDATION source type', async () => {
      const sourceMemory = makeMemory({ id: 'source-1', raw: 'Source fact' });

      mockPrismaService.memory.findMany.mockResolvedValue([sourceMemory]);

      const consolidationMemory = makeRankedMemory(
        {
          id: 'consolidation-1',
          source: 'CONSOLIDATION' as any,
          metadata: { derivativeOf: ['source-1'] },
        },
        0.9,
      );

      const results = await service.resolveDerivatives([consolidationMemory]);

      expect(results).toHaveLength(1);
      expect(results[0].memory).toEqual(sourceMemory);
      expect(results[0].metadata?.resolvedFrom).toBe('consolidation-1');
    });

    it('caps at 3 source facts per dream memory', async () => {
      const sources = [
        makeMemory({ id: 'source-1' }),
        makeMemory({ id: 'source-2' }),
        makeMemory({ id: 'source-3' }),
        makeMemory({ id: 'source-4' }),
        makeMemory({ id: 'source-5' }),
      ];

      mockPrismaService.memory.findMany.mockResolvedValue(sources.slice(0, 3)); // take: 3 limits results

      const dreamMemory = makeRankedMemory(
        {
          id: 'dream-1',
          source: 'DREAM_CYCLE' as any,
          metadata: {
            derivativeOf: [
              'source-1',
              'source-2',
              'source-3',
              'source-4',
              'source-5',
            ],
          },
        },
        0.8,
      );

      const results = await service.resolveDerivatives([dreamMemory]);

      expect(results).toHaveLength(3);
      expect(mockPrismaService.memory.findMany).toHaveBeenCalledWith({
        where: {
          id: {
            in: ['source-1', 'source-2', 'source-3', 'source-4', 'source-5'],
          },
        },
        take: 3,
      });
    });

    it('deduplicates memories by ID - first occurrence wins', async () => {
      const sourceMemory = makeMemory({ id: 'source-1' });

      mockPrismaService.memory.findMany
        .mockResolvedValueOnce([sourceMemory]) // First dream resolves to source-1
        .mockResolvedValueOnce([sourceMemory]); // Second dream also resolves to source-1

      const dream1 = makeRankedMemory(
        {
          id: 'dream-1',
          source: 'DREAM_CYCLE' as any,
          metadata: { derivativeOf: ['source-1'] },
        },
        0.9,
      );

      const dream2 = makeRankedMemory(
        {
          id: 'dream-2',
          source: 'DREAM_CYCLE' as any,
          metadata: { derivativeOf: ['source-1'] },
        },
        0.7,
      );

      const results = await service.resolveDerivatives([dream1, dream2]);

      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0.9); // Higher score from first dream wins
      expect(results[0].metadata?.resolvedFrom).toBe('dream-1');
    });

    it('handles deleted/missing source memories gracefully', async () => {
      mockPrismaService.memory.findMany.mockResolvedValue([]); // No sources found

      const dreamMemory = makeRankedMemory(
        {
          id: 'dream-1',
          source: 'DREAM_CYCLE' as any,
          metadata: { derivativeOf: ['deleted-source'] },
        },
        0.8,
      );

      const results = await service.resolveDerivatives([dreamMemory]);

      expect(results).toHaveLength(0); // Dream is removed, no sources to replace with
    });

    it('handles invalid derivativeOf IDs gracefully', async () => {
      const validSource = makeMemory({ id: 'valid-source' });

      mockPrismaService.memory.findMany.mockResolvedValue([validSource]); // Only valid source returned

      const dreamMemory = makeRankedMemory(
        {
          id: 'dream-1',
          source: 'DREAM_CYCLE' as any,
          metadata: {
            derivativeOf: ['valid-source', 'invalid-id', 'another-invalid'],
          },
        },
        0.8,
      );

      const results = await service.resolveDerivatives([dreamMemory]);

      expect(results).toHaveLength(1);
      expect(results[0].memory).toEqual(validSource);
    });

    it('mixes regular memories with resolved dreams correctly', async () => {
      const normalMemory = makeRankedMemory(
        { id: 'normal-1', source: 'EXPLICIT_STATEMENT' as any },
        0.9,
      );
      const sourceMemory = makeMemory({ id: 'source-1' });

      mockPrismaService.memory.findMany.mockResolvedValue([sourceMemory]);

      const dreamMemory = makeRankedMemory(
        {
          id: 'dream-1',
          source: 'DREAM_CYCLE' as any,
          metadata: { derivativeOf: ['source-1'] },
        },
        0.8,
      );

      const results = await service.resolveDerivatives([
        normalMemory,
        dreamMemory,
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual(normalMemory);
      expect(results[1].memory).toEqual(sourceMemory);
      expect(results[1].metadata?.resolvedFrom).toBe('dream-1');
    });

    it('preserves existing metadata when resolving', async () => {
      const sourceMemory = makeMemory({ id: 'source-1' });

      mockPrismaService.memory.findMany.mockResolvedValue([sourceMemory]);

      const dreamMemory = makeRankedMemory(
        {
          id: 'dream-1',
          source: 'DREAM_CYCLE' as any,
          metadata: { derivativeOf: ['source-1'] },
        },
        0.8,
        { customField: 'preserved', rank: 5 },
      );

      const results = await service.resolveDerivatives([dreamMemory]);

      expect(results[0].metadata).toEqual({
        customField: 'preserved',
        rank: 5,
        resolved: true,
        resolvedFrom: 'dream-1',
      });
    });
  });
});
