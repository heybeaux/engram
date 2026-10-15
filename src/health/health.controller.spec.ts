import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { DB_PROBE_TIMEOUT_MS, HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { EmbedHealthService } from './embed-health.service';

describe('HealthController', () => {
  let controller: HealthController;
  let mockPrisma: any;
  let mockEmbedHealth: any;
  let mockMonitoring: any;

  beforeEach(async () => {
    mockPrisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ estimate: BigInt(42) }]),
      memory: {
        count: jest.fn().mockResolvedValue(42),
      },
      dreamCycleReport: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    mockEmbedHealth = {
      getStatus: jest.fn().mockResolvedValue({
        status: 'up',
        latencyMs: 5,
        lastUp: new Date(),
      }),
    };

    mockMonitoring = {
      getAlerts: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbedHealthService, useValue: mockEmbedHealth },
        { provide: 'MONITORING_SERVICE', useValue: mockMonitoring },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('check', () => {
    it('should return healthy when all dependencies are up', async () => {
      const result = await controller.check();

      expect(result.status).toBe('healthy');
      expect(result.dependencies.database.status).toBe('up');
      expect(result.dependencies.database.memoryCountEstimate).toBe(42);
      expect(result.dependencies.database.memoryCount).toBe(42);
      expect(result.dependencies.engramEmbed.status).toBe('up');
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.memory.heapUsed).toMatch(/\d+MB/);
    });

    it('should expose version, gitSha and builtAt keys', async () => {
      const result = await controller.check();

      expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(result).toHaveProperty('gitSha');
      expect(result).toHaveProperty('builtAt');
      if (result.gitSha !== null) {
        expect(result.gitSha).toMatch(/^[0-9a-f]{7,40}$/);
      }
    });

    it('should read the pg_class estimate instead of an exact COUNT(*)', async () => {
      await controller.check();

      expect(mockPrisma.memory.count).not.toHaveBeenCalled();
      const sql = mockPrisma.$queryRaw.mock.calls[0][0].join('');
      expect(sql).toMatch(/reltuples::bigint/);
      expect(sql).toMatch(/'memories'::regclass/);
    });

    it('should report a null estimate when the table was never analyzed', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ estimate: BigInt(-1) }]);

      const result = await controller.check();

      expect(result.status).toBe('healthy');
      expect(result.dependencies.database.status).toBe('up');
      expect(result.dependencies.database.memoryCountEstimate).toBeNull();
      expect(result.dependencies.database.memoryCount).toBeNull();
    });

    it('should report degraded instead of hanging when the DB probe is slow', async () => {
      jest.useFakeTimers();
      try {
        mockPrisma.$queryRaw.mockReturnValue(new Promise(() => {}));
        mockPrisma.dreamCycleReport.findFirst.mockReturnValue(
          new Promise(() => {}),
        );

        const pending = controller.check();
        // Both probes time out concurrently: one timeout window is enough.
        await jest.advanceTimersByTimeAsync(DB_PROBE_TIMEOUT_MS + 10);
        const result = await pending;

        expect(result.status).toBe('degraded');
        expect(result.dependencies.database.status).toBe('degraded');
        expect(result.dependencies.database.latencyMs).toBeGreaterThanOrEqual(
          DB_PROBE_TIMEOUT_MS,
        );
        expect(result.dependencies.database.memoryCountEstimate).toBeNull();
        expect(result.dreamCycle).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should throw 503 when database is down', async () => {
      mockPrisma.$queryRaw.mockRejectedValue(new Error('Connection refused'));

      await expect(controller.check()).rejects.toThrow(HttpException);
      try {
        await controller.check();
      } catch (e) {
        expect(e.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        const response = e.getResponse();
        expect(response.status).toBe('unhealthy');
        expect(response.dependencies.database.status).toBe('down');
      }
    });

    it('should return degraded when embed service is down', async () => {
      mockEmbedHealth.getStatus.mockResolvedValue({
        status: 'down',
        latencyMs: null,
        lastUp: null,
      });

      const result = await controller.check();

      expect(result.status).toBe('degraded');
      expect(result.dependencies.engramEmbed.status).toBe('down');
    });

    it('should return degraded when critical monitoring alerts exist', async () => {
      mockMonitoring.getAlerts.mockResolvedValue([
        { level: 'critical', message: 'High memory usage' },
      ]);

      const result = await controller.check();

      expect(result.status).toBe('degraded');
      expect(result.monitoring.hasCriticalAlerts).toBe(true);
      expect(result.monitoring.alertCount).toBe(1);
    });

    it('should include dream cycle info when available', async () => {
      const startedAt = new Date('2026-02-14T02:00:00Z');
      const completedAt = new Date('2026-02-14T03:00:00Z');
      mockPrisma.dreamCycleReport.findFirst.mockImplementation((args: any) =>
        Promise.resolve(
          args.where?.status === 'COMPLETED'
            ? { completedAt }
            : { startedAt, status: 'COMPLETED' },
        ),
      );

      const result = await controller.check();

      expect(result.dreamCycle).toEqual({
        lastRun: completedAt.toISOString(),
        status: 'COMPLETED',
        runningSince: null,
        stale: false,
      });
    });

    it('should report the last completed run while a newer run is RUNNING', async () => {
      const completedAt = new Date(Date.now() - 20 * 3600_000);
      const startedAt = new Date(Date.now() - 30 * 60_000);
      mockPrisma.dreamCycleReport.findFirst.mockImplementation((args: any) =>
        Promise.resolve(
          args.where?.status === 'COMPLETED'
            ? { completedAt }
            : { startedAt, status: 'RUNNING' },
        ),
      );

      const result = await controller.check();

      expect(result.dreamCycle).toEqual({
        lastRun: completedAt.toISOString(),
        status: 'RUNNING',
        runningSince: startedAt.toISOString(),
        stale: false,
      });
    });

    it('should flag an orphaned RUNNING report as stale', async () => {
      const startedAt = new Date(Date.now() - 7 * 3600_000);
      mockPrisma.dreamCycleReport.findFirst.mockImplementation((args: any) =>
        Promise.resolve(
          args.where?.status === 'COMPLETED'
            ? null
            : { startedAt, status: 'RUNNING' },
        ),
      );

      const result = await controller.check();

      expect(result.dreamCycle).toEqual({
        lastRun: null,
        status: 'RUNNING',
        runningSince: startedAt.toISOString(),
        stale: true,
      });
    });

    it('should handle dream cycle table not existing', async () => {
      mockPrisma.dreamCycleReport.findFirst.mockRejectedValue(
        new Error('Table does not exist'),
      );

      const result = await controller.check();

      expect(result.dreamCycle).toBeNull();
    });

    it('should handle monitoring service errors gracefully', async () => {
      mockMonitoring.getAlerts.mockRejectedValue(new Error('Not ready'));

      const result = await controller.check();

      expect(result.status).toBe('healthy');
      expect(result.monitoring.alertCount).toBe(0);
    });
  });
});
