import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { MergeService } from './merge.service';
import { LineageService } from './lineage.service';
import { SafetyService } from './safety.service';
import { ReviewService } from './review.service';
import {
  DEDUP_QUEUE,
  DEDUP_JOBS,
  DedupBatchJobData,
  DedupBacklogJobData,
} from './dedup.queue';
import { MergeStrategy, CandidateStatus } from './dto/deduplication.dto';

interface BatchRunStats {
  processed: number;
  autoMerged: number;
  skippedSafety: number;
  leftForReview: number;
  errors: number;
}

@Processor(DEDUP_QUEUE)
export class DedupQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(DedupQueueProcessor.name);

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly mergeService: MergeService,
    private readonly lineageService: LineageService,
    private readonly safetyService: SafetyService,
    private readonly reviewService: ReviewService,
  ) {
    super();
  }

  async process(
    job: Job<DedupBatchJobData | DedupBacklogJobData>,
  ): Promise<any> {
    switch (job.name) {
      case DEDUP_JOBS.PROCESS_BATCH:
        return this.processBatch(job as Job<DedupBatchJobData>);
      case DEDUP_JOBS.PROCESS_BACKLOG:
        return this.processBacklogJob(job as Job<DedupBacklogJobData>);
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  private async processBatch(
    job: Job<DedupBatchJobData>,
  ): Promise<BatchRunStats> {
    const batchSize = job.data.batchSize ?? 50;
    const startedAt = new Date();
    const stats: BatchRunStats = {
      processed: 0,
      autoMerged: 0,
      skippedSafety: 0,
      leftForReview: 0,
      errors: 0,
    };
    const errorMessages: string[] = [];

    this.logger.log(
      `Starting dedup batch (trigger=${job.data.trigger}, batchSize=${batchSize})`,
    );

    try {
      // Fetch pending candidates in batch
      const candidates = await this.prisma.mergeCandidate.findMany({
        where: { status: CandidateStatus.PENDING },
        orderBy: [{ similarity: 'desc' }, { createdAt: 'asc' }],
        take: batchSize,
      });

      if (candidates.length === 0) {
        this.logger.log('No pending candidates to process');
        return stats;
      }

      // Load configs per user (cache within batch)
      const configCache = new Map<
        string,
        { autoMergeThreshold: number; autoResolveThreshold: number }
      >();

      for (const candidate of candidates) {
        try {
          const config = await this.getConfigForUser(
            candidate.userId,
            configCache,
          );
          await this.processCandidate(candidate, config, stats);
          stats.processed++;
          await job.updateProgress(
            Math.round((stats.processed / candidates.length) * 100),
          );
        } catch (err) {
          stats.errors++;
          const msg = `Failed to process candidate ${candidate.id}: ${(err as Error).message}`;
          errorMessages.push(msg);
          this.logger.error(msg);
        }
      }

      // Record batch run
      await this.recordBatchRun(
        startedAt,
        stats,
        errorMessages,
        job.data.trigger,
      );
    } catch (err) {
      this.logger.error(`Dedup batch failed: ${(err as Error).message}`);
      throw err;
    }

    this.logger.log(
      `Dedup batch complete: processed=${stats.processed} merged=${stats.autoMerged} skipped=${stats.skippedSafety} review=${stats.leftForReview} errors=${stats.errors}`,
    );

    // Cleanup step: process high-confidence backlog
    try {
      const backlogStats = await this.reviewService.processBacklog();
      this.logger.log(
        `Backlog cleanup: approved=${backlogStats.approved} skipped=${backlogStats.skippedSafety} errors=${backlogStats.errors}`,
      );
    } catch (err) {
      this.logger.error(`Backlog cleanup failed: ${(err as Error).message}`);
    }

    return stats;
  }

  private async processCandidate(
    candidate: {
      id: string;
      userId: string;
      memoryIds: string[];
      similarity: number;
      suggestedStrategy: string;
      suggestedSurvivorId: string;
      safetyFlags: string;
    },
    config: { autoMergeThreshold: number; autoResolveThreshold: number },
    stats: BatchRunStats,
  ): Promise<void> {
    // Parse safety flags
    const safetyFlags: Array<{ type: string }> = (() => {
      try {
        return typeof candidate.safetyFlags === 'string'
          ? JSON.parse(candidate.safetyFlags)
          : (candidate.safetyFlags ?? []);
      } catch {
        return [];
      }
    })();

    // Check safety for all memories in the candidate
    const safetyResults = await this.safetyService.checkMultipleSafety(
      candidate.memoryIds,
    );

    const hasProtected = safetyResults.some((r) => r.isProtected);
    const canAutoMerge = safetyResults.every((r) => r.canAutoMerge);

    // NEVER auto-merge protected memories (CONSTRAINT type, safety-critical)
    if (hasProtected) {
      stats.skippedSafety++;
      return;
    }

    // High confidence: auto-merge
    if (candidate.similarity >= config.autoMergeThreshold && canAutoMerge) {
      await this.executeMerge(candidate, 'batch');
      stats.autoMerged++;
      return;
    }

    // Medium confidence: auto-resolve threshold reached but below auto-merge
    if (candidate.similarity >= config.autoResolveThreshold && canAutoMerge) {
      // Auto-approve via review service
      try {
        await this.reviewService.approve(
          candidate.id,
          { strategy: candidate.suggestedStrategy as MergeStrategy },
          'auto-resolve',
        );
        stats.autoMerged++;
      } catch {
        stats.leftForReview++;
      }
      return;
    }

    // Low confidence: leave in review queue
    stats.leftForReview++;
  }

  private async executeMerge(
    candidate: {
      id: string;
      userId: string;
      memoryIds: string[];
      similarity: number;
      suggestedStrategy: string;
      suggestedSurvivorId: string;
    },
    trigger: 'auto' | 'batch',
  ): Promise<void> {
    const strategy = candidate.suggestedStrategy as MergeStrategy;

    const mergeResult = await this.mergeService.merge(
      candidate.memoryIds,
      strategy as any,
      { survivorId: candidate.suggestedSurvivorId },
    );

    // Record merge event with canRollback: true
    await this.lineageService.recordMerge(
      candidate.userId,
      mergeResult,
      trigger,
      candidate.similarity,
      'dedup-pipeline',
    );

    // Update candidate status to APPROVED
    await this.prisma.mergeCandidate.update({
      where: { id: candidate.id },
      data: {
        status: CandidateStatus.APPROVED,
        reviewedAt: new Date(),
        reviewedBy: 'dedup-pipeline',
      },
    });
  }

  private async processBacklogJob(
    job: Job<DedupBacklogJobData>,
  ): Promise<{ approved: number; skippedSafety: number; errors: number }> {
    this.logger.log('Processing backlog drain job');
    const result = await this.reviewService.processBacklog(
      job.data.minSimilarity,
      job.data.minAgeHours,
    );
    this.logger.log(
      `Backlog drain complete: approved=${result.approved} skipped=${result.skippedSafety} errors=${result.errors}`,
    );
    return result;
  }

  private async getConfigForUser(
    userId: string,
    cache: Map<
      string,
      { autoMergeThreshold: number; autoResolveThreshold: number }
    >,
  ): Promise<{ autoMergeThreshold: number; autoResolveThreshold: number }> {
    if (cache.has(userId)) {
      return cache.get(userId)!;
    }

    const dbConfig = await this.prisma.dedupConfig.findUnique({
      where: { userId },
    });

    const config = {
      autoMergeThreshold: dbConfig?.autoMergeThreshold ?? 0.88,
      autoResolveThreshold: dbConfig?.autoResolveThreshold ?? 0.82,
    };

    cache.set(userId, config);
    return config;
  }

  private async recordBatchRun(
    startedAt: Date,
    stats: BatchRunStats,
    errors: string[],
    trigger: string,
  ): Promise<void> {
    try {
      await this.prisma.dedupBatchRun.create({
        data: {
          userId: 'system',
          status: stats.errors > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
          startedAt,
          completedAt: new Date(),
          memoriesProcessed: stats.processed,
          clustersFound: stats.processed,
          autoMerged: stats.autoMerged,
          queuedForReview: stats.leftForReview,
          skipped: stats.skippedSafety,
          errors,
          configSnapshot: JSON.stringify({ trigger }),
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to record batch run: ${(err as Error).message}`,
      );
    }
  }
}
