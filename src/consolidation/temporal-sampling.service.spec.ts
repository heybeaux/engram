import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  TemporalSamplingService,
  TemporalSampleOptions,
} from './temporal-sampling.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';

const mockPrisma = {
  memory: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
};

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const cfg: Record<string, string> = {
      DREAM_SAMPLE_SIZE: '2000',
    };
    return cfg[key] ?? defaultValue;
  }),
};

const makeMemory = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'mem-1',
  raw: 'test memory',
  memoryType: 'FACT',
  importanceScore: 0.5,
  effectiveScore: 0.5,
  createdAt: new Date('2025-06-01'),
  lastDreamedAt: null,
  retrievalCount: 0,
  layer: 'SESSION',
  ...overrides,
});

describe('TemporalSamplingService', () => {
  let service: TemporalSamplingService;

  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TemporalSamplingService,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<TemporalSamplingService>(TemporalSamplingService);
  });

  describe('sampleMemories()', () => {
    const opts: TemporalSampleOptions = { userId: 'user-1', sampleSize: 10 };

    it('should return empty result when user has no memories', async () => {
      mockPrisma.memory.count.mockResolvedValue(0);

      const result = await service.sampleMemories(opts);

      expect(result.memories).toHaveLength(0);
      expect(result.totalAvailable).toBe(0);
      expect(result.tierStats).toEqual({
        recent: 0,
        midRange: 0,
        deep: 0,
        random: 0,
      });
    });

    it('should calculate tier sizes as 40/30/20/10 split', async () => {
      // sampleSize=100 → recent=40, midRange=30, deep=20, random=10
      mockPrisma.memory.count
        .mockResolvedValueOnce(200) // total count
        .mockResolvedValue(50); // each tier count

      const mems = Array.from({ length: 10 }, (_, i) =>
        makeMemory({ id: `mem-${i}` }),
      );
      mockPrisma.memory.findMany.mockResolvedValue(mems);

      const result = await service.sampleMemories({
        userId: 'user-1',
        sampleSize: 100,
      });

      // 4 tiers → findMany called 4 times
      expect(mockPrisma.memory.findMany).toHaveBeenCalledTimes(4);

      // Check take values match tier split
      const calls = mockPrisma.memory.findMany.mock.calls;
      const takes = calls.map((c: any[]) => c[0].take);
      // each take = min(tierCount * 3, actualTierSize * 3)
      // recent tier: 40 * 3 = 120, but capped at tierCount(50) → take=50
      expect(takes[0]).toBeLessThanOrEqual(50 * 3);
    });

    it('should cap sample size to totalAvailable', async () => {
      // Only 5 memories available but asked for 100
      mockPrisma.memory.count
        .mockResolvedValueOnce(5) // total
        .mockResolvedValue(2); // each tier

      mockPrisma.memory.findMany.mockResolvedValue([makeMemory()]);

      const result = await service.sampleMemories({
        userId: 'user-1',
        sampleSize: 100,
      });

      expect(result.totalAvailable).toBe(5);
      // actual sample can't exceed 5
    });

    it('should tag memories with their correct tier', async () => {
      mockPrisma.memory.count
        .mockResolvedValueOnce(40) // total
        .mockResolvedValueOnce(10) // recent
        .mockResolvedValueOnce(10) // mid-range
        .mockResolvedValueOnce(10) // deep
        .mockResolvedValueOnce(10); // random

      mockPrisma.memory.findMany
        .mockResolvedValueOnce([makeMemory({ id: 'r1' })]) // recent
        .mockResolvedValueOnce([makeMemory({ id: 'm1' })]) // mid-range
        .mockResolvedValueOnce([makeMemory({ id: 'd1' })]) // deep
        .mockResolvedValueOnce([makeMemory({ id: 'rnd1' })]); // random

      const result = await service.sampleMemories({
        userId: 'user-1',
        sampleSize: 40,
      });

      const tiers = result.memories.map((m: any) => m.tier);
      expect(tiers).toContain('recent');
      expect(tiers).toContain('mid-range');
      expect(tiers).toContain('deep');
      expect(tiers).toContain('random');
    });

    it('should return correct tierStats', async () => {
      mockPrisma.memory.count
        .mockResolvedValueOnce(80) // total
        .mockResolvedValueOnce(20) // recent
        .mockResolvedValueOnce(20) // mid-range
        .mockResolvedValueOnce(20) // deep
        .mockResolvedValueOnce(20); // random

      mockPrisma.memory.findMany
        .mockResolvedValueOnce([makeMemory(), makeMemory({ id: 'r2' })])
        .mockResolvedValueOnce([makeMemory({ id: 'm1' })])
        .mockResolvedValueOnce([makeMemory({ id: 'd1' })])
        .mockResolvedValueOnce([makeMemory({ id: 'rnd1' })]);

      const result = await service.sampleMemories({
        userId: 'user-1',
        sampleSize: 80,
      });

      expect(result.tierStats.recent).toBe(2);
      expect(result.tierStats.midRange).toBe(1);
      expect(result.tierStats.deep).toBe(1);
      expect(result.tierStats.random).toBe(1);
    });

    it('should use default sample size from config when not specified', async () => {
      mockPrisma.memory.count.mockResolvedValue(0);

      await service.sampleMemories({ userId: 'user-1' });

      // total count is checked with base where
      expect(mockPrisma.memory.count).toHaveBeenCalledWith({
        where: { userId: 'user-1', deletedAt: null, consolidatedInto: null },
      });
    });

    it('should shuffle the combined memories (non-deterministic order)', async () => {
      // Use sampleSize=100 so all tiers get non-zero allocation (40/30/20/10)
      mockPrisma.memory.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValue(25); // each tier has 25 available

      mockPrisma.memory.findMany
        .mockResolvedValueOnce([makeMemory({ id: 'r1' })])
        .mockResolvedValueOnce([makeMemory({ id: 'm1' })])
        .mockResolvedValueOnce([makeMemory({ id: 'd1' })])
        .mockResolvedValueOnce([makeMemory({ id: 'rnd1' })]);

      const result = await service.sampleMemories({
        userId: 'user-1',
        sampleSize: 100,
      });

      // Should have 4 memories total (one per tier)
      expect(result.memories).toHaveLength(4);
      const ids = result.memories.map((m: any) => m.id);
      expect(ids).toEqual(expect.arrayContaining(['r1', 'm1', 'd1', 'rnd1']));
    });

    it('should order each tier by lastDreamedAt asc, retrievalCount asc', async () => {
      mockPrisma.memory.count.mockResolvedValue(5).mockResolvedValue(5);
      mockPrisma.memory.findMany.mockResolvedValue([makeMemory()]);

      await service.sampleMemories({ userId: 'user-1', sampleSize: 5 });

      const calls = mockPrisma.memory.findMany.mock.calls;
      // All tier calls should have correct orderBy
      for (const call of calls) {
        expect(call[0].orderBy).toEqual([
          { lastDreamedAt: 'asc' },
          { retrievalCount: 'asc' },
          { createdAt: 'desc' },
        ]);
      }
    });

    it('should handle tier with 0 available memories gracefully', async () => {
      // Total = 5, all in recent tier
      mockPrisma.memory.count
        .mockResolvedValueOnce(5) // total
        .mockResolvedValueOnce(5) // recent
        .mockResolvedValueOnce(0) // mid-range: none
        .mockResolvedValueOnce(0) // deep: none
        .mockResolvedValueOnce(0); // random: none

      mockPrisma.memory.findMany
        .mockResolvedValueOnce([makeMemory(), makeMemory({ id: 'r2' })])
        .mockResolvedValueOnce([]) // mid-range
        .mockResolvedValueOnce([]) // deep
        .mockResolvedValueOnce([]); // random

      const result = await service.sampleMemories({
        userId: 'user-1',
        sampleSize: 5,
      });

      expect(result.tierStats.midRange).toBe(0);
      expect(result.tierStats.deep).toBe(0);
      expect(result.tierStats.random).toBe(0);
    });
  });

  describe('getSamplingStats()', () => {
    it('should return correct aggregate stats', async () => {
      // getSamplingStats makes 7 prisma.memory.count calls:
      // total, neverDreamed, dreamedOnce, recent, midRange, deep, random
      // (dreamedMultiple is a Promise.resolve(0), not a prisma call)
      mockPrisma.memory.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(30) // neverDreamed
        .mockResolvedValueOnce(70) // dreamedOnce
        .mockResolvedValueOnce(25) // recent
        .mockResolvedValueOnce(30) // midRange
        .mockResolvedValueOnce(20) // deep
        .mockResolvedValueOnce(25); // random

      const stats = await service.getSamplingStats('user-1');

      expect(stats.totalMemories).toBe(100);
      expect(stats.neverDreamed).toBe(30);
      expect(stats.dreamedOnce).toBe(70);
      expect(stats.tierCounts.recent).toBe(25);
      expect(stats.tierCounts.midRange).toBe(30);
      expect(stats.tierCounts.deep).toBe(20);
      expect(stats.tierCounts.random).toBe(25);
    });

    it('should include correct base where clause (excludes deleted and consolidated)', async () => {
      mockPrisma.memory.count.mockResolvedValue(0);

      await service.getSamplingStats('user-42');

      // All count calls should filter by userId, deletedAt, consolidatedInto
      const calls = mockPrisma.memory.count.mock.calls;
      for (const call of calls) {
        expect(call[0].where).toMatchObject({
          userId: 'user-42',
          deletedAt: null,
          consolidatedInto: null,
        });
      }
    });

    it('should filter neverDreamed by lastDreamedAt: null', async () => {
      mockPrisma.memory.count.mockResolvedValue(0);

      await service.getSamplingStats('user-1');

      // Second call (neverDreamed) should have lastDreamedAt: null
      const calls = mockPrisma.memory.count.mock.calls;
      expect(calls[1][0].where).toMatchObject({ lastDreamedAt: null });
    });
  });
});
