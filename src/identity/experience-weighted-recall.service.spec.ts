import { Test, TestingModule } from '@nestjs/testing';
import { ExperienceWeightedRecallService } from './experience-weighted-recall.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  experienceWeight: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    findMany: jest.fn(),
  },
};

describe('ExperienceWeightedRecallService', () => {
  let service: ExperienceWeightedRecallService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExperienceWeightedRecallService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ExperienceWeightedRecallService>(
      ExperienceWeightedRecallService,
    );
  });

  // ─── calculateWeight (pure function, no DB) ───────────────────────────────

  describe('calculateWeight()', () => {
    it('should return base weight 1.0 for 0 successes', () => {
      expect(service.calculateWeight(0)).toBe(1.0);
    });

    it('should return base weight 1.0 for negative input', () => {
      expect(service.calculateWeight(-5)).toBe(1.0);
    });

    it('should return a value between 1.0 and 2.0 for positive successes', () => {
      const w = service.calculateWeight(10);
      expect(w).toBeGreaterThan(1.0);
      expect(w).toBeLessThan(2.0);
    });

    it('should approach 2.0 at 50 successes (~1.95)', () => {
      const w = service.calculateWeight(50);
      expect(w).toBeGreaterThan(1.9);
      expect(w).toBeLessThan(2.0);
    });

    it('should be ~1.60 at 20 successes (logarithmic curve)', () => {
      // Note: code comment says ~1.8 but actual math yields ~1.60 at 20 successes
      // with SCALE_FACTOR=15: 1 + 1 * (1 - exp(-20/15 * ln2)) ≈ 1.603
      const w = service.calculateWeight(20);
      expect(w).toBeGreaterThan(1.5);
      expect(w).toBeLessThan(1.75);
    });

    it('should be monotonically increasing with more successes', () => {
      const w5 = service.calculateWeight(5);
      const w10 = service.calculateWeight(10);
      const w20 = service.calculateWeight(20);
      expect(w5).toBeLessThan(w10);
      expect(w10).toBeLessThan(w20);
    });

    it('should never exceed MAX_WEIGHT of 2.0', () => {
      expect(service.calculateWeight(1000)).toBeLessThanOrEqual(2.0);
    });
  });

  // ─── updateWeight ─────────────────────────────────────────────────────────

  describe('updateWeight()', () => {
    it('should create new weight record when none exists', async () => {
      mockPrisma.experienceWeight.findUnique.mockResolvedValue(null);
      mockPrisma.experienceWeight.upsert.mockResolvedValue({});

      await service.updateWeight('user-1', 'deployment', true);

      expect(mockPrisma.experienceWeight.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            userId: 'user-1',
            category: 'deployment',
            successCount: 1,
            totalCount: 1,
          }),
        }),
      );
    });

    it('should increment totalCount on failure (isSuccess=false)', async () => {
      mockPrisma.experienceWeight.findUnique.mockResolvedValue(null);
      mockPrisma.experienceWeight.upsert.mockResolvedValue({});

      await service.updateWeight('user-1', 'deployment', false);

      expect(mockPrisma.experienceWeight.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            successCount: 0,
            totalCount: 1,
          }),
        }),
      );
    });

    it('should accumulate counts when record exists', async () => {
      mockPrisma.experienceWeight.findUnique.mockResolvedValue({
        successCount: 5,
        totalCount: 8,
        weight: 1.35,
      });
      mockPrisma.experienceWeight.upsert.mockResolvedValue({});

      await service.updateWeight('user-1', 'deployment', true);

      expect(mockPrisma.experienceWeight.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            successCount: 6,
            totalCount: 9,
          }),
        }),
      );
    });

    it('should default agentId to empty string when not provided', async () => {
      mockPrisma.experienceWeight.findUnique.mockResolvedValue(null);
      mockPrisma.experienceWeight.upsert.mockResolvedValue({});

      await service.updateWeight('user-1', 'testing', true);

      expect(mockPrisma.experienceWeight.findUnique).toHaveBeenCalledWith({
        where: {
          userId_agentId_category: {
            userId: 'user-1',
            agentId: '',
            category: 'testing',
          },
        },
      });
    });

    it('should use provided agentId', async () => {
      mockPrisma.experienceWeight.findUnique.mockResolvedValue(null);
      mockPrisma.experienceWeight.upsert.mockResolvedValue({});

      await service.updateWeight('user-1', 'testing', true, 'agent-42');

      expect(mockPrisma.experienceWeight.findUnique).toHaveBeenCalledWith({
        where: {
          userId_agentId_category: {
            userId: 'user-1',
            agentId: 'agent-42',
            category: 'testing',
          },
        },
      });
    });

    it('should store the calculated weight in upsert', async () => {
      mockPrisma.experienceWeight.findUnique.mockResolvedValue({
        successCount: 19,
        totalCount: 20,
        weight: 1.77,
      });
      mockPrisma.experienceWeight.upsert.mockResolvedValue({});

      await service.updateWeight('user-1', 'deploy', true);

      const upsertCall = mockPrisma.experienceWeight.upsert.mock.calls[0][0];
      const storedWeight = upsertCall.update.weight;
      expect(storedWeight).toBeGreaterThan(1.0);
      expect(storedWeight).toBeLessThan(2.0);
    });
  });

  // ─── applyWeights ─────────────────────────────────────────────────────────

  describe('applyWeights()', () => {
    const makeMemory = (id: string, score: number, topics?: string[]) => ({
      id,
      raw: `Memory ${id}`,
      score,
      extraction: topics ? { topics } : undefined,
    });

    it('should return memories unchanged when no weights exist', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([]);

      const memories = [makeMemory('m1', 0.8, ['deployment'])];
      const result = await service.applyWeights('user-1', memories as any);

      expect(result[0].score).toBe(0.8);
    });

    it('should boost score for memories matching high-experience category', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([
        { category: 'deployment', weight: 1.8 },
      ]);

      const memories = [makeMemory('m1', 0.5, ['deployment', 'devops'])];
      const result = await service.applyWeights('user-1', memories as any);

      expect(result[0].score).toBeCloseTo(0.9); // 0.5 * 1.8
    });

    it('should not boost memories with no topics', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([
        { category: 'deployment', weight: 1.8 },
      ]);

      const memories = [makeMemory('m1', 0.7)];
      const result = await service.applyWeights('user-1', memories as any);

      expect(result[0].score).toBe(0.7);
    });

    it('should not boost when no topics match experience categories', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([
        { category: 'deployment', weight: 1.8 },
      ]);

      const memories = [makeMemory('m1', 0.6, ['cooking', 'recipes'])];
      const result = await service.applyWeights('user-1', memories as any);

      expect(result[0].score).toBe(0.6);
    });

    it('should use max boost when multiple topics match', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([
        { category: 'deployment', weight: 1.5 },
        { category: 'devops', weight: 1.9 },
      ]);

      const memories = [makeMemory('m1', 0.5, ['deployment', 'devops'])];
      const result = await service.applyWeights('user-1', memories as any);

      expect(result[0].score).toBeCloseTo(0.95); // 0.5 * 1.9 (max boost)
    });

    it('should match topics case-insensitively', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([
        { category: 'deployment', weight: 1.6 },
      ]);

      const memories = [makeMemory('m1', 0.5, ['Deployment', 'DevOps'])];
      const result = await service.applyWeights('user-1', memories as any);

      expect(result[0].score).toBeCloseTo(0.8); // 0.5 * 1.6
    });

    it('should filter by agentId when provided', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([]);

      await service.applyWeights('user-1', [], { agentId: 'agent-42' });

      expect(mockPrisma.experienceWeight.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', agentId: 'agent-42' },
      });
    });

    it('should handle memories with empty topics array', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([
        { category: 'deployment', weight: 1.8 },
      ]);

      const memories = [makeMemory('m1', 0.5, [])];
      const result = await service.applyWeights('user-1', memories as any);

      expect(result[0].score).toBe(0.5); // unchanged
    });

    it('should boost score of 0 correctly', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([
        { category: 'deployment', weight: 1.8 },
      ]);

      const memories = [makeMemory('m1', 0, ['deployment'])];
      const result = await service.applyWeights('user-1', memories as any);

      expect(result[0].score).toBe(0); // 0 * 1.8 = 0
    });
  });

  // ─── getWeights ───────────────────────────────────────────────────────────

  describe('getWeights()', () => {
    it('should return weights ordered by weight desc', async () => {
      const mockWeights = [
        {
          category: 'deployment',
          successCount: 20,
          totalCount: 22,
          weight: 1.8,
        },
        { category: 'testing', successCount: 5, totalCount: 6, weight: 1.3 },
      ];
      mockPrisma.experienceWeight.findMany.mockResolvedValue(mockWeights);

      const result = await service.getWeights('user-1');

      expect(mockPrisma.experienceWeight.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { weight: 'desc' },
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        category: 'deployment',
        successCount: 20,
        totalCount: 22,
        weight: 1.8,
      });
    });

    it('should return empty array when no weights', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([]);

      const result = await service.getWeights('user-1');
      expect(result).toEqual([]);
    });

    it('should filter by agentId when provided', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([]);

      await service.getWeights('user-1', { agentId: 'agent-99' });

      expect(mockPrisma.experienceWeight.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', agentId: 'agent-99' },
        orderBy: { weight: 'desc' },
      });
    });

    it('should map DB fields to ExperienceWeightResult shape', async () => {
      mockPrisma.experienceWeight.findMany.mockResolvedValue([
        {
          id: 'db-id-1',
          userId: 'user-1',
          agentId: '',
          category: 'coding',
          successCount: 10,
          totalCount: 12,
          weight: 1.55,
          createdAt: new Date(),
        },
      ]);

      const result = await service.getWeights('user-1');

      // Should not include internal DB fields
      expect(result[0]).toEqual({
        category: 'coding',
        successCount: 10,
        totalCount: 12,
        weight: 1.55,
      });
      expect(result[0]).not.toHaveProperty('id');
      expect(result[0]).not.toHaveProperty('userId');
    });
  });
});
