import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { AwarenessConfig } from './config/awareness.config';
import { MemorySignalService } from './signals/memory-signal.service';
import { GitHubSignalService } from './signals/github-signal.service';
import { LinearSignalService } from './signals/linear-signal.service';
import { PatternDetectorService } from './analysis/pattern-detector.service';
import {
  InsightGeneratorService,
  GeneratedInsight,
} from './analysis/insight-generator.service';
import { BehavioralConsistencyService } from './analysis/behavioral-consistency.service';
import { ProactiveNotificationService } from './proactive-notification.service';
import { InsightFeedbackService } from './insight-feedback.service';
import { Observation } from './signals/signal.interface';
import { EmbeddingService } from '../memory/embedding.service';
import { ImportanceHint } from '@prisma/client';

const INSIGHT_DEDUP_THRESHOLD = 0.85;

/**
 * Waking Cycle — the core orchestrator for the Awareness module.
 *
 * Runs on a configurable schedule and:
 * 1. Collects observations from signal sources
 * 2. Detects patterns across observations + existing memories
 * 3. Generates insights (INSIGHT layer memories)
 * 4. Stores them via the standard memory pipeline
 *
 * Supports multi-tenant operation: cycles can be scoped per accountId.
 * The scheduled entry point iterates all accounts automatically.
 *
 * HEY-136: Enhanced with full metadata storage for insights
 * HEY-151: Integrates feedback loop for confidence adjustment
 * HEY-154: Triggers proactive notifications for high-confidence insights
 *
 * Respects resource budgets and can be fully disabled via config.
 */
