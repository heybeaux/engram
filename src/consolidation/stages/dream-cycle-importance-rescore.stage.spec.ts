import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DreamCycleImportanceRescoreStage } from './dream-cycle-importance-rescore.stage';
import { ServicePrismaService } from '../../prisma/service-prisma.service';

describe('DreamCycleImportanceRescoreStage', () => {
  let stage: DreamCycleImportanceRescoreStage;
  let prisma: { memory: { findMany: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        DreamCycleImportanceRescoreStage,
        { provide: ServicePrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    stage = module.get(DreamCycleImportanceRescoreStage);
  });

  describe('run', () => {
    it('should return zeros when no memories', async () => {
      const result = await stage.run('user1', false);
      expect(result).toEqual({ rescored: 0, unchanged: 0, avgChange: 0 });
    });

    it('should rescore memories and update database', async () => {
      const now = new Date();
      prisma.memory.findMany
        .mockResolvedValueOnce([
          {
            id: 'm1',
            importanceScore: 0.5,
            lastRetrievedAt: new Date(now.getTime() - 2 * 86_400_000),
            usedCount: 10,
            createdAt: new Date(now.getTime() - 30 * 86_400_000),
            layer: 'IDENTITY',
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await stage.run('user1', false);
      expect(result.rescored).toBe(1);
      expect(prisma.memory.update).toHaveBeenCalledTimes(1);
      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'm1' },
          data: { importanceScore: expect.any(Number) },
        }),
      );
    });

    it('should not update in dryRun mode', async () => {
      const now = new Date();
      prisma.memory.findMany
        .mockResolvedValueOnce([
          {
            id: 'm1',
            importanceScore: 0.5,
            lastRetrievedAt: new Date(now.getTime() - 2 * 86_400_000),
            usedCount: 10,
            createdAt: new Date(now.getTime() - 30 * 86_400_000),
            layer: 'TASK',
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await stage.run('user1', true);
      expect(result.rescored).toBe(1);
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('should process multiple batches', async () => {
      const now = new Date();
      const makeMemory = (id: string) => ({
        id,
        importanceScore: 0.5,
        lastRetrievedAt: new Date(now.getTime() - 1 * 86_400_000),
        usedCount: 5,
        createdAt: new Date(now.getTime() - 10 * 86_400_000),
        layer: 'TASK',
      });

      prisma.memory.findMany
        .mockResolvedValueOnce([makeMemory('m1'), makeMemory('m2')])
        .mockResolvedValueOnce([makeMemory('m3')])
        .mockResolvedValueOnce([]);

      const result = await stage.run('user1', false);
      expect(result.rescored).toBe(3);
      expect(prisma.memory.findMany).toHaveBeenCalledTimes(3);
    });

    it('should clamp scores to [0, 1]', async () => {
      const now = new Date();
      prisma.memory.findMany
        .mockResolvedValueOnce([
          {
            id: 'm1',
            importanceScore: 0.9,
            lastRetrievedAt: new Date(now.getTime() - 1000),
            usedCount: 1000,
            createdAt: new Date(now.getTime() - 1 * 86_400_000),
            layer: 'IDENTITY',
          },
        ])
        .mockResolvedValueOnce([]);

      await stage.run('user1', false);
      const updateCall = prisma.memory.update.mock.calls[0][0];
      expect(updateCall.data.importanceScore).toBeLessThanOrEqual(1);
      expect(updateCall.data.importanceScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe('scoring functions', () => {
    describe('recencyBoost', () => {
      it('should return 0.5 for never-retrieved memories', () => {
        expect(stage.recencyBoost(null)).toBe(0.5);
      });

      it('should return ~1.0 for just-retrieved memories', () => {
        const boost = stage.recencyBoost(new Date());
        expect(boost).toBeGreaterThan(0.99);
      });

      it('should decay for older retrievals', () => {
        const recent = stage.recencyBoost(
          new Date(Date.now() - 7 * 86_400_000),
        );
        const old = stage.recencyBoost(
          new Date(Date.now() - 60 * 86_400_000),
        );
        expect(recent).toBeGreaterThan(old);
      });

      it('should have a floor of 0.3', () => {
        const veryOld = stage.recencyBoost(
          new Date(Date.now() - 365 * 86_400_000),
        );
        expect(veryOld).toBeCloseTo(0.3, 1);
      });
    });

    describe('usageBoost', () => {
      it('should return 1.0 for 0 uses', () => {
        expect(stage.usageBoost(0)).toBe(1);
      });

      it('should return 1.0 for 1 use', () => {
        expect(stage.usageBoost(1)).toBe(1);
      });

      it('should scale logarithmically', () => {
        const at10 = stage.usageBoost(10);
        const at100 = stage.usageBoost(100);
        expect(at10).toBeCloseTo(1.3, 1);
        expect(at100).toBeCloseTo(1.6, 1);
      });

      it('should increase with usage', () => {
        expect(stage.usageBoost(100)).toBeGreaterThan(stage.usageBoost(10));
        expect(stage.usageBoost(10)).toBeGreaterThan(stage.usageBoost(1));
      });
    });

    describe('decayFactor', () => {
      it('should return 1.0 when memory has been retrieved', () => {
        expect(stage.decayFactor(new Date('2020-01-01'), new Date())).toBe(1.0);
      });

      it('should decay for never-retrieved old memories', () => {
        const oldMemory = new Date(Date.now() - 120 * 86_400_000);
        const factor = stage.decayFactor(oldMemory, null);
        expect(factor).toBeLessThan(1.0);
        expect(factor).toBeGreaterThanOrEqual(0.2);
      });

      it('should not decay recent never-retrieved memories much', () => {
        const recentMemory = new Date(Date.now() - 1 * 86_400_000);
        const factor = stage.decayFactor(recentMemory, null);
        expect(factor).toBeGreaterThan(0.95);
      });

      it('should have a floor of 0.2', () => {
        const ancientMemory = new Date(Date.now() - 365 * 86_400_000);
        const factor = stage.decayFactor(ancientMemory, null);
        expect(factor).toBeCloseTo(0.2, 1);
      });
    });

    describe('layerWeight', () => {
      it('should weight IDENTITY highest', () => {
        expect(stage.layerWeight('IDENTITY')).toBe(1.5);
      });

      it('should weight SESSION lowest', () => {
        expect(stage.layerWeight('SESSION')).toBe(0.8);
      });

      it('should return 1.0 for unknown layers', () => {
        expect(stage.layerWeight('UNKNOWN')).toBe(1.0);
      });

      it('should return 1.0 for null layer', () => {
        expect(stage.layerWeight(null)).toBe(1.0);
      });

      it('should rank layers IDENTITY > PROJECT > INSIGHT > TASK > SESSION', () => {
        expect(stage.layerWeight('IDENTITY')).toBeGreaterThan(
          stage.layerWeight('PROJECT'),
        );
        expect(stage.layerWeight('PROJECT')).toBeGreaterThan(
          stage.layerWeight('INSIGHT'),
        );
        expect(stage.layerWeight('INSIGHT')).toBeGreaterThan(
          stage.layerWeight('TASK'),
        );
        expect(stage.layerWeight('TASK')).toBeGreaterThan(
          stage.layerWeight('SESSION'),
        );
      });
    });

    describe('calculateScore', () => {
      it('should produce higher scores for IDENTITY than SESSION', () => {
        const now = new Date();
        const identityScore = stage.calculateScore(
          0.5,
          now,
          5,
          new Date(Date.now() - 10 * 86_400_000),
          'IDENTITY',
        );
        const sessionScore = stage.calculateScore(
          0.5,
          now,
          5,
          new Date(Date.now() - 10 * 86_400_000),
          'SESSION',
        );
        expect(identityScore).toBeGreaterThan(sessionScore);
      });

      it('should produce higher scores for frequently retrieved memories', () => {
        const now = new Date();
        const createdAt = new Date(Date.now() - 10 * 86_400_000);
        const frequent = stage.calculateScore(0.5, now, 50, createdAt, 'TASK');
        const rare = stage.calculateScore(0.5, now, 1, createdAt, 'TASK');
        expect(frequent).toBeGreaterThan(rare);
      });

      it('should produce lower scores for never-retrieved old memories', () => {
        const recentCreated = new Date(Date.now() - 1 * 86_400_000);
        const oldCreated = new Date(Date.now() - 200 * 86_400_000);
        const recent = stage.calculateScore(
          0.5,
          null,
          0,
          recentCreated,
          'TASK',
        );
        const old = stage.calculateScore(0.5, null, 0, oldCreated, 'TASK');
        expect(recent).toBeGreaterThan(old);
      });
    });
  });
});
