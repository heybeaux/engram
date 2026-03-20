import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  EMBEDDING_QUEUE,
  EMBEDDING_JOBS,
  EmbedMemoryJobData,
} from './embedding.queue';

@Injectable()
export class EmbeddingQueueProducer {
  private readonly logger = new Logger(EmbeddingQueueProducer.name);

  constructor(@InjectQueue(EMBEDDING_QUEUE) private readonly queue: Queue) {}

  async enqueueEmbedding(data: EmbedMemoryJobData): Promise<void> {
    await this.queue.add(EMBEDDING_JOBS.EMBED_MEMORY, data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { count: 1000, age: 86400 },
      removeOnFail: { count: 500 },
    });
    this.logger.debug(`Embedding job enqueued: memoryId=${data.memoryId}`);
  }
}