@Injectable()
export class WakingCycleService {
  private readonly logger = new Logger(WakingCycleService.name);
  private running = false;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly memoryService: MemoryService,
    private readonly memorySignal: MemorySignalService,
    private readonly githubSignal: GitHubSignalService,
    private readonly linearSignal: LinearSignalService,
    private readonly patternDetector: PatternDetectorService,
    private readonly insightGenerator: InsightGeneratorService,
    private readonly behavioralConsistency: BehavioralConsistencyService,
    @Optional()
    private readonly proactiveNotification?: ProactiveNotificationService,
    @Optional() private readonly insightFeedback?: InsightFeedbackService,
    @Optional() private readonly embeddingService?: EmbeddingService,
  ) {}

  /**
   * Scheduled entry point. Runs a cycle for each account.
   */
  @Cron(AwarenessConfig.schedule)
  async runScheduled(): Promise<void> {
    if (!AwarenessConfig.enabled) return;

    // Multi-tenant: run a cycle for each account
    const accounts = await this.prisma.account.findMany({
      select: { id: true },
    });
    for (const account of accounts) {
      await this.runCycle(account.id);
    }
  }

  /**
   * Run a single Waking Cycle. Can be called manually for testing.
   * @param accountId — scope cycle to a specific account (multi-tenant).
   *   If omitted, falls back to first account (legacy single-tenant).
   */
  async runCycle(accountId?: string): Promise<{
    observations: number;
    patterns: number;
    insights: number;
    durationMs: number;
  }> {
    if (this.running) {
      this.logger.warn('Waking Cycle already running — skipping');
      return { observations: 0, patterns: 0, insights: 0, durationMs: 0 };
    }

    this.running = true;
    const startTime = Date.now();
    const instanceId =
      process.env.HOSTNAME || process.env.RAILWAY_REPLICA_ID || 'local';

    // HEY-335: Persist cycle run in DB
    const cycleRun = await this.prisma.awarenessCycleRun.create({
      data: { status: 'RUNNING', phase: 'starting', instanceId },
    });

    try {
      this.logger.log('Waking Cycle starting...');

      // Apply timeout
      const result = await Promise.race([
        this._execute(accountId),
        this.timeout(AwarenessConfig.cycleTimeoutMs),
      ]);
      this.clearTimeout();

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `Waking Cycle complete: ${result.observations} observations, ` +
          `${result.patterns} patterns, ${result.insights} insights ` +
          `(${durationMs}ms)`,
      );

      // HEY-335: Update cycle run with results
      await this.prisma.awarenessCycleRun.update({
        where: { id: cycleRun.id },
        data: {
          status: 'COMPLETED',
          phase: 'idle',
          endTime: new Date(),
          insightsGenerated: result.insights,
          observations: result.observations,
          patterns: result.patterns,
          durationMs,
        },
      });

      return { ...result, durationMs };
    } catch (error) {
      this.clearTimeout();
      this.logger.error(`Waking Cycle failed: ${error.message}`, error.stack);

      // HEY-335: Record failure
      await this.prisma.awarenessCycleRun
        .update({
          where: { id: cycleRun.id },
          data: {
            status: 'FAILED',
            phase: 'failed',
            endTime: new Date(),
            durationMs: Date.now() - startTime,
            error: error.message,
          },
        })
        .catch(() => {});

      return {
        observations: 0,
        patterns: 0,
        insights: 0,
        durationMs: Date.now() - startTime,
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Execute the full cycle pipeline: collect → detect → generate → store.
   * @param accountId — if provided, scope to this account; otherwise use first account (legacy).
   */
  private async _execute(accountId?: string): Promise<{
    observations: number;
    patterns: number;
    insights: number;
  }> {
    // ── 0. Resolve account ────────────────────────────────────────────
    const resolvedAccountId =
      accountId ?? (await this.prisma.account.findFirst())?.id;
    if (!resolvedAccountId) {
      this.logger.warn('No account found — cannot run waking cycle');
      return { observations: 0, patterns: 0, insights: 0 };
    }

    // ── 1. Load checkpoints ───────────────────────────────────────────
    const checkpoints = await this.loadCheckpoints(resolvedAccountId);

    // ── 2. Collect signals ────────────────────────────────────────────
    const allObservations: Observation[] = [];

    const memoryResult = await this.memorySignal.collect(
      checkpoints.get('memory') || null,
      { maxQueries: Math.floor(AwarenessConfig.maxDbQueries * 0.6) },
    );
    allObservations.push(...memoryResult.observations);
    await this.saveCheckpoint(
      resolvedAccountId,
      'memory',
      memoryResult.checkpoint,
    );

    const githubResult = await this.githubSignal.collect(
      checkpoints.get('github') || null,
      { maxQueries: Math.floor(AwarenessConfig.maxDbQueries * 0.15) }, // 15% budget to GitHub
    );
    allObservations.push(...githubResult.observations);
    await this.saveCheckpoint(
      resolvedAccountId,
      'github',
      githubResult.checkpoint,
    );

    // Linear signal (optional — collects if configured)
    const linearResult = await this.linearSignal.collect(
      checkpoints.get('linear') || null,
      { maxQueries: Math.floor(AwarenessConfig.maxDbQueries * 0.15) }, // 15% budget to Linear
    );
    allObservations.push(...linearResult.observations);
    await this.saveCheckpoint(
      resolvedAccountId,
      'linear',
      linearResult.checkpoint,
    );

    // ── 3. Detect patterns ────────────────────────────────────────────
    const patterns = this.patternDetector.detect(allObservations);

    // ── 4. Generate insights ──────────────────────────────────────────
    const insights = await this.insightGenerator.generate(patterns, {
      maxLlmCalls: AwarenessConfig.maxLlmCalls,
      maxInsights: AwarenessConfig.maxInsightsPerCycle,
    });

    // ── 5. Behavioral consistency check (HEY-175) ──────────────────
    // FIX: Skip if a consistency:pattern_break insight was stored in the last 24h
    try {
      const user = await this.prisma.user.findFirst();
      if (user) {
        const recentConsistencyInsight = await this.prisma.memory.findFirst({
          where: {
            userId: user.id,
            layer: 'INSIGHT',
            deletedAt: null,
            raw: { startsWith: '[Behavioral Consistency]' },
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
          select: { id: true },
        });

        if (recentConsistencyInsight) {
          this.logger.debug(
            '[Awareness] Skipping behavioral consistency — recent insight exists (7-day cooldown)',
          );
        } else {
          const consistencyResult = await this.behavioralConsistency.check(
            user.id,
            { maxLlmCalls: Math.max(0, AwarenessConfig.maxLlmCalls - 1) },
          );
          for (const inconsistency of consistencyResult.inconsistencies) {
            insights.push({
              content:
                `[Behavioral Consistency] ${inconsistency.description}` +
                (inconsistency.suggestion
                  ? ` — Suggestion: ${inconsistency.suggestion}`
                  : ''),
              insightType: `consistency:${inconsistency.type}`,
              confidence: inconsistency.confidence,
              sourceMemoryIds: inconsistency.evidenceMemoryIds,
              signalSource: 'behavioral_consistency',
              actionable: inconsistency.severity !== 'low',
            });
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Behavioral consistency check failed: ${error.message}`);
    }

    // ── 6. Store insights as INSIGHT layer memories ───────────────────
    await this.storeInsights(resolvedAccountId, insights);

    return {
      observations: allObservations.length,
      patterns: patterns.length,
      insights: insights.length,
    };
  }

  /** Load signal source checkpoints for a specific account. */
  private async loadCheckpoints(
    accountId: string,
  ): Promise<Map<string, Record<string, unknown>>> {
    const states = await this.prisma.awarenessState.findMany({
      where: { accountId },
    });
    const map = new Map<string, Record<string, unknown>>();
    for (const state of states) {
      map.set(
        state.signalSource,
        (state.checkpoint as Record<string, unknown>) || {},
      );
    }
    return map;
  }

  /** Persist a signal source checkpoint via upsert, scoped to account. */
  private async saveCheckpoint(
    accountId: string,
    signalSource: string,
    checkpoint: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.awarenessState.upsert({
      where: {
        accountId_signalSource: {
          accountId,
          signalSource,
        },
      },
      update: {
        lastCheckedAt: new Date(),
        checkpoint: checkpoint as any,
      },
      create: {
        accountId,
        signalSource,
        lastCheckedAt: new Date(),
        checkpoint: checkpoint as any,
      },
    });
  }

  /**
   * Store generated insights as INSIGHT layer memories.
   *
   * HEY-136: Stores full insight metadata (type, sources, actionable, etc.)
   * HEY-151: Adjusts confidence based on feedback history for similar insight types
   * HEY-154: Triggers proactive notifications for high-confidence actionable insights
   */
  private async storeInsights(
    accountId: string,
    insights: GeneratedInsight[],
  ): Promise<void> {
    if (insights.length === 0) return;

    // Find the first user belonging to this account
    const user = await this.prisma.user.findFirst({
      where: { accountId },
    });
    if (!user) {
      this.logger.warn(
        `No user found for account ${accountId} — cannot store insights`,
      );
      return;
    }

    for (const insight of insights) {
      try {
        // Global 7-day dedup: check if an INSIGHT with same insightType exists recently
        const recentSameType = await this.prisma.memory.findFirst({
          where: {
            userId: user.id,
            layer: 'INSIGHT',
            deletedAt: null,
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            metadata: { path: ['insightType'], equals: insight.insightType },
          },
          select: { id: true },
        });

        if (recentSameType) {
          this.logger.debug(
            `Skipping insight (7-day type dedup): "${insight.content.slice(0, 60)}..." [${insight.insightType}]`,
          );
          continue;
        }

        // HEY-336: Deduplicate insights using cosine similarity (fallback)
        if (this.embeddingService) {
          try {
            const isDuplicate = await this.isDuplicateInsight(
              user.id,
              insight.content,
            );
            if (isDuplicate) {
              this.logger.log(
                `Skipping duplicate insight: "${insight.content.slice(0, 60)}..."`,
              );
              continue;
            }
          } catch (e) {
            this.logger.debug(`Dedup check failed, proceeding: ${e.message}`);
          }
        }

        // HEY-151: Adjust confidence based on feedback history
        let adjustedConfidence = insight.confidence;
        if (this.insightFeedback) {
          try {
            const stats = await this.insightFeedback.getFeedbackStats(
              user.id,
              insight.insightType,
            );
            if (stats.totalFeedback > 0) {
              adjustedConfidence = Math.max(
                0,
                Math.min(1, insight.confidence + stats.avgConfidenceAdjustment),
              );
            }
          } catch (e) {
            this.logger.debug(`Feedback stats lookup failed: ${e.message}`);
          }
        }

        const stored = await this.memoryService.remember(user.id, {
          raw: insight.content,
          layer: 'INSIGHT',
          importanceHint:
            adjustedConfidence > 0.7
              ? ImportanceHint.HIGH
              : ImportanceHint.MEDIUM,
          source: 'PATTERN_DETECTED',
        });

        // HEY-136: Store full insight metadata
        await this.prisma.memory.update({
          where: { id: stored.id },
          data: {
            confidence: adjustedConfidence,
            metadata: {
              insightType: insight.insightType,
              confidence: adjustedConfidence,
              sourceMemoryIds: insight.sourceMemoryIds,
              signalSource: insight.signalSource,
              actionable: insight.actionable,
              acknowledged: false,
              expiresAt: new Date(
                Date.now() +
                  AwarenessConfig.insightTtlDays * 24 * 60 * 60 * 1000,
              ).toISOString(),
            },
          },
        });

        this.logger.log(
          `Stored insight: "${insight.content.slice(0, 80)}..." (confidence: ${adjustedConfidence.toFixed(2)})`,
        );
      } catch (error) {
        this.logger.debug(`Insight storage skipped/failed: ${error.message}`);
      }
    }

    // HEY-154: Trigger proactive notifications
    if (this.proactiveNotification) {
      try {
        const account = await this.prisma.account.findFirst();
        if (account) {
          await this.proactiveNotification.checkAndNotify(account.id);
        }
      } catch (error) {
        this.logger.warn(
          `Proactive notification check failed: ${error.message}`,
        );
      }
    }
  }

  /**
   * HEY-336: Check if a similar insight already exists (cosine similarity > threshold).
   * Compares against INSIGHT layer memories from the last 7 days.
   */
  private async isDuplicateInsight(
    userId: string,
    content: string,
  ): Promise<boolean> {
    if (!this.embeddingService) return false;

    const queryEmbedding = await this.embeddingService.generate(content);
    const results = await this.embeddingService.search(
      userId,
      queryEmbedding,
      5,
      ['INSIGHT' as any],
    );

    // Check if any recent insight exceeds the dedup threshold
    for (const result of results) {
      if (result.score >= INSIGHT_DEDUP_THRESHOLD) {
        // Verify it's from the last 14 days (matches insightTtlDays)
        const memory = await this.prisma.memory.findUnique({
          where: { id: result.id },
          select: { createdAt: true, deletedAt: true },
        });
        if (memory && !memory.deletedAt) {
          const cutoff = new Date(
            Date.now() - AwarenessConfig.insightTtlDays * 24 * 60 * 60 * 1000,
          );
          if (memory.createdAt >= cutoff) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * HEY-335: Get the last cycle run from DB for the status endpoint.
   */
  async getLastCycleRun(): Promise<{
    phase: string;
    lastRunAt: string | null;
    insightsGenerated: number;
    duration: number;
    observations: number;
    patterns: number;
  }> {
    const lastRun = await this.prisma.awarenessCycleRun.findFirst({
      orderBy: { startTime: 'desc' },
    });

    if (!lastRun) {
      return {
        phase: 'idle',
        lastRunAt: null,
        insightsGenerated: 0,
        duration: 0,
        observations: 0,
        patterns: 0,
      };
    }

    return {
      phase:
        lastRun.status === 'RUNNING'
          ? lastRun.phase || 'running'
          : lastRun.status === 'COMPLETED'
            ? 'idle'
            : 'failed',
      lastRunAt:
        lastRun.status === 'COMPLETED'
          ? (lastRun.endTime?.toISOString() ?? lastRun.startTime.toISOString())
          : lastRun.startTime.toISOString(),
      insightsGenerated: lastRun.insightsGenerated,
      duration: lastRun.durationMs,
      observations: lastRun.observations,
      patterns: lastRun.patterns,
    };
  }

  /** Returns a promise that rejects after `ms` milliseconds (cycle timeout). */
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      this.timeoutHandle = setTimeout(
        () => reject(new Error(`Waking Cycle timed out after ${ms}ms`)),
        ms,
      );
    });
  }

  /** Clear the cycle timeout to prevent timer leaks. */
  private clearTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
