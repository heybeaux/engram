import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { DedupQueueProducer } from './dedup-queue.producer';
import { CandidateStatus } from './dto/deduplication.dto';

@Injectable()
export class DedupSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(DedupSchedulerService.name);
  private readonly pipelineEnabled: boolean;
  private readonly backlogThreshold: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: ServicePrismaService,
    private readonly producer: DedupQueueProducer,
  ) {
    this.pipelineEnabled =
      this.configService.get<string>('DEDUP_PIPELINE_ENABLED', 'true') ===
      'true';
    this.backlogThreshold = parseInt(
      this.configService.get<string>('DEDUP_BACKLOG_THRESHOLD', '1000'),
      10,
    );
  }

  onModuleInit() {
    this.logger.log(
      `Dedup scheduler initialized (enabled=${this.pipelineEnabled}, backlogThreshold=${this.backlogThreshold})`,
    );
  }

  /**
   * Main scheduled dedup run — 4am daily (staggered from dream cycle at 3am)
   */
  @Cron('0 4 * * *')
  async handleScheduledDedup(): Promise<void> {
    if (!this.pipelineEnabled) {
      this.logger.debug('Dedup pipeline disabled, skipping scheduled run');
      return;
    }

    // Check if any user has batchEnabled
    const enabledConfig = await this.prisma.dedupConfig.findFirst({
      where: { batchEnabled: true },
    });

    if (!enabledConfig) {
      this.logger.debug('No users have batchEnabled=true, skipping');
      return;
    }

    this.logger.log('Scheduled dedup: enqueuing batch job');
    await this.producer.enqueueBatch({ trigger: 'cron', batchSize: 50 });
  }

  /**
   * Backlog drain — runs every 2 hours, activates when pending > threshold
   */
  @Cron('0 */2 * * *')
  async handleBacklogDrain(): Promise<void> {
    if (!this.pipelineEnabled) {
      return;
    }

    const pendingCount = await this.getPendingCount();

    if (pendingCount <= this.backlogThreshold) {
      return;
    }

    this.logger.warn(
      `Backlog drain activated: ${pendingCount} pending candidates (threshold=${this.backlogThreshold})`,
    );

    await this.producer.enqueueBatch({
      trigger: 'backlog-drain',
      batchSize: 100,
    });
  }

  /**
   * Get the count of pending merge candidates across all users
   */
  async getPendingCount(): Promise<number> {
    const result = await this.prisma.mergeCandidate.count({
      where: { status: CandidateStatus.PENDING },
    });
    return result;
  }

  /**
   * Manually trigger a drain (called from controller endpoint)
   */
  async triggerManualDrain(): Promise<{
    enqueued: boolean;
    pendingCount: number;
  }> {
    const pendingCount = await this.getPendingCount();

    if (pendingCount === 0) {
      return { enqueued: false, pendingCount: 0 };
    }

    await this.producer.enqueueBatch({
      trigger: 'manual',
      batchSize: 100,
    });

    // Also enqueue a backlog cleanup job
    await this.producer.enqueueBacklog();

    return { enqueued: true, pendingCount };
  }
}
