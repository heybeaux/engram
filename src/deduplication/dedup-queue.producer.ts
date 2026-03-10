import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  DEDUP_QUEUE,
  DEDUP_JOBS,
  DedupBatchJobData,
  DedupBacklogJobData,
} from './dedup.queue';

@Injectable()
export class DedupQueueProducer {
  private readonly logger = new Logger(DedupQueueProducer.name);

  constructor(@InjectQueue(DEDUP_QUEUE) private readonly queue: Queue) {}

  async enqueueBatch(data: DedupBatchJobData): Promise<void> {
    await this.queue.add(DEDUP_JOBS.PROCESS_BATCH, data, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 100, age: 86400 },
      removeOnFail: { count: 50 },
      jobId: `dedup-batch-${Date.now()}`,
    });
    this.logger.log(`Dedup batch job enqueued (trigger=${data.trigger})`);
  }

  async enqueueBacklog(data: DedupBacklogJobData = {}): Promise<void> {
    await this.queue.add(DEDUP_JOBS.PROCESS_BACKLOG, data, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 100, age: 86400 },
      removeOnFail: { count: 50 },
      jobId: `dedup-backlog-${Date.now()}`,
    });
    this.logger.log('Dedup backlog job enqueued');
  }
}
