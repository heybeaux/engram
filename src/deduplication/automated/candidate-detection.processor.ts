import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
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
    private readonly prisma: ServicePrismaService,
    private readonly detectionService: CandidateDetectionService,
    private readonly classificationService: DedupClassificationService,
    private readonly resolutionService: DedupResolutionService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log(
      `[CandidateDetectionProcessor] Processing job: ${job.name}`,
    );

    switch (job.name) {
      case DEDUP_AUTO_JOBS.DETECT_CANDIDATES: {
        // ENG-34: Discover accounts → users for per-user isolation
        const accounts = await this.prisma.account.findMany({
          select: { id: true },
        });

        let totalScanned = 0;
        let totalCreated = 0;
        let classifiedTotal = 0;
        let resolvedTotal = 0;

        for (const account of accounts) {
          const users = await this.prisma.user.findMany({
            where: { accountId: account.id, deletedAt: null },
            select: { id: true },
          });

          for (const user of users) {
            // Phase 1 — Detection (per user)
            const detection = await this.detectionService.detectCandidates(
              user.id,
            );
            totalScanned += detection.scanned;
            totalCreated += detection.created;

            // Phase 2 — Classification (per user)
            for (let i = 0; i < 50; i++) {
              const batch =
                await this.classificationService.processPendingCandidates(
                  user.id,
                );
              classifiedTotal += batch.processed;
              if (batch.processed === 0 && batch.errors === 0) break;
            }

            // Phase 3 — Resolution (per user)
            for (let i = 0; i < 50; i++) {
              const batch =
                await this.resolutionService.processClassifiedCandidates(
                  user.id,
                );
              resolvedTotal += batch.processed;
              if (batch.processed === 0 && batch.errors === 0) break;
            }
          }
        }

        this.logger.log(
          `[CandidateDetectionProcessor] Detection: scanned=${totalScanned}, created=${totalCreated}`,
        );
        this.logger.log(
          `[CandidateDetectionProcessor] Classification: processed=${classifiedTotal}`,
        );
        this.logger.log(
          `[CandidateDetectionProcessor] Resolution: processed=${resolvedTotal}`,
        );

        return {
          detection: { scanned: totalScanned, created: totalCreated },
          classifiedTotal,
          resolvedTotal,
        };
      }

      case DEDUP_AUTO_JOBS.CLASSIFY_CANDIDATES:
        // Note: standalone classify/resolve jobs remain global as they process
        // existing candidates that were already user-scoped during detection
        return this.classificationService.processPendingCandidates();

      case DEDUP_AUTO_JOBS.RESOLVE_CANDIDATES:
        return this.resolutionService.processClassifiedCandidates();

      default:
        this.logger.warn(
          `[CandidateDetectionProcessor] Unknown job: ${job.name}`,
        );
        return null;
    }
  }
}
