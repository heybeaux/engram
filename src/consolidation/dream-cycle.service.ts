import { Injectable, Optional, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DreamStartedEvent, DreamCompletedEvent } from '../events/event-types';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { TrustProfileService } from '../identity/trust-profile.service';
import { GenerateContextService } from './generate-context.service';
import { ClusteringService } from '../clustering/clustering.service';
import { FogIndexService } from '../fog-index/fog-index.service';
import {
  DreamCycleDedupStage,
  DreamCycleStalenessStage,
  DreamCyclePatternsStage,
  DreamCycleDriftStage,
  DreamCycleIdentityStage,
  DreamCyclePendingStage,
  DreamCycleTieringStage,
  DreamCycleConsolidationStage,
} from './stages';
import * as os from 'os';

// Advisory lock key for Dream Cycle (arbitrary unique int)
const DREAM_CYCLE_LOCK_KEY = 294967;

export type DreamCycleStage =
  | 'dedup'
  | 'staleness'
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
  'dedup',
  'staleness',
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
    private prisma: PrismaService,
    private config: ConfigService,
    private dedupStage: DreamCycleDedupStage,
    private stalenessStage: DreamCycleStalenessStage,
    private pendingStage: DreamCyclePendingStage,
    private tieringStage: DreamCycleTieringStage,
    private consolidationStage: DreamCycleConsolidationStage,
    private patternsStage: DreamCyclePatternsStage,
    private driftStage: DreamCycleDriftStage,
    private identityStage: DreamCycleIdentityStage,
    @Optional() private generateContextService?: GenerateContextService,
    @Optional() private clusteringService?: ClusteringService,
    @Optional() private fogIndexService?: FogIndexService,
    @Optional() private trustProfileService?: TrustProfileService,
    @Optional() private eventEmitter?: EventEmitter2,
  ) {
    this.maxLlmCalls = parseInt(
      this.config.get('DREAM_MAX_LLM_CALLS') ?? '50',
      10,
    );
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

  private async runInternal(
    options: DreamCycleOptions = {},
  ): Promise<DreamCycleResult> {
    // Auto-discover users if no userId specified and no DEFAULT_USER_ID configured
    if (!options.userId && !this.config.get('DEFAULT_USER_ID')) {
      this.log(
        'No userId or DEFAULT_USER_ID configured — auto-discovering users',
      );
      const users = await this.prisma.memory.findMany({
        where: { deletedAt: null },
        select: { userId: true },
        distinct: ['userId'],
      });

      if (users.length === 0) {
        throw new Error('No users found with active memories');
      }

      this.log(`Found ${users.length} distinct users`, {
        userIds: users.map((u) => u.userId),
      });

      const allResults: DreamCycleResult[] = [];
      for (const user of users) {
        this.log(`Running Dream Cycle for user: ${user.userId}`);
        const result = await this.runInternal({
          ...options,
          userId: user.userId,
        });
        allResults.push(result);
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
      // Stage 1: Semantic dedup
      if (stages.includes('dedup')) {
        this.log('Stage 1: Semantic dedup scan');
        try {
          const dedupResult = await this.dedupStage.run(
            userId,
            dryRun,
            maxMemories,
          );
          duplicatesMerged = dedupResult.merged;
          llmCallsUsed += dedupResult.llmCalls;
          stageDetails.dedup = dedupResult;
          this.log('Stage 1 complete', dedupResult);
        } catch (err) {
          const msg = `Dedup stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 2: Staleness pruning
      if (stages.includes('staleness')) {
        this.log('Stage 2: Staleness pruning');
        try {
          const pruneResult = await this.stalenessStage.run(userId, dryRun);
          memoriesArchived = pruneResult.archived;
          scoresRefreshed = pruneResult.scoresRefreshed;
          stageDetails.staleness = pruneResult;
          this.log('Stage 2 complete', pruneResult);
        } catch (err) {
          const msg = `Staleness stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 2.5: PENDING merge resolution
      if (stages.includes('pending') && llmCallsUsed < this.maxLlmCalls) {
        this.log('Stage 2.5: PENDING merge resolution');
        try {
          const pendingResult = await this.pendingStage.run(
            userId,
            dryRun,
            this.maxLlmCalls - llmCallsUsed,
          );
          pendingResolved = pendingResult.processed;
          duplicatesMerged +=
            pendingResult.autoMerged + pendingResult.llmMerged;
          llmCallsUsed += pendingResult.llmCalls;
          stageDetails.pending = pendingResult;
          this.log('Stage 2.5 complete', pendingResult);
        } catch (err) {
          const msg = `Pending stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 2.6: Memory tiering
      if (stages.includes('tiering')) {
        this.log('Stage 2.6: Memory tiering');
        try {
          const tieringResult = await this.tieringStage.run(userId, dryRun);
          stageDetails.tiering = tieringResult;
          this.log('Stage 2.6 complete', tieringResult);
        } catch (err) {
          const msg = `Tiering stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 2.7: Cold memory consolidation (Dream v2)
      if (stages.includes('tiering')) {
        this.log('Stage 2.7: Cold memory consolidation');
        try {
          const consolidationResult = await this.consolidationStage.run(
            userId,
            dryRun,
          );
          llmCallsUsed += consolidationResult.llmCalls;
          memoriesArchived += consolidationResult.archived;
          stageDetails.consolidation = consolidationResult;
          this.log('Stage 2.7 complete', consolidationResult);
        } catch (err) {
          const msg = `Consolidation stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 3: Pattern extraction
      if (stages.includes('patterns') && llmCallsUsed < this.maxLlmCalls) {
        this.log('Stage 3: Pattern extraction');
        try {
          const patternResult = await this.patternsStage.run(
            userId,
            dryRun,
            this.maxLlmCalls - llmCallsUsed,
          );
          patternsCreated = patternResult.patternsCreated;
          llmCallsUsed += patternResult.llmCalls;
          stageDetails.patterns = patternResult;
          this.log('Stage 3 complete', patternResult);
        } catch (err) {
          const msg = `Pattern stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 3.5: Memory clustering
      if (stages.includes('clustering') && this.clusteringService) {
        this.log('Stage 3.5: Memory clustering');
        try {
          const clusterResult = await this.clusteringService.run({
            userId,
            dryRun,
          });
          stageDetails.clustering = clusterResult;
          this.log('Stage 3.5 (clustering) complete', clusterResult);
        } catch (err) {
          const msg = `Clustering stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 3.6: Drift analysis
      if (stages.includes('drift')) {
        this.log('Stage 3.6: Embedding drift analysis');
        try {
          const driftResult = await this.driftStage.run(userId, dryRun);
          stageDetails.drift = driftResult;
          this.log('Stage 3.6 complete', driftResult);
        } catch (err) {
          const msg = `Drift stage failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          this.log(msg, undefined, 'error');
        }
      }

      // Stage 3.7: Trust profile recalculation
      if (this.trustProfileService) {
        this.log('Stage 3.7: Trust profile recalculation');
        try {
          const trustResult =
            await this.trustProfileService.recalculateAllProfiles();
          stageDetails.trustUpdate = trustResult;
          this.log('Stage 3.7 complete', trustResult);
        } catch (err) {
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
