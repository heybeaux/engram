import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MemoryPipelineService } from './memory-pipeline.service';

/**
 * HEY-345: Cron job to retry failed/pending embeddings every 5 minutes.
 */
@Injectable()
export class EmbeddingRetryCron {
  private readonly logger = new Logger(EmbeddingRetryCron.name);

  constructor(private readonly memoryPipeline: MemoryPipelineService) {}

  @Cron('*/5 * * * *')
  async handleRetry(): Promise<void> {
    this.logger.debug('[EmbeddingRetry] Cron triggered');
    try {
      const result = await this.memoryPipeline.retryFailedEmbeddings();
      if (result.retried > 0 || result.discovered > 0) {
        this.logger.log(
          `[EmbeddingRetry] Retried ${result.retried}: ${result.succeeded} ok, ${result.failed} failed, ${result.discovered} discovered, ${result.exhaustedRetries} exhausted`,
        );
      }
      if (result.exhaustedRetries > 0) {
        this.logger.error(
          `[EmbeddingRetry] DEAD LETTER: ${result.exhaustedRetries} memories will never be searchable`,
        );
      }
    } catch (error) {
      this.logger.error(
        '[EmbeddingRetry] Cron failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }
}
