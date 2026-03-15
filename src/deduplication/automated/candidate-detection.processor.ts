import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { CandidateDetectionService } from './candidate-detection.service';
import { DedupClassificationService } from './dedup-classification.service';
import { DedupResolutionService } from './dedup-resolution.service';

export const DEDUP_AUTO_DETECTION_QUEUE = 'dedup-auto-detection';

export const DEDUP_AUTO_JOBS = {
  DETECT_CANDIDATES: 'dedup:detect-candidates',
  CLASSIFY_CANDIDATES: 'dedup:classify-candidates',
  RESOLVE_CANDIDATES: 'dedup:resolve-candidates',
} as const;

/**
 * Candidate Detection Processor — BullMQ worker for the automated dedup pipeline
 *
 * Processes jobs from the 'dedup-auto-detection' queue.
 * DETECT_CANDIDATES chains all 3 phases: detection → classification → resolution.
 */
@Processor(DEDUP_AUTO_DETECTION_QUEUE)
export class CandidateDetectionProcessor extends WorkerHost {
  private readonly logger = new Logger(CandidateDetectionProcessor.name);

  constructor(
    private readonly detectionService: CandidateDetectionService,
    private readonly classificationService: DedupClassificationService,
    private readonly resolutionService: DedupResolutionService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log(`[CandidateDetectionProcessor] Processing job: ${job.name}`);

    switch (job.name) {
      case DEDUP_AUTO_JOBS.DETECT_CANDIDATES: {
        // Phase 1 — Detection
        const detection = await this.detectionService.detectCandidates();
        this.logger.log(
          `[CandidateDetectionProcessor] Detection: scanned=${detection.scanned}, created=${detection.created}`,
        );

        // Phase 2 — Classification (drain pending)
        let classifiedTotal = 0;
        for (let i = 0; i < 50; i++) {
          const batch = await this.classificationService.processPendingCandidates();
          classifiedTotal += batch.processed;
          if (batch.processed === 0 && batch.errors === 0) break;
        }
        this.logger.log(
          `[CandidateDetectionProcessor] Classification: processed=${classifiedTotal}`,
        );

        // Phase 3 — Resolution (drain classified)
        let resolvedTotal = 0;
        for (let i = 0; i < 50; i++) {
          const batch = await this.resolutionService.processClassifiedCandidates();
          resolvedTotal += batch.processed;
          if (batch.processed === 0 && batch.errors === 0) break;
        }
        this.logger.log(
          `[CandidateDetectionProcessor] Resolution: processed=${resolvedTotal}`,
        );

        return { detection, classifiedTotal, resolvedTotal };
      }

      case DEDUP_AUTO_JOBS.CLASSIFY_CANDIDATES:
        return this.classificationService.processPendingCandidates();

      case DEDUP_AUTO_JOBS.RESOLVE_CANDIDATES:
        return this.resolutionService.processClassifiedCandidates();

      default:
        this.logger.warn(`[CandidateDetectionProcessor] Unknown job: ${job.name}`);
        return null;
    }
  }
}
