import { Test, TestingModule } from '@nestjs/testing';
import { TrustMemoryService } from './trust-memory.service';
import { PrismaService } from '../prisma/prisma.service';
import { TrustSignalService } from './trust-signal.service';
import { TrustScoreResult } from './identity.types';

const mockPrisma = {
  memory: {
    create: jest.fn(),
    findMany: jest.fn(),
  },
};

const mockTrustSignal = {
  getLatestScore: jest.fn(),
  computeScore: jest.fn(),
};

describe('TrustMemoryService', () => {
  let service: TrustMemoryService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrustMemoryService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TrustSignalService, useValue: mockTrustSignal },
      ],
    }).compile();
    service = module.get<TrustMemoryService>(TrustMemoryService);
  });

  describe('recomputeAndRemember', () => {
    const baseScore: TrustScoreResult = {
      score: 0.8,
      signalCount: 10,
      successCount: 8,
      failureCount: 1,
      correctionCount: 1,
      category: null,
      computedAt: new Date(),
    };

    it('should create memory on first computation (no previous score)', async () => {
      mockTrustSignal.getLatestScore.mockResolvedValue(null);
      mockTrustSignal.computeScore.mockResolvedValue(baseScore);
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-1' });

      const result = await service.recomputeAndRemember('user1');

      expect(result.score).toEqual(baseScore);
      expect(result.memoryId).toBe('mem-1');
      expect(result.narrative).toContain('initialized');
      expect(result.narrative).toContain('0.80');
      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user1',
          layer: 'IDENTITY',
          memoryType: 'FACT',
          source: 'AGENT_REFLECTION',
        }),
      });
    });

    it('should skip memory creation when delta < 0.005', async () => {
      const previous = { ...baseScore, score: 0.802 };
      mockTrustSignal.getLatestScore.mockResolvedValue(previous);
      mockTrustSignal.computeScore.mockResolvedValue({
        ...baseScore,
        score: 0.804,
      });

      const result = await service.recomputeAndRemember('user1');

      expect(result.memoryId).toBeNull();
      expect(result.narrative).toBeNull();
      expect(mockPrisma.memory.create).not.toHaveBeenCalled();
    });

    it('should create memory for significant trust increase', async () => {
      const previous: TrustScoreResult = {
        score: 0.5,
        signalCount: 5,
        successCount: 3,
        failureCount: 2,
        correctionCount: 0,
        category: null,
        computedAt: new Date(),
      };
      const current: TrustScoreResult = {
        score: 0.8,
        signalCount: 10,
        successCount: 8,
        failureCount: 2,
        correctionCount: 0,
        category: null,
        computedAt: new Date(),
      };
      mockTrustSignal.getLatestScore.mockResolvedValue(previous);
      mockTrustSignal.computeScore.mockResolvedValue(current);
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-2' });

      const result = await service.recomputeAndRemember('user1');

      expect(result.narrative).toContain('significantly');
      expect(result.narrative).toContain('increased');
      expect(result.narrative).toContain('0.50');
      expect(result.narrative).toContain('0.80');
    });

    it('should create memory for trust decrease', async () => {
      const previous: TrustScoreResult = {
        score: 0.8,
        signalCount: 10,
        successCount: 8,
        failureCount: 1,
        correctionCount: 1,
        category: null,
        computedAt: new Date(),
      };
      const current: TrustScoreResult = {
        score: 0.6,
        signalCount: 12,
        successCount: 8,
        failureCount: 3,
        correctionCount: 1,
        category: null,
        computedAt: new Date(),
      };
      mockTrustSignal.getLatestScore.mockResolvedValue(previous);
      mockTrustSignal.computeScore.mockResolvedValue(current);
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-3' });

      const result = await service.recomputeAndRemember('user1');

      expect(result.narrative).toContain('decreased');
    });

    it('should include agentId in narrative and metadata when provided', async () => {
      mockTrustSignal.getLatestScore.mockResolvedValue(null);
      mockTrustSignal.computeScore.mockResolvedValue(baseScore);
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-4' });

      const result = await service.recomputeAndRemember('user1', {
        agentId: 'agent-x',
      });

      expect(result.narrative).toContain('Agent agent-x');
      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          agentId: 'agent-x',
          subjectType: 'AGENT',
        }),
      });
    });

    it('should set subjectType to USER when no agentId', async () => {
      mockTrustSignal.getLatestScore.mockResolvedValue(null);
      mockTrustSignal.computeScore.mockResolvedValue(baseScore);
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-5' });

      await service.recomputeAndRemember('user1');

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          subjectType: 'USER',
          agentId: null,
        }),
      });
    });

    it('should compute high importance for large delta (>0.2)', async () => {
      const previous: TrustScoreResult = {
        score: 0.3,
        signalCount: 5,
        successCount: 2,
        failureCount: 3,
        correctionCount: 0,
        category: null,
        computedAt: new Date(),
      };
      const current: TrustScoreResult = {
        score: 0.8,
        signalCount: 15,
        successCount: 12,
        failureCount: 3,
        correctionCount: 0,
        category: null,
        computedAt: new Date(),
      };
      mockTrustSignal.getLatestScore.mockResolvedValue(previous);
      mockTrustSignal.computeScore.mockResolvedValue(current);
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-6' });

      await service.recomputeAndRemember('user1');

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          importanceScore: 0.9,
        }),
      });
    });

    it('should set confidence based on signal count', async () => {
      mockTrustSignal.getLatestScore.mockResolvedValue(null);
      const lowSignalScore: TrustScoreResult = {
        score: 0.5,
        signalCount: 3,
        successCount: 2,
        failureCount: 1,
        correctionCount: 0,
        category: null,
        computedAt: new Date(),
      };
      mockTrustSignal.computeScore.mockResolvedValue(lowSignalScore);
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-7' });

      await service.recomputeAndRemember('user1');

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          confidence: 0.3, // 3/10
        }),
      });
    });

    it('should cap confidence at 1.0', async () => {
      mockTrustSignal.getLatestScore.mockResolvedValue(null);
      const highSignalScore: TrustScoreResult = {
        score: 0.9,
        signalCount: 50,
        successCount: 45,
        failureCount: 5,
        correctionCount: 0,
        category: null,
        computedAt: new Date(),
      };
      mockTrustSignal.computeScore.mockResolvedValue(highSignalScore);
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-8' });

      await service.recomputeAndRemember('user1');

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          confidence: 1.0,
        }),
      });
    });

    it('should set confidence to 0.5 when score is 0', async () => {
      mockTrustSignal.getLatestScore.mockResolvedValue(null);
      const zeroScore: TrustScoreResult = {
        score: 0,
        signalCount: 5,
        successCount: 0,
        failureCount: 5,
        correctionCount: 0,
        category: null,
        computedAt: new Date(),
      };
      mockTrustSignal.computeScore.mockResolvedValue(zeroScore);
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-9' });

      await service.recomputeAndRemember('user1');

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          confidence: 0.5,
        }),
      });
    });

    it('should include category in narrative and metadata', async () => {
      mockTrustSignal.getLatestScore.mockResolvedValue(null);
      mockTrustSignal.computeScore.mockResolvedValue(baseScore);
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-10' });

      const result = await service.recomputeAndRemember('user1', {
        category: 'deployments',
      });

      expect(result.narrative).toContain('for deployments');
      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            category: 'deployments',
          }),
        }),
      });
    });
  });

  describe('getTrustNarrative', () => {
    it('excludes hidden trust narratives', async () => {
      mockPrisma.memory.findMany.mockImplementation(({ where }: any) => {
        expect(where.userHidden).toBe(false);
        return Promise.resolve([]);
      });
      expect(await service.getTrustNarrative('user1')).toEqual([]);
    });

    it('should return formatted narrative history', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        {
          id: 'mem-1',
          raw: 'Trust increased from 0.5 to 0.8',
          metadata: {
            trustScore: true,
            category: 'overall',
            newScore: 0.8,
            delta: 0.3,
          },
          createdAt: new Date('2026-02-23'),
        },
      ]);

      const result = await service.getTrustNarrative('user1');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'mem-1',
        narrative: 'Trust increased from 0.5 to 0.8',
        score: 0.8,
        delta: 0.3,
        createdAt: expect.any(Date),
      });
    });

    it('should filter by category', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        {
          id: 'mem-1',
          raw: 'a',
          metadata: {
            trustScore: true,
            category: 'deploy',
            newScore: 0.8,
            delta: 0.1,
          },
          createdAt: new Date(),
        },
        {
          id: 'mem-2',
          raw: 'b',
          metadata: {
            trustScore: true,
            category: 'code',
            newScore: 0.7,
            delta: 0.2,
          },
          createdAt: new Date(),
        },
      ]);

      const result = await service.getTrustNarrative('user1', {
        category: 'deploy',
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('mem-1');
    });

    it('should return empty array when no memories exist', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([]);

      const result = await service.getTrustNarrative('user1');

      expect(result).toHaveLength(0);
    });

    it('should respect limit option', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([]);

      await service.getTrustNarrative('user1', { limit: 5 });

      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it('should pass agentId filter when provided', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([]);

      await service.getTrustNarrative('user1', { agentId: 'agent-1' });

      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ agentId: 'agent-1' }),
        }),
      );
    });
  });
});
