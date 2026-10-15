import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MemoryPipelineService } from './memory-pipeline.service';

/**
 * HEY-345: Cron job to retry failed/pending embeddings every 5 minutes.
 *
 * ENG-61: each tick is a bounded, single-flight run (see
 * MemoryPipelineService.retryFailedEmbeddings). Set
 * EMBEDDING_RETRY_CRON_ENABLED=false to turn the cron off in a process, e.g.
 * on extra workers when another process owns retries. Default: enabled.
 */
@Injectable()
export class EmbeddingRetryCron {
  private readonly logger = new Logger(EmbeddingRetryCron.name);

  constructor(private readonly memoryPipeline: MemoryPipelineService) {}

  @Cron('*/5 * * * *')
  async handleRetry(): Promise<void> {
    if (process.env.EMBEDDING_RETRY_CRON_ENABLED === 'false') return;
    this.logger.debug('[EmbeddingRetry] Cron triggered');
    try {
      const result = await this.memoryPipeline.retryFailedEmbeddings();
      if (result.skipped) {
        this.logger.log(
          '[EmbeddingRetry] Previous run still in flight — tick skipped',
        );
        return;
      }
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
