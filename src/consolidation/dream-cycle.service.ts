import { Injectable, Optional, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DreamStartedEvent, DreamCompletedEvent } from '../events/event-types';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { ConfigService } from '@nestjs/config';
import { TrustProfileService } from '../identity/trust-profile.service';
import { GenerateContextService } from './generate-context.service';
import { ClusteringService } from '../clustering/clustering.service';
import { FogIndexService } from '../fog-index/fog-index.service';
import {
  DreamCyclePatternsStage,
  DreamCycleDriftStage,
  DreamCycleIdentityStage,
  DreamCyclePendingStage,
  DreamCycleTieringStage,
  DreamCycleConsolidationStage,
} from './stages';
import * as os from 'os';
import { DreamCycleRunTrackerService } from './dream-cycle-run-tracker.service';
import { assertSanityGate } from './dream-cycle-sanity-gate';
import { HealthMetricsService } from '../health/health-metrics.service';
import { DreamCycleQueueProducer } from './dream-cycle-queue.producer';

// Advisory lock key for Dream Cycle (arbitrary unique int)
const DREAM_CYCLE_LOCK_KEY = 294967;

export type DreamCycleStage =
  | 'pending'
  | 'tiering'
  | 'patterns'
  | 'clustering'
  | 'drift'
  | 'identity'
  | 'report';

export interface DreamCycleOptions {
  dryRun?: boolean;
  stages?: DreamCycleStage[];
  userId?: string;
  maxMemories?: number;
}

export interface DreamCycleResult {
  id: string;
  status: 'COMPLETED' | 'FAILED' | 'DRY_RUN' | 'SKIPPED';
  durationMs: number;
  scoresRefreshed: number;
  duplicatesMerged: number;
  patternsCreated: number;
  memoriesArchived: number;
  pendingResolved?: number;
  totalActive: number;
  avgEffectiveScore: number;
  stageDetails: Record<string, any>;
  errors: string[];
  llmCallsUsed?: number;
  usersProcessed?: number;
}

const ALL_STAGES: DreamCycleStage[] = [
  'pending',
  'tiering',
  'patterns',
  'clustering',
  'drift',
  'identity',
  'report',
];

@Injectable()
export class DreamCycleService {
  private readonly logger = new Logger(DreamCycleService.name);
  private readonly maxLlmCalls: number;

  constructor(
    private prisma: ServicePrismaService,
    private config: ConfigService,
    private pendingStage: DreamCyclePendingStage,
    private tieringStage: DreamCycleTieringStage,
    private consolidationStage: DreamCycleConsolidationStage,
    private patternsStage: DreamCyclePatternsStage,
    private driftStage: DreamCycleDriftStage,
    private identityStage: DreamCycleIdentityStage,
    private tracker: DreamCycleRunTrackerService,
    @Optional() private generateContextService?: GenerateContextService,
    @Optional() private clusteringService?: ClusteringService,
    @Optional() private fogIndexService?: FogIndexService,
    @Optional() private trustProfileService?: TrustProfileService,
    @Optional() private eventEmitter?: EventEmitter2,
    @Optional() private readonly healthMetrics?: HealthMetricsService,
    @Optional() private readonly queueProducer?: DreamCycleQueueProducer,
  ) {
    this.maxLlmCalls = parseInt(
      this.config.get('DREAM_MAX_LLM_CALLS') ?? '50',
      10,
    );
  }

  /**
   * Returns true when BullMQ queue infrastructure is available (Redis connected).
   */
  get hasQueueBackend(): boolean {
    return !!this.queueProducer;
  }

  async acquireLock(): Promise<boolean> {
    const result = await this.prisma.$queryRawUnsafe<
      Array<{ pg_try_advisory_lock: boolean }>
    >(`SELECT pg_try_advisory_lock(${DREAM_CYCLE_LOCK_KEY})`);
    return result[0]?.pg_try_advisory_lock === true;
  }

  async releaseLock(): Promise<void> {
    await this.prisma.$queryRawUnsafe(
      `SELECT pg_advisory_unlock(${DREAM_CYCLE_LOCK_KEY})`,
    );
  }

  private getInstanceId(): string {
    return `${os.hostname()}-${process.pid}`;
  }

