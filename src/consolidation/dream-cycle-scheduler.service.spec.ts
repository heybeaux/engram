import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DreamCycleSchedulerService } from './dream-cycle-scheduler.service';
import { DreamCycleService } from './dream-cycle.service';
import { Logger } from '@nestjs/common';

describe('DreamCycleSchedulerService', () => {
  let service: DreamCycleSchedulerService;
  let dreamCycle: { run: jest.Mock; runAsync: jest.Mock };
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DreamCycleSchedulerService,
        { provide: DreamCycleService, useValue: dreamCycle },
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

    it('should skip when disabled', async () => {
      configValues.DREAM_CYCLE_ENABLED = 'false';

      const module = await Test.createTestingModule({
        providers: [
          DreamCycleSchedulerService,
          { provide: DreamCycleService, useValue: dreamCycle },
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
