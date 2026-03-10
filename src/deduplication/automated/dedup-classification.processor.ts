import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { DedupClassificationService } from './dedup-classification.service';
import { DEDUP_AUTO_JOBS } from './candidate-detection.processor';

export const DEDUP_AUTO_CLASSIFICATION_QUEUE = 'dedup-auto-classification';

/**
 * Dedup Classification Processor — Phase 2 BullMQ worker
 *
 * Processes jobs from the 'dedup-auto-classification' queue to trigger
 * LLM-based classification of PENDING DedupCandidates.
 */
@Processor(DEDUP_AUTO_CLASSIFICATION_QUEUE)
export class DedupClassificationProcessor extends WorkerHost {
  private readonly logger = new Logger(DedupClassificationProcessor.name);

  constructor(
    private readonly classificationService: DedupClassificationService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log(
      `[DedupClassificationProcessor] Processing job: ${job.name}`,
    );

    switch (job.name) {
      case DEDUP_AUTO_JOBS.CLASSIFY_CANDIDATES:
        return this.classificationService.processPendingCandidates();

      default:
        this.logger.warn(
          `[DedupClassificationProcessor] Unknown job: ${job.name}`,
        );
        return null;
    }
  }
}
