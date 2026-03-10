import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import {
  DREAM_CYCLE_QUEUE,
  DREAM_CYCLE_JOBS,
  DreamCycleJobData,
} from './dream-cycle.queue';
import { DreamCycleRunTrackerService } from './dream-cycle-run-tracker.service';
import { assertSanityGate } from './dream-cycle-sanity-gate';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { DreamCycleDedupStage } from './stages/dream-cycle-dedup.stage';
import { DreamCycleStalenessStage } from './stages/dream-cycle-staleness.stage';
import { DreamCyclePendingStage } from './stages/dream-cycle-pending.stage';
import { DreamCycleTieringStage } from './stages/dream-cycle-tiering.stage';
import { DreamCyclePatternsStage } from './stages/dream-cycle-patterns.stage';
import { DreamCycleDriftStage } from './stages/dream-cycle-drift.stage';
import { DreamCycleIdentityStage } from './stages/dream-cycle-identity.stage';

@Processor(DREAM_CYCLE_QUEUE)
export class DreamCycleQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(DreamCycleQueueProcessor.name);

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly tracker: DreamCycleRunTrackerService,
    private readonly dedupStage: DreamCycleDedupStage,
    private readonly stalenessStage: DreamCycleStalenessStage,
    private readonly pendingStage: DreamCyclePendingStage,
    private readonly tieringStage: DreamCycleTieringStage,
    private readonly patternsStage: DreamCyclePatternsStage,
    private readonly driftStage: DreamCycleDriftStage,
    private readonly identityStage: DreamCycleIdentityStage,
  ) {
    super();
  }

  async process(job: Job<DreamCycleJobData>): Promise<any> {
    const { runId, userId, dryRun, maxLlmCalls, maxMemories } = job.data;
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
      switch (job.name) {
        case DREAM_CYCLE_JOBS.DEDUP: {
          const r = await this.dedupStage.run(userId, dryRun, maxMemories);
          assertSanityGate('dedup', r.scanned, totalMemories);
          await this.tracker.completeStage(record.id, r.scanned, stageStart);
          return r;
        }
        case DREAM_CYCLE_JOBS.STALENESS: {
          const r = await this.stalenessStage.run(userId, dryRun);
          await this.tracker.completeStage(record.id, r.archived, stageStart);
          return r;
        }
        case DREAM_CYCLE_JOBS.PENDING: {
          const r = await this.pendingStage.run(userId, dryRun);
          await this.tracker.completeStage(
            record.id,
            r.processed ?? 0,
            stageStart,
          );
          return r;
        }
        case DREAM_CYCLE_JOBS.TIERING: {
          const r = await this.tieringStage.run(userId, dryRun);
          await this.tracker.completeStage(
            record.id,
            (r.promoted ?? 0) + (r.demoted ?? 0),
            stageStart,
          );
          return r;
        }
        case DREAM_CYCLE_JOBS.PATTERNS: {
          const r = await this.patternsStage.run(
            userId,
            dryRun,
            maxLlmCalls ?? 50,
          );
          await this.tracker.completeStage(
            record.id,
            r.patternsCreated,
            stageStart,
          );
          return r;
        }
        case DREAM_CYCLE_JOBS.DRIFT: {
          const r = await this.driftStage.run(userId, dryRun);
          await this.tracker.completeStage(record.id, 0, stageStart);
          return r;
        }
        case DREAM_CYCLE_JOBS.IDENTITY: {
          const r = await this.identityStage.run(
            userId,
            dryRun,
            maxLlmCalls ?? 50,
          );
          await this.tracker.completeStage(record.id, 0, stageStart);
          return r;
        }
        case DREAM_CYCLE_JOBS.REPORT: {
          await this.tracker.completeStage(record.id, 0, stageStart);
          this.logger.log(`Dream Cycle flow COMPLETE: runId=${runId}`);
          return { status: 'COMPLETED', runId };
        }
        default:
          throw new Error(`Unknown job: ${job.name}`);
      }
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
}
