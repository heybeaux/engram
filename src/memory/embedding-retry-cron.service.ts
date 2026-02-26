import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MemoryPipelineService } from './memory-pipeline.service';

/**
 * HEY-345: Cron job to retry failed/pending embeddings.
 * Runs every 5 minutes to pick up memories that failed embedding generation.
 */
@Injectable()
export class EmbeddingRetryCronService {
  private readonly logger = new Logger(EmbeddingRetryCronService.name);

  constructor(private readonly memoryPipeline: MemoryPipelineService) {}

  @Cron('*/5 * * * *')
  async handleEmbeddingRetry(): Promise<void> {
    this.logger.debug('[EmbeddingRetryCron] Starting embedding retry cycle');
    try {
      const result = await this.memoryPipeline.retryFailedEmbeddings();
      if (result.retried > 0 || result.discovered > 0) {
        this.logger.log(
          `[EmbeddingRetryCron] Retry complete: ${result.succeeded}/${result.retried} succeeded, ${result.discovered} discovered`,
        );
      }
    } catch (error) {
      this.logger.error(
        '[EmbeddingRetryCron] Retry cycle failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }
}
