import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Optional } from '@nestjs/common';
import {
  DREAM_CYCLE_QUEUE,
  DREAM_CYCLE_JOBS,
  DreamCycleJobData,
  DreamCycleCursor,
} from './dream-cycle.queue';
import { DreamCycleRunTrackerService } from './dream-cycle-run-tracker.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { DreamCyclePendingStage } from './stages/dream-cycle-pending.stage';
import { DreamCycleTieringStage } from './stages/dream-cycle-tiering.stage';
import { DreamCycleConsolidationStage } from './stages/dream-cycle-consolidation.stage';
import { DreamCyclePatternsStage } from './stages/dream-cycle-patterns.stage';
import { DreamCycleDriftStage } from './stages/dream-cycle-drift.stage';
import { DreamCycleIdentityStage } from './stages/dream-cycle-identity.stage';
import { DreamCycleArchivalStage } from './stages/dream-cycle-archival.stage';
import { ClusteringService } from '../clustering/clustering.service';

@Processor(DREAM_CYCLE_QUEUE)
export class DreamCycleQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(DreamCycleQueueProcessor.name);

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly tracker: DreamCycleRunTrackerService,
    private readonly pendingStage: DreamCyclePendingStage,
    private readonly tieringStage: DreamCycleTieringStage,
    private readonly consolidationStage: DreamCycleConsolidationStage,
    private readonly patternsStage: DreamCyclePatternsStage,
    private readonly driftStage: DreamCycleDriftStage,
    private readonly identityStage: DreamCycleIdentityStage,
    private readonly archivalStage: DreamCycleArchivalStage,
    @Optional() private readonly clusteringService?: ClusteringService,
  ) {
    super();
  }

  async process(job: Job<DreamCycleJobData>): Promise<any> {
    const { runId, userId, dryRun, maxLlmCalls } = job.data;
    const cursor: DreamCycleCursor = job.data.cursor ?? {};
    const stageStart = new Date();
    const totalMemories = await this.prisma.memory.count({
      where: { deletedAt: null, userId },
    });
    this.logger.log(
      `Processing: ${job.name} runId=${runId} userId=${userId} total=${totalMemories}`,
    );

    const record = await this.tracker.startStage(
      runId,
      job.name,
      totalMemories,
    );

    try {
      const result = await this.dispatch(job, cursor);

      // Build updated cursor for downstream stages
      const updatedCursor: DreamCycleCursor = {
        ...cursor,
        lastStageRowsTouched: this.extractRowsTouched(job.name, result),
      };
      if (result?.llmCalls != null) {
        updatedCursor.llmCallsUsed =
          (cursor.llmCallsUsed ?? 0) + result.llmCalls;
      }

      await this.tracker.completeStage(
        record.id,
        updatedCursor.lastStageRowsTouched ?? 0,
        stageStart,
      );

      // Return cursor + stage result so parent jobs can access it
      return { ...result, cursor: updatedCursor };
    } catch (err) {
      const error = err as Error;
      if (error.message?.includes('sanity gate FAILED')) {
        await this.tracker.abortStage(
          record.id,
          0,
          totalMemories,
          error.message,
          stageStart,
        );
      } else {
        await this.tracker.errorStage(record.id, error, stageStart);
      }
      throw err;
    }
  }

  private async dispatch(
    job: Job<DreamCycleJobData>,
    cursor: DreamCycleCursor,
  ): Promise<any> {
    const { userId, dryRun, maxLlmCalls } = job.data;
    const remainingLlm =
      (maxLlmCalls ?? 50) - (cursor.llmCallsUsed ?? 0);

    switch (job.name) {
      case DREAM_CYCLE_JOBS.PENDING:
        return this.pendingStage.run(userId, dryRun, remainingLlm);

      case DREAM_CYCLE_JOBS.TIERING:
        return this.tieringStage.run(userId, dryRun);

      case DREAM_CYCLE_JOBS.CONSOLIDATION:
        return this.consolidationStage.run(userId, dryRun);

      case DREAM_CYCLE_JOBS.PATTERNS:
        return this.patternsStage.run(userId, dryRun, remainingLlm);

      case DREAM_CYCLE_JOBS.CLUSTERING:
        if (!this.clusteringService) {
          this.logger.log('Clustering service not available — skipping');
          return { skipped: true };
        }
        return this.clusteringService.run({ userId, dryRun });

      case DREAM_CYCLE_JOBS.DRIFT:
        return this.driftStage.run(userId, dryRun);

      case DREAM_CYCLE_JOBS.IDENTITY:
        return this.identityStage.run(userId, dryRun, remainingLlm);

      case DREAM_CYCLE_JOBS.ARCHIVAL:
        return this.archivalStage.run(userId, dryRun);

      case DREAM_CYCLE_JOBS.REPORT: {
        this.logger.log(`Dream Cycle flow COMPLETE: runId=${job.data.runId}`);
        return { status: 'COMPLETED', runId: job.data.runId };
      }

      default:
        throw new Error(`Unknown job: ${job.name}`);
    }
  }

  /**
   * Extract a meaningful "rows touched" count from a stage result
   * for the run tracker, depending on which stage produced it.
   */
  private extractRowsTouched(jobName: string, result: any): number {
    if (!result) return 0;
    switch (jobName) {
      case DREAM_CYCLE_JOBS.PENDING:
        return result.processed ?? 0;
      case DREAM_CYCLE_JOBS.TIERING:
        return (result.promoted ?? 0) + (result.demoted ?? 0);
      case DREAM_CYCLE_JOBS.CONSOLIDATION:
        return result.archived ?? 0;
      case DREAM_CYCLE_JOBS.PATTERNS:
        return result.patternsCreated ?? 0;
      case DREAM_CYCLE_JOBS.CLUSTERING:
        return result.clustersFound ?? 0;
      case DREAM_CYCLE_JOBS.ARCHIVAL:
        return result.archived ?? 0;
      default:
        return 0;
    }
  }
}
