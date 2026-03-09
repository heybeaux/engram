import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { CandidateDetectionService } from './candidate-detection.service';

export const DEDUP_AUTO_DETECTION_QUEUE = 'dedup-auto-detection';

export const DEDUP_AUTO_JOBS = {
  DETECT_CANDIDATES: 'dedup:detect-candidates',
  CLASSIFY_CANDIDATES: 'dedup:classify-candidates',
  RESOLVE_CANDIDATES: 'dedup:resolve-candidates',
} as const;

/**
 * Candidate Detection Processor — Phase 1 BullMQ worker
 *
 * Processes jobs from the 'dedup-auto-detection' queue to trigger
 * candidate detection, classification, and resolution phases.
 */
@Processor(DEDUP_AUTO_DETECTION_QUEUE)
export class CandidateDetectionProcessor extends WorkerHost {
  private readonly logger = new Logger(CandidateDetectionProcessor.name);

  constructor(private readonly detectionService: CandidateDetectionService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log(`[CandidateDetectionProcessor] Processing job: ${job.name}`);

    switch (job.name) {
      case DEDUP_AUTO_JOBS.DETECT_CANDIDATES:
        return this.detectionService.detectCandidates();

      default:
        this.logger.warn(`[CandidateDetectionProcessor] Unknown job: ${job.name}`);
        return null;
    }
  }
}
