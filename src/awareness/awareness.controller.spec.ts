import { AwarenessController } from './awareness.controller';
import { WakingCycleService } from './waking-cycle.service';
import { AwarenessConfig } from './config/awareness.config';
import { PrismaService } from '../prisma/prisma.service';

describe('AwarenessController', () => {
  let controller: AwarenessController;
  let wakingCycle: jest.Mocked<WakingCycleService>;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(() => {
    wakingCycle = {
      runCycle: jest.fn(),
      runScheduled: jest.fn(),
      getLastCycleRun: jest.fn().mockResolvedValue({
        phase: 'idle',
        lastRunAt: '2026-01-15T10:00:00.000Z',
        insightsGenerated: 3,
        duration: 1500,
        observations: 10,
        patterns: 5,
      }),
    } as any;
    prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 'user1' }]),
      },
    } as any;
  });

  describe('getStatus', () => {
    it('should return status with cycleAvailable true when service exists', () => {
      controller = new AwarenessController(prisma, wakingCycle);
      const result = controller.getStatus();

      expect(result).toEqual({
        enabled: AwarenessConfig.enabled,
        schedule: AwarenessConfig.schedule,
        signals: AwarenessConfig.signals,
        github: {
          configured:
            !!AwarenessConfig.github.token &&
            AwarenessConfig.github.repos.length > 0,
          repos: AwarenessConfig.github.repos,
        },
        cycleAvailable: true,
      });
    });

    it('should return cycleAvailable false when service is undefined', () => {
      controller = new AwarenessController(prisma, undefined);
      const result = controller.getStatus();

      expect(result.cycleAvailable).toBe(false);
    });
  });

  describe('triggerCycle', () => {
    it('should run cycle and return results when service is available', async () => {
      const cycleResult = {
        observations: 5,
        patterns: 2,
        insights: 1,
        durationMs: 1234,
      };
      wakingCycle.runCycle.mockResolvedValue(cycleResult);
      controller = new AwarenessController(prisma, wakingCycle);

      const result = await controller.triggerCycle();

      expect(wakingCycle.runCycle).toHaveBeenCalledTimes(1);
      expect(result).toEqual(cycleResult);
    });

    it('should return error when waking cycle service is not available', async () => {
      controller = new AwarenessController(prisma, undefined);

      const result = await controller.triggerCycle();

      expect(result).toEqual({
        error:
          'Waking Cycle not available. Set AWARENESS_ENABLED=true and redeploy.',
        enabled: AwarenessConfig.enabled,
      });
    });
  });

  describe('listInsights', () => {
    it('should return mapped insights from INSIGHT layer memories', async () => {
      const mockMemories = [
        {
          id: 'ins1',
          raw: 'Test insight content',
          metadata: {
            title: 'Test Insight',
            insightType: 'pattern',
            confidence: 0.85,
          },
          createdAt: new Date('2026-01-01'),
        },
      ];
      prisma.memory.findMany = jest.fn().mockResolvedValue(mockMemories);
      controller = new AwarenessController(prisma, wakingCycle);

      const mockAgent = { id: 'agent1', accountId: 'acc1' };
      const result = await controller.listInsights(mockAgent);

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            layer: 'INSIGHT',
            deletedAt: null,
            userId: { in: ['user1'] },
          },
        }),
      );
      expect(result).toEqual([
        {
          id: 'ins1',
          title: 'Test Insight',
          content: 'Test insight content',
          category: 'pattern',
          confidence: 0.85,
          createdAt: new Date('2026-01-01'),
        },
      ]);
    });

    it('should return empty array when no insights exist', async () => {
      prisma.memory.findMany = jest.fn().mockResolvedValue([]);
      controller = new AwarenessController(prisma, wakingCycle);

      const mockAgent = { id: 'agent1', accountId: 'acc1' };
      const result = await controller.listInsights(mockAgent);

      expect(result).toEqual([]);
    });
  });

  describe('getCycleStatus', () => {
    it('should return disabled status when waking cycle is not available', async () => {
      controller = new AwarenessController(prisma, undefined);

      const result = await controller.getCycleStatus();

      expect(result).toEqual({
        phase: 'disabled',
        lastRun: null,
        nextRun: null,
        insightsGenerated: 0,
      });
    });

    it('should return persisted cycle status from DB (HEY-335)', async () => {
      controller = new AwarenessController(prisma, wakingCycle);

      const result = await controller.getCycleStatus();

      expect(wakingCycle.getLastCycleRun).toHaveBeenCalled();
      expect(result).toEqual({
        phase: 'idle',
        lastRun: '2026-01-15T10:00:00.000Z',
        nextRun: null,
        insightsGenerated: 3,
        duration: 1500,
        observations: 10,
        patterns: 5,
      });
    });
  });
});