  async run(options: DreamCycleOptions = {}): Promise<DreamCycleResult> {
    const locked = await this.acquireLock();
    if (!locked) {
      this.log('Dream Cycle already running on another instance — skipping');
      return {
        id: '',
        status: 'SKIPPED',
        durationMs: 0,
        scoresRefreshed: 0,
        duplicatesMerged: 0,
        patternsCreated: 0,
        memoriesArchived: 0,
        pendingResolved: 0,
        totalActive: 0,
        avgEffectiveScore: 0,
        stageDetails: {},
        errors: ['Skipped: another instance holds the lock'],
      };
    }

    try {
      return await this.runInternal(options);
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * ENG-97: Enqueue the dream cycle as atomic BullMQ jobs when Redis is
   * available. Each stage runs as an independent, retryable job.
   * Falls back to sequential execution if Redis/queue is unavailable.
   */
  async runAsync(
    options: DreamCycleOptions = {},
  ): Promise<{ runId: string; mode: 'queued' | 'sequential' }> {
    const userId =
      options.userId || this.config.get<string>('DEFAULT_USER_ID') || 'default';

    if (this.queueProducer) {
      try {
        const runId = await this.queueProducer.enqueue(userId, {
          dryRun: options.dryRun,
          maxLlmCalls: this.maxLlmCalls,
          maxMemories: options.maxMemories,
        });
        this.log(`Dream Cycle enqueued via BullMQ: runId=${runId}`);
        return { runId, mode: 'queued' };
      } catch (err) {
        this.log(
          `BullMQ enqueue failed, falling back to sequential: ${(err as Error).message}`,
          undefined,
          'error',
        );
      }
    }

    // Fallback: run synchronously
    const result = await this.run(options);
    return { runId: result.id, mode: 'sequential' };
  }

  private async runInternal(
    options: DreamCycleOptions = {},
  ): Promise<DreamCycleResult> {
    // Auto-discover users if no userId specified and no DEFAULT_USER_ID configured
    if (!options.userId && !this.config.get('DEFAULT_USER_ID')) {
      this.log(
        'No userId or DEFAULT_USER_ID configured — auto-discovering users per account',
      );

      // ENG-34: Discover accounts first, then iterate users per account
      // to guarantee cross-account isolation in background processing.
      const accounts = await this.prisma.account.findMany({
        select: { id: true },
      });

      if (accounts.length === 0) {
        throw new Error('No accounts found');
      }

      const allResults: DreamCycleResult[] = [];
      for (const account of accounts) {
        const users = await this.prisma.user.findMany({
          where: { accountId: account.id, deletedAt: null },
          select: { id: true },
        });

        this.log(
          `Account ${account.id}: found ${users.length} users`,
        );

        // Phase 0 scalability: run users in parallel with concurrency limit
        // DREAM_CYCLE_CONCURRENCY env var controls batch size (default: 5)
        // Does not affect per-user processing logic — recall scores unaffected.
        const concurrency = parseInt(
          this.config.get<string>('DREAM_CYCLE_CONCURRENCY', '5'),
          10,
        );
        const userQueue = [...users];
        const runUser = async (user: { id: string }) => {
          this.log(`Running Dream Cycle for user: ${user.id} (account: ${account.id})`);
          const result = await this.runInternal({ ...options, userId: user.id });
          allResults.push(result);
        };
        while (userQueue.length > 0) {
          const batch = userQueue.splice(0, concurrency);
          await Promise.all(batch.map(runUser));
        }
      }

      if (allResults.length === 0) {
        throw new Error('No users found with active accounts');
      }

      const combined: DreamCycleResult = {
        ...allResults[0],
        scoresRefreshed: allResults.reduce(
          (s, r) => s + (r.scoresRefreshed ?? 0),
          0,
        ),
        duplicatesMerged: allResults.reduce(
          (s, r) => s + (r.duplicatesMerged ?? 0),
          0,
        ),
        patternsCreated: allResults.reduce(
          (s, r) => s + (r.patternsCreated ?? 0),
          0,
        ),
        memoriesArchived: allResults.reduce(
          (s, r) => s + (r.memoriesArchived ?? 0),
          0,
        ),
        pendingResolved: allResults.reduce(
          (s, r) => s + (r.pendingResolved ?? 0),
          0,
        ),
        llmCallsUsed: allResults.reduce((s, r) => s + (r.llmCallsUsed ?? 0), 0),
        errors: allResults.flatMap((r) => r.errors ?? []),
        usersProcessed: allResults.length,
      };
      return combined;
    }

    const { dryRun = false, stages = ALL_STAGES, maxMemories } = options;

    const userId =
      options.userId || this.config.get<string>('DEFAULT_USER_ID') || 'default';
    const runId = `dc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const totalMemories = await this.tracker.getTotalMemoryCount(userId);
    const startTime = Date.now();
    const stageDetails: Record<string, any> = {};
    const errors: string[] = [];
    let scoresRefreshed = 0;
    let duplicatesMerged = 0;
    let patternsCreated = 0;
    let memoriesArchived = 0;
    let pendingResolved = 0;
    let llmCallsUsed = 0;

    const report = await this.prisma.dreamCycleReport.create({
      data: {
        userId,
        startedAt: new Date(),
        dryRun,
        status: 'RUNNING',
      },
    });

    const job = await this.prisma.consolidationJob.create({
      data: {
        userId,
        type: 'NIGHTLY',
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    this.log('Starting Dream Cycle', {
      userId,
      dryRun,
      stages,
      reportId: report.id,
    });

    this.emitSafe('dream.started', new DreamStartedEvent());

    try {
      // Stage 2.5: PENDING merge resolution
      if (stages.includes('pending') && llmCallsUsed < this.maxLlmCalls) {
        this.log('Stage 2.5: PENDING merge resolution');
        const pendingStart = new Date();
        const pendingRecord = await this.tracker.startStage(
          runId,
          'pending',
          totalMemories,
        );
        try {
          const pendingResult = await this.pendingStage.run(
            userId,
            dryRun,
            this.maxLlmCalls - llmCallsUsed,
          );
          await this.tracker.completeStage(
            pendingRecord.id,
            pendingResult.processed,
            pendingStart,
          );
          pendingResolved = pendingResult.processed;
          duplicatesMerged +=
            pendingResult.autoMerged + pendingResult.llmMerged;
          llmCallsUsed += pendingResult.llmCalls;
          stageDetails.pending = pendingResult;
          this.log('Stage 2.5 complete', pendingResult);
        } catch (err) {
          await this.tracker.errorStage(
            pendingRecord.id,
            err as Error,
            pendingStart,
          );
          const msg = `Pending stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 2.6: Memory tiering
      if (stages.includes('tiering')) {
        this.log('Stage 2.6: Memory tiering');
        const tieringStart = new Date();
        const tieringRecord = await this.tracker.startStage(
          runId,
          'tiering',
          totalMemories,
        );
        try {
          const tieringResult = await this.tieringStage.run(userId, dryRun);
          await this.tracker.completeStage(tieringRecord.id, 0, tieringStart);
          stageDetails.tiering = tieringResult;
          this.log('Stage 2.6 complete', tieringResult);
        } catch (err) {
          await this.tracker.errorStage(
            tieringRecord.id,
            err as Error,
            tieringStart,
          );
          const msg = `Tiering stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 2.7: Cold memory consolidation (Dream v2)
      if (stages.includes('tiering')) {
        this.log('Stage 2.7: Cold memory consolidation');
        const consolidationStart = new Date();
        const consolidationRecord = await this.tracker.startStage(
          runId,
          'consolidation',
          totalMemories,
        );
        try {
          const consolidationResult = await this.consolidationStage.run(
            userId,
            dryRun,
          );
          await this.tracker.completeStage(
            consolidationRecord.id,
            consolidationResult.archived,
            consolidationStart,
          );
          llmCallsUsed += consolidationResult.llmCalls;
          memoriesArchived += consolidationResult.archived;
          stageDetails.consolidation = consolidationResult;
          this.log('Stage 2.7 complete', consolidationResult);
        } catch (err) {
          await this.tracker.errorStage(
            consolidationRecord.id,
            err as Error,
            consolidationStart,
          );
          const msg = `Consolidation stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 3: Pattern extraction
      if (stages.includes('patterns') && llmCallsUsed < this.maxLlmCalls) {
        this.log('Stage 3: Pattern extraction');
        const patternsStart = new Date();
        const patternsRecord = await this.tracker.startStage(
          runId,
          'patterns',
          totalMemories,
        );
        try {
          const patternResult = await this.patternsStage.run(
            userId,
            dryRun,
            this.maxLlmCalls - llmCallsUsed,
          );
          await this.tracker.completeStage(
            patternsRecord.id,
            patternResult.patternsCreated,
            patternsStart,
          );
          patternsCreated = patternResult.patternsCreated;
          llmCallsUsed += patternResult.llmCalls;
          stageDetails.patterns = patternResult;
          this.log('Stage 3 complete', patternResult);
        } catch (err) {
          await this.tracker.errorStage(
            patternsRecord.id,
            err as Error,
            patternsStart,
          );
          const msg = `Pattern stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 3.5: Memory clustering
      if (stages.includes('clustering') && this.clusteringService) {
        this.log('Stage 3.5: Memory clustering');
        const clusteringStart = new Date();
        const clusteringRecord = await this.tracker.startStage(
          runId,
          'clustering',
          totalMemories,
        );
        try {
          const clusterResult = await this.clusteringService.run({
            userId,
            dryRun,
          });
          await this.tracker.completeStage(
            clusteringRecord.id,
            0,
            clusteringStart,
          );
          stageDetails.clustering = clusterResult;
          this.log('Stage 3.5 (clustering) complete', clusterResult);
        } catch (err) {
          await this.tracker.errorStage(
            clusteringRecord.id,
            err as Error,
            clusteringStart,
          );
          const msg = `Clustering stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 3.6: Drift analysis
      if (stages.includes('drift')) {
        this.log('Stage 3.6: Embedding drift analysis');
        const driftStart = new Date();
        const driftRecord = await this.tracker.startStage(
          runId,
          'drift',
          totalMemories,
        );
        try {
          const driftResult = await this.driftStage.run(userId, dryRun);
          await this.tracker.completeStage(driftRecord.id, 0, driftStart);
          stageDetails.drift = driftResult;
          this.log('Stage 3.6 complete', driftResult);
        } catch (err) {
          await this.tracker.errorStage(
            driftRecord.id,
            err as Error,
            driftStart,
          );
          const msg = `Drift stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 3.7: Trust profile recalculation
      if (this.trustProfileService) {
        this.log('Stage 3.7: Trust profile recalculation');
        const trustStart = new Date();
        const trustRecord = await this.tracker.startStage(
          runId,
          'trust',
          totalMemories,
        );
        try {
          const trustResult =
            await this.trustProfileService.recalculateAllProfiles();
          await this.tracker.completeStage(trustRecord.id, 0, trustStart);
          stageDetails.trustUpdate = trustResult;
          this.log('Stage 3.7 complete', trustResult);
        } catch (err) {
          await this.tracker.errorStage(
            trustRecord.id,
            err as Error,
            trustStart,
          );
          const msg = `Trust update stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 3.8: Identity consolidation (HEY-176)
      if (stages.includes('identity') && llmCallsUsed < this.maxLlmCalls) {
        this.log('Stage 3.8: Identity consolidation');
        try {
          const identityResult = await this.identityStage.run(
            userId,
            dryRun,
            this.maxLlmCalls - llmCallsUsed,
            report.id,
          );
          llmCallsUsed += identityResult.llmCalls;
          stageDetails.identity = identityResult;
          this.log('Stage 3.8 complete', identityResult);
        } catch (err) {
          const msg = `Identity stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 4: Generate report
      if (stages.includes('report')) {
        this.log('Stage 4: Generating consolidation report');
        const totalActive = await this.prisma.memory.count({
          where: { userId, deletedAt: null },
        });
        const avgResult = await this.prisma.memory.aggregate({
          where: { userId, deletedAt: null },
          _avg: { effectiveScore: true },
        });
        stageDetails.report = {
          totalActive,
          avgEffectiveScore: avgResult._avg.effectiveScore ?? 0,
        };
      }

      // Stage 5: Generate context (optional)
      const generateContextEnabled =
        this.config.get('DREAM_GENERATE_CONTEXT') === 'true';
      const contextWritePath = this.config.get<string>(
        'DREAM_CONTEXT_WRITE_PATH',
      );
      const contextAgentId = this.config.get<string>('DREAM_CONTEXT_AGENT_ID');
      if (
        generateContextEnabled &&
        contextAgentId &&
        this.generateContextService
      ) {
        this.log('Stage 5: Generate context');
        try {
          const contextResult = await this.generateContextService.generate({
            agentId: contextAgentId,
            writePath: contextWritePath,
            dryRun,
          });
          stageDetails.generateContext = {
            memoriesIncluded: contextResult.memoriesIncluded,
            tokenCount: contextResult.tokenCount,
            writtenTo: contextResult.writtenTo,
            latencyMs: contextResult.latencyMs,
          };
          this.log('Stage 5 complete', stageDetails.generateContext);
        } catch (err) {
          const msg = `Generate context stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 6: Fog Index snapshot
      if (this.fogIndexService && !dryRun) {
        this.log('Stage 6: Computing Fog Index snapshot');
        try {
          const fogResult = await this.fogIndexService.snapshot({ userId });
          stageDetails.fogIndex = {
            score: fogResult.score,
            tier: fogResult.tier,
            components: fogResult.components,
          };
          this.log('Stage 6 complete', {
            score: fogResult.score,
            tier: fogResult.tier,
          });
        } catch (err) {
          const msg = `Fog Index stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      const durationMs = Date.now() - startTime;
      const totalActive = stageDetails.report?.totalActive ?? 0;
      const avgEffectiveScore = stageDetails.report?.avgEffectiveScore ?? 0;
      const status = dryRun ? 'DRY_RUN' : 'COMPLETED';

      await this.prisma.dreamCycleReport.update({
        where: { id: report.id },
        data: {
          completedAt: new Date(),
          durationMs,
          scoresRefreshed,
          duplicatesMerged,
          patternsCreated,
          memoriesArchived,
          totalActive,
          avgEffectiveScore,
          stageDetails,
          errors,
          status: dryRun ? 'DRY_RUN' : 'COMPLETED',
        },
      });

      await this.prisma.consolidationJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          memoriesProcessed:
            scoresRefreshed +
            duplicatesMerged +
            memoriesArchived +
            pendingResolved,
          patternsDetected: patternsCreated,
          memoriesMerged: duplicatesMerged,
        },
      });

      this.log('Dream Cycle complete', {
        durationMs,
        scoresRefreshed,
        duplicatesMerged,
        patternsCreated,
        memoriesArchived,
        pendingResolved,
        errors: errors.length,
      });

      this.emitSafe(
        'dream.completed',
        new DreamCompletedEvent(
          duplicatesMerged,
          memoriesArchived,
          patternsCreated,
          durationMs,
        ),
      );

      if (this.healthMetrics && status === 'COMPLETED') {
        try {
          await this.healthMetrics.computeAndPersist();
          this.logger.log('Health metrics refreshed after Dream Cycle');
        } catch (err) {
          this.logger.warn(
            `Health metrics refresh failed: ${(err as Error).message}`,
          );
        }
      }

      return {
        id: report.id,
        status,
        durationMs,
        scoresRefreshed,
        duplicatesMerged,
        patternsCreated,
        memoriesArchived,
        pendingResolved,
        totalActive,
        avgEffectiveScore,
        stageDetails,
        errors,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.prisma.dreamCycleReport.update({
        where: { id: report.id },
        data: {
          status: 'FAILED',
          errors: [...errors, msg],
          completedAt: new Date(),
        },
      });
      await this.prisma.consolidationJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: msg, completedAt: new Date() },
      });
      throw err;
    }
  }

  private emitSafe(eventName: string, payload: any): void {
    try {
      this.eventEmitter?.emit(eventName, payload);
    } catch (err) {
      this.log(`Failed to emit ${eventName}: ${err}`, undefined, 'error');
    }
  }

  private log(
    message: string,
    data?: any,
    level: 'log' | 'error' = 'log',
  ): void {
    const msg = data ? `${message} ${JSON.stringify(data)}` : message;
    if (level === 'error') {
      this.logger.error(msg);
    } else {
      this.logger.log(msg);
    }
  }
}
