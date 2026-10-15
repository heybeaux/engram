import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DreamCycleSchedulerService } from './dream-cycle-scheduler.service';
import { DreamCycleService } from './dream-cycle.service';
import { DreamCycleRunTrackerService } from './dream-cycle-run-tracker.service';
import { Logger } from '@nestjs/common';

describe('DreamCycleSchedulerService', () => {
  let service: DreamCycleSchedulerService;
  let dreamCycle: { run: jest.Mock; runAsync: jest.Mock };
  let runTracker: { failStaleReports: jest.Mock };
  let configValues: Record<string, string>;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();

    configValues = {
      DREAM_CYCLE_ENABLED: 'true',
      DREAM_CYCLE_TZ: 'UTC',
    };

    dreamCycle = { run: jest.fn(), runAsync: jest.fn() };
    runTracker = { failStaleReports: jest.fn().mockResolvedValue(0) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DreamCycleSchedulerService,
        { provide: DreamCycleService, useValue: dreamCycle },
        { provide: DreamCycleRunTrackerService, useValue: runTracker },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (key: string, fallback?: string) => configValues[key] ?? fallback,
            ),
          },
        },
        {
          provide: SchedulerRegistry,
          useValue: {
            addCronJob: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(DreamCycleSchedulerService);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  describe('onModuleInit', () => {
    it('should log enabled message when DREAM_CYCLE_ENABLED is true', () => {
      service.onModuleInit();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('scheduler enabled'),
      );
    });

    it('should log disabled message when DREAM_CYCLE_ENABLED is false', async () => {
      configValues.DREAM_CYCLE_ENABLED = 'false';

      const module = await Test.createTestingModule({
        providers: [
          DreamCycleSchedulerService,
          { provide: DreamCycleService, useValue: dreamCycle },
          { provide: DreamCycleRunTrackerService, useValue: runTracker },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(
                (key: string, fallback?: string) =>
                  configValues[key] ?? fallback,
              ),
            },
          },
          {
            provide: SchedulerRegistry,
            useValue: { addCronJob: jest.fn() },
          },
        ],
      }).compile();

      const disabledService = module.get(DreamCycleSchedulerService);
      disabledService.onModuleInit();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('scheduler disabled'),
      );
    });
  });

  describe('handleDreamCycleCron', () => {
    it('should call dreamCycle.run and log success', async () => {
      dreamCycle.runAsync.mockResolvedValue({
        runId: 'run-123',
        mode: 'queued',
      });

      await service.handleDreamCycleCron();

      expect(dreamCycle.runAsync).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('runId=run-123'),
      );
    });

    it('should log error when dreamCycle.run throws', async () => {
      const error = new Error('Database connection lost');
      error.stack = 'Error: Database connection lost\n    at test';
      dreamCycle.runAsync.mockRejectedValue(error);

      await service.handleDreamCycleCron();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Database connection lost'),
        error.stack,
      );
    });

    it('should fail orphaned reports before starting a run', async () => {
      const order: string[] = [];
      runTracker.failStaleReports.mockImplementation(async () => {
        order.push('reap');
        return 2;
      });
      dreamCycle.runAsync.mockImplementation(async () => {
        order.push('run');
        return { runId: 'run-1', mode: 'queued' };
      });

      await service.handleDreamCycleCron();

      expect(order).toEqual(['reap', 'run']);
    });

    it('should still run when orphan cleanup throws', async () => {
      runTracker.failStaleReports.mockRejectedValue(new Error('db down'));
      dreamCycle.runAsync.mockResolvedValue({ runId: 'run-2', mode: 'queued' });

      await service.handleDreamCycleCron();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stale Dream Cycle cleanup failed'),
      );
      expect(dreamCycle.runAsync).toHaveBeenCalledTimes(1);
    });

    it('should skip when disabled', async () => {
      configValues.DREAM_CYCLE_ENABLED = 'false';

      const module = await Test.createTestingModule({
        providers: [
          DreamCycleSchedulerService,
          { provide: DreamCycleService, useValue: dreamCycle },
          { provide: DreamCycleRunTrackerService, useValue: runTracker },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(
                (key: string, fallback?: string) =>
                  configValues[key] ?? fallback,
              ),
            },
          },
          {
            provide: SchedulerRegistry,
            useValue: { addCronJob: jest.fn() },
          },
        ],
      }).compile();

      const disabledService = module.get(DreamCycleSchedulerService);
      await disabledService.handleDreamCycleCron();

      expect(dreamCycle.runAsync).not.toHaveBeenCalled();
    });
  });
});
