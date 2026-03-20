import { WakingCycleService } from './waking-cycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { MemorySignalService } from './signals/memory-signal.service';
import { GitHubSignalService } from './signals/github-signal.service';
import { PatternDetectorService } from './analysis/pattern-detector.service';
import { InsightGeneratorService } from './analysis/insight-generator.service';
import { BehavioralConsistencyService } from './analysis/behavioral-consistency.service';
import { ProactiveNotificationService } from './proactive-notification.service';
import { InsightFeedbackService } from './insight-feedback.service';
import { EmbeddingService } from '../memory/embedding.service';

describe('WakingCycleService', () => {
  let service: WakingCycleService;
  let prisma: any;
  let memoryService: any;
  let memorySignal: any;
  let githubSignal: any;
  let patternDetector: any;
  let insightGenerator: any;
  let behavioralConsistency: any;
  let linearSignal: any;
  let proactiveNotification: any;
  let insightFeedback: any;
  let embeddingService: any;

  beforeEach(() => {
    prisma = {
      awarenessState: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
      account: {
        findFirst: jest.fn().mockResolvedValue({ id: 'acc-1' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'acc-1' }]),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }),
      },
      memory: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest
          .fn()
          .mockResolvedValue({ createdAt: new Date(), deletedAt: null }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      dreamCycleRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      awarenessCycleRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    memoryService = {
      remember: jest.fn().mockResolvedValue({ id: 'mem-1' }),
    };

    memorySignal = {
      name: 'memory',
      collect: jest.fn().mockResolvedValue({
        observations: [
          {
            id: 'obs-1',
            source: 'memory',
            content: 'User talks about cooking often',
            observedAt: new Date(),
          },
        ],
        checkpoint: { lastId: 'mem-100' },
      }),
    };

    githubSignal = {
      name: 'github',
      collect: jest.fn().mockResolvedValue({
        observations: [],
        checkpoint: {},
      }),
    };

    patternDetector = {
      detect: jest.fn().mockReturnValue([
        {
          type: 'recurring_topic',
          description: 'Cooking mentioned frequently',
          observations: ['obs-1'],
        },
      ]),
    };

    insightGenerator = {
      generate: jest.fn().mockResolvedValue([
        {
          content: 'User has a strong interest in cooking',
          confidence: 0.8,
          insightType: 'recurring_pattern',
          sourceMemoryIds: ['mem-50'],
          signalSource: 'memory',
          actionable: false,
        },
      ]),
    };

    behavioralConsistency = {
      check: jest.fn().mockResolvedValue({
        inconsistencies: [],
        memoriesAnalyzed: 0,
        llmCallsUsed: 0,
      }),
    };

    proactiveNotification = {
      checkAndNotify: jest.fn().mockResolvedValue([]),
    };

    insightFeedback = {
      getFeedbackStats: jest.fn().mockResolvedValue({
        totalFeedback: 0,
        dismissed: 0,
        actedOn: 0,
        helpful: 0,
        avgConfidenceAdjustment: 0,
      }),
    };

    linearSignal = {
      name: 'linear',
      collect: jest.fn().mockResolvedValue({
        observations: [],
        checkpoint: {},
      }),
    } as any;

    embeddingService = {
      generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      search: jest.fn().mockResolvedValue([]),
    };

    service = new WakingCycleService(
      prisma,
      memoryService,
      memorySignal,
      githubSignal,
      linearSignal,
      patternDetector,
      insightGenerator,
      behavioralConsistency,
      proactiveNotification,
      insightFeedback,
      embeddingService,
    );
  });

  describe('runCycle', () => {
    it('should execute full pipeline and return stats', async () => {
      const result = await service.runCycle();

      expect(result.observations).toBe(1);
      expect(result.patterns).toBe(1);
      expect(result.insights).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      expect(memorySignal.collect).toHaveBeenCalledTimes(1);
      expect(githubSignal.collect).toHaveBeenCalledTimes(1);
      expect(patternDetector.detect).toHaveBeenCalledTimes(1);
      expect(insightGenerator.generate).toHaveBeenCalledTimes(1);
      expect(memoryService.remember).toHaveBeenCalledTimes(1);
    });

    it('should store insights as INSIGHT layer memories with metadata (HEY-136)', async () => {
      await service.runCycle();

      expect(memoryService.remember).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          raw: 'User has a strong interest in cooking',
          layer: 'INSIGHT',
          source: 'PATTERN_DETECTED',
        }),
      );

      // Should update with full insight metadata
      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'mem-1' },
          data: expect.objectContaining({
            confidence: 0.8,
            metadata: expect.objectContaining({
              insightType: 'recurring_pattern',
              sourceMemoryIds: ['mem-50'],
              signalSource: 'memory',
              actionable: false,
              acknowledged: false,
            }),
          }),
        }),
      );
    });

    it('should adjust confidence based on feedback history (HEY-151)', async () => {
      insightFeedback.getFeedbackStats.mockResolvedValue({
        totalFeedback: 5,
        dismissed: 3,
        actedOn: 1,
        helpful: 1,
        avgConfidenceAdjustment: -0.03,
      });

      await service.runCycle();

      // Original confidence 0.8 adjusted by -0.03 = 0.77
      const updateCall = prisma.memory.update.mock.calls[0][0];
      expect(updateCall.data.confidence).toBeCloseTo(0.77, 2);
    });

    it('should trigger proactive notifications after storing (HEY-154)', async () => {
      await service.runCycle();

      expect(proactiveNotification.checkAndNotify).toHaveBeenCalledWith(
        'acc-1',
      );
    });

    it('should skip storing if no user found for account', async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.runCycle('acc-1');

      expect(result.insights).toBe(1);
      expect(memoryService.remember).not.toHaveBeenCalled();
    });

    it('should prevent concurrent runs', async () => {
      const firstCycle = service.runCycle();
      const secondCycle = service.runCycle();

      const [first, second] = await Promise.all([firstCycle, secondCycle]);

      expect(second).toEqual({
        observations: 0,
        patterns: 0,
        insights: 0,
        durationMs: 0,
      });
      expect(first.observations).toBe(1);
    });

    it('should handle errors gracefully', async () => {
      memorySignal.collect.mockRejectedValue(new Error('DB connection lost'));

      const result = await service.runCycle();

      expect(result.observations).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should save checkpoints after collecting signals', async () => {
      await service.runCycle();

      expect(prisma.awarenessState.upsert).toHaveBeenCalledTimes(3);
      expect(prisma.awarenessState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            accountId_signalSource: {
              accountId: 'acc-1',
              signalSource: 'memory',
            },
          },
        }),
      );
    });

    it('should skip cycle if no account found', async () => {
      (prisma.account.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.runCycle();

      expect(result.observations).toBe(0);
      expect(prisma.awarenessState.upsert).not.toHaveBeenCalled();
    });

    it('should scope to a specific accountId when provided', async () => {
      await service.runCycle('acc-42');

      expect(prisma.awarenessState.findMany).toHaveBeenCalledWith({
        where: { accountId: 'acc-42' },
      });
      expect(prisma.awarenessState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            accountId_signalSource: {
              accountId: 'acc-42',
              signalSource: 'memory',
            },
          },
        }),
      );
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { accountId: 'acc-42' },
      });
    });

    it('should handle proactive notification failure gracefully', async () => {
      proactiveNotification.checkAndNotify.mockRejectedValue(
        new Error('Webhook failed'),
      );

      const result = await service.runCycle();
      expect(result.insights).toBe(1);
    });

    it('should handle insight dedup rejection gracefully', async () => {
      memoryService.remember.mockRejectedValue(
        new Error('Duplicate memory detected'),
      );

      const result = await service.runCycle();
      expect(result.insights).toBe(1);
    });

    it('should work without optional services', async () => {
      const minimalService = new WakingCycleService(
        prisma,
        memoryService,
        memorySignal,
        githubSignal,
        linearSignal,
        patternDetector,
        insightGenerator,
        behavioralConsistency,
      );

      const result = await minimalService.runCycle();
      expect(result.insights).toBe(1);
    });

    it('should persist cycle run in AwarenessCycleRun table (HEY-335)', async () => {
      await service.runCycle();

      expect(prisma.awarenessCycleRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'RUNNING',
          phase: 'starting',
          instanceId: expect.any(String),
        }),
      });

      expect(prisma.awarenessCycleRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          phase: 'idle',
          insightsGenerated: expect.any(Number),
          observations: expect.any(Number),
          patterns: expect.any(Number),
        }),
      });
    });

    it('should record failed cycle run in DB (HEY-335)', async () => {
      memorySignal.collect.mockRejectedValue(new Error('DB connection lost'));

      await service.runCycle();

      expect(prisma.awarenessCycleRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: expect.objectContaining({
          status: 'FAILED',
          phase: 'failed',
          error: 'DB connection lost',
        }),
      });
    });

    it('should skip insight when same insightType exists within 7 days', async () => {
      prisma.memory.findFirst.mockResolvedValue({ id: 'recent-same-type' });

      await service.runCycle();

      expect(memoryService.remember).not.toHaveBeenCalled();
    });

    it('should skip duplicate insights based on embedding similarity (HEY-336)', async () => {
      embeddingService.search.mockResolvedValue([
        { id: 'existing-insight-1', score: 0.95 },
      ]);

      await service.runCycle();

      // Insight should be skipped due to dedup
      expect(memoryService.remember).not.toHaveBeenCalled();
    });

    it('should store insight when no similar exists (HEY-336)', async () => {
      embeddingService.search.mockResolvedValue([
        { id: 'existing-insight-1', score: 0.5 },
      ]);

      await service.runCycle();

      expect(memoryService.remember).toHaveBeenCalledTimes(1);
    });

    it('should store insight when similar one is older than insightTtlDays (HEY-336)', async () => {
      embeddingService.search.mockResolvedValue([
        { id: 'old-insight', score: 0.95 },
      ]);
      prisma.memory.findUnique.mockResolvedValue({
        createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
        deletedAt: null,
      });

      await service.runCycle();

      expect(memoryService.remember).toHaveBeenCalledTimes(1);
    });
  });

  describe('getLastCycleRun (HEY-335)', () => {
    it('should return idle with nulls when no runs exist', async () => {
      prisma.awarenessCycleRun.findFirst.mockResolvedValue(null);

      const status = await service.getLastCycleRun();

      expect(status.phase).toBe('idle');
      expect(status.lastRunAt).toBeNull();
      expect(status.insightsGenerated).toBe(0);
    });

    it('should return completed run stats from DB', async () => {
      prisma.awarenessCycleRun.findFirst.mockResolvedValue({
        id: 'run-1',
        status: 'COMPLETED',
        phase: 'idle',
        startTime: new Date('2026-01-15T10:00:00Z'),
        endTime: new Date('2026-01-15T10:00:02Z'),
        insightsGenerated: 3,
        observations: 10,
        patterns: 5,
        durationMs: 2000,
        error: null,
      });

      const status = await service.getLastCycleRun();

      expect(status.phase).toBe('idle');
      expect(status.lastRunAt).toBe('2026-01-15T10:00:02.000Z');
      expect(status.insightsGenerated).toBe(3);
      expect(status.duration).toBe(2000);
    });

    it('should return running phase when cycle is in progress', async () => {
      prisma.awarenessCycleRun.findFirst.mockResolvedValue({
        id: 'run-2',
        status: 'RUNNING',
        phase: 'observing',
        startTime: new Date('2026-01-15T10:00:00Z'),
        endTime: null,
        insightsGenerated: 0,
        observations: 0,
        patterns: 0,
        durationMs: 0,
        error: null,
      });

      const status = await service.getLastCycleRun();

      expect(status.phase).toBe('observing');
    });
  });
});
