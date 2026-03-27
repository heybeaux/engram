import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CronJob } from 'cron';
import { DreamCycleService } from './dream-cycle.service';

@Injectable()
export class DreamCycleSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(DreamCycleSchedulerService.name);
  private readonly enabled: boolean;
  private readonly timeZone: string;

  constructor(
    private readonly dreamCycle: DreamCycleService,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.enabled =
      this.config.get<string>('DREAM_CYCLE_ENABLED', 'true') !== 'false';
    this.timeZone = this.config.get<string>('DREAM_CYCLE_TZ', 'UTC');
  }

  onModuleInit() {
    if (this.enabled) {
      const job = new CronJob(
        '0 3 * * *',
        () => this.handleDreamCycleCron(),
        null,
        false,
        this.timeZone,
      );
      this.schedulerRegistry.addCronJob('dream-cycle', job);
      job.start();
      this.logger.log(
        `Dream Cycle scheduler enabled - runs daily at 03:00 ${this.timeZone}`,
      );
    } else {
      this.logger.log(
        'Dream Cycle scheduler disabled (DREAM_CYCLE_ENABLED=false)',
      );
    }
  }

  async handleDreamCycleCron() {
    if (!this.enabled) return;

    this.logger.log('Starting scheduled Dream Cycle run');
    const start = Date.now();

    try {
      // ENG-97: Prefer BullMQ-based execution; falls back to sequential automatically
      const { runId, mode } = await this.dreamCycle.runAsync();
      const durationSec = ((Date.now() - start) / 1000).toFixed(1);
      this.logger.log(
        `Dream Cycle ${mode === 'queued' ? 'enqueued' : 'completed'} in ${durationSec}s - ` +
          `runId=${runId}, mode=${mode}`,
      );
    } catch (error) {
      const durationSec = ((Date.now() - start) / 1000).toFixed(1);
      this.logger.error(
        `Dream Cycle failed after ${durationSec}s: ${error.message}`,
        error.stack,
      );
    }
  }
}
