import {
  Injectable,
  Optional,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import {
  MemoryMergedEvent,
  DedupClusterFoundEvent,
} from '../events/event-types';
import { PrismaService } from '../prisma/prisma.service';
import {
  SimilarityService,
  MemoryCluster,
  PairwiseSimilarity,
} from './similarity.service';
import {
  SafetyService,
  SafetyConfig,
  DEFAULT_SAFETY_CONFIG,
} from './safety.service';
import { MergeService, MergeResult } from './merge.service';
import { LineageService } from './lineage.service';
import { ReviewService } from './review.service';
import {
  MergeStrategy,
  BatchJobStatus,
  ScanResponseDto,
  StatsResponseDto,
  ConfigResponseDto,
  ManualMergeDto,
  MergeResponseDto,
  RollbackResponseDto,
  UpdateConfigDto,
  SimilarMemoryDto,
} from './dto/deduplication.dto';
import { randomUUID } from 'crypto';

const REDIS_JOB_PREFIX = 'engram:dedup:job:';
const REDIS_CURRENT_JOB_KEY = 'engram:dedup:currentJob';
const JOB_TTL_SECONDS = 604_800; // 7 days

/**
 * Deduplication configuration
 */
interface DedupConfig {
  autoMergeThreshold: number;
  reviewSuggestThreshold: number;
  autoResolveThreshold: number;
  defaultStrategy: MergeStrategy;
  batchEnabled: boolean;
  incrementalEnabled: boolean;
  incrementalAutoMerge: boolean;
}

/**
 * Batch job state
 */
interface BatchJob {
  id: string;
  status: BatchJobStatus;
  userId: string;
  memoriesProcessed: number;
  clustersFound: number;
  autoMerged: number;
  queuedForReview: number;
  skipped: number;
  errors: string[];
  startedAt: Date;
  completedAt?: Date;
  dryRun: boolean;
}

/**
 * Deduplication Service
 *
 * Main orchestrator for memory deduplication.
 * Coordinates incremental and batch deduplication.
 */
@Injectable()
export class DeduplicationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeduplicationService.name);
  private config: DedupConfig;
  private safetyConfig: SafetyConfig;
  private jobs: Map<string, BatchJob> = new Map();
  private currentJob: string | null = null;
  private redis: Redis | null = null;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private similarity: SimilarityService,
    private safety: SafetyService,
    private merge: MergeService,
    private lineage: LineageService,
    private review: ReviewService,
    @Optional() private eventEmitter?: EventEmitter2,
  ) {
    this.config = {
      autoMergeThreshold: 0.88,
      reviewSuggestThreshold: 0.8,
      autoResolveThreshold: 0.82,
      defaultStrategy: MergeStrategy.KEEP_DETAILED,
      batchEnabled: true,
      incrementalEnabled: true,
      incrementalAutoMerge: true,
    };
    this.safetyConfig = { ...DEFAULT_SAFETY_CONFIG };

    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (redisUrl && redisUrl.startsWith('redis')) {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      this.redis.connect().catch((err) => {
        this.logger.warn(
          `[DeduplicationService] Redis connect failed, falling back to in-memory: ${err.message}`,
        );
        this.redis = null;
      });
    }
  }

  async onModuleInit(): Promise<void> {
    await this.restoreAndRecoverJobs();
  }

  onModuleDestroy(): void {
    const runningJobs = Array.from(this.jobs.values()).filter(
      (j) => j.status === BatchJobStatus.RUNNING,
    );
    if (runningJobs.length > 0) {
      this.logger.warn(
        `Shutting down with ${runningJobs.length} deduplication job(s) still in progress: ${runningJobs.map((j) => j.id).join(', ')}`,
      );
      for (const job of runningJobs) {
        job.status = BatchJobStatus.FAILED;
        job.completedAt = new Date();
        job.errors.push('Interrupted by server shutdown');
        this.persistJob(job).catch(() => {});
      }
    }
  }

  /**
   * Resolve a userId to an internal CUID.
   */
  private async resolveUserId(userId: string): Promise<string> {
    if (!userId) return userId;
    if (userId.startsWith('cm')) return userId;
    const user = await this.prisma.user.findFirst({
      where: { externalId: userId, deletedAt: null },
      select: { id: true },
    });
    return user?.id ?? userId;
  }

  /**
   * Resolve all internal CUIDs for a given userId, including deleted users
   * with the same externalId. This ensures stats/queries find data created
   * under previous user records (e.g., after agent migration).
   */
  private async resolveAllUserIds(userId: string): Promise<string[]> {
    let externalId: string | null;
    if (userId.startsWith('cm')) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { externalId: true },
      });
      externalId = user?.externalId ?? null;
    } else {
      externalId = userId;
    }
    if (!externalId) return [userId];
    const users = await this.prisma.user.findMany({
      where: { externalId },
      select: { id: true },
    });
    return users.length > 0 ? users.map((u) => u.id) : [userId];
  }

  /**
   * Check if deduplication is enabled
   */
  isEnabled(): boolean {
    const enabled = this.configService.get<string>('DEDUP_ENABLED');
    return enabled === 'true' || enabled === '1';
  }

  /**
   * Check for duplicates when a new memory is created (incremental)
   */
  async checkForDuplicates(
    memoryId: string,
    userId: string,
    content: string,
  ): Promise<{
    action: 'none' | 'auto_merged' | 'queued_for_review';
    details?: any;
  }> {
    if (!this.isEnabled() || !this.config.incrementalEnabled) {
      return { action: 'none' };
    }

    try {
      // Find similar memories
      const similar = await this.similarity.findSimilarForContent(
        content,
        userId,
        {
          topK: 5,
          minSimilarity: this.config.reviewSuggestThreshold,
          excludeIds: [memoryId],
        },
      );

      if (similar.length === 0) {
        return { action: 'none' };
      }

      const topMatch = similar[0];

      // Check if this pair was previously rejected
      const wasRejected = await this.review.wasRejected(
        memoryId,
        topMatch.memoryId,
      );
      if (wasRejected) {
        return { action: 'none' };
      }

      // Check safety
      const { canAutoMerge, reasons } = await this.safety.canAutoMergePair(
        memoryId,
        topMatch.memoryId,
      );

      if (!canAutoMerge || !this.config.incrementalAutoMerge) {
        // Queue for review
        await this.review.queuePairForReview(
          userId,
          memoryId,
          topMatch.memoryId,
          topMatch.similarity,
        );
        return {
          action: 'queued_for_review',
          details: { similarity: topMatch.similarity, reasons },
        };
      }

      // Auto-merge if above auto-resolve threshold (covers both high and medium confidence)
      if (topMatch.similarity >= this.config.autoResolveThreshold) {
        const result = await this.executeMerge(
          userId,
          [memoryId, topMatch.memoryId],
          this.config.defaultStrategy,
          'auto',
          topMatch.similarity,
        );

        return {
          action: 'auto_merged',
          details: {
            survivorId: result.survivorId,
            absorbedIds: result.absorbedIds,
            similarity: topMatch.similarity,
          },
        };
      }

      // Below auto-resolve but above suggest threshold — still auto-merge, pick best candidate
      if (topMatch.similarity >= this.config.reviewSuggestThreshold) {
        const result = await this.executeMerge(
          userId,
          [memoryId, topMatch.memoryId],
          this.config.defaultStrategy,
          'auto',
          topMatch.similarity,
        );

        return {
          action: 'auto_merged',
          details: {
            survivorId: result.survivorId,
            absorbedIds: result.absorbedIds,
            similarity: topMatch.similarity,
          },
        };
      }

      return { action: 'none' };
    } catch (error) {
      this.logger.error(
        `[DeduplicationService] Error checking duplicates:`,
        error,
      );
      return { action: 'none' };
    }
  }

  /**
   * Run batch deduplication scan
   */
  async runBatchDedup(
    userId: string,
    options: {
      dryRun?: boolean;
      minSimilarity?: number;
      maxMemories?: number;
    } = {},
  ): Promise<ScanResponseDto> {
    if (!this.isEnabled()) {
      throw new Error('Deduplication is disabled');
    }

    // Prevent concurrent jobs
    if (this.currentJob) {
      const current = this.jobs.get(this.currentJob);
      if (current && current.status === BatchJobStatus.RUNNING) {
        throw new Error(`A batch job is already running: ${this.currentJob}`);
      }
    }

    userId = await this.resolveUserId(userId);

    const {
      dryRun = false,
      minSimilarity = this.config.reviewSuggestThreshold,
      maxMemories = 5000,
    } = options;

    // Create job
    const jobId = randomUUID();
    const job: BatchJob = {
      id: jobId,
      status: BatchJobStatus.RUNNING,
      userId,
      memoriesProcessed: 0,
      clustersFound: 0,
      autoMerged: 0,
      queuedForReview: 0,
      skipped: 0,
      errors: [],
      startedAt: new Date(),
      dryRun,
    };

    this.jobs.set(jobId, job);
    this.currentJob = jobId;
    this.persistJob(job).catch(() => {});
    this.persistCurrentJob(jobId).catch(() => {});

    try {
      // Load user-specific config (auto-resolve threshold, etc.)
      const userConfig = await this.getConfig(userId);
      this.config.autoResolveThreshold = userConfig.autoResolveThreshold;
      this.config.autoMergeThreshold = userConfig.autoMergeThreshold;

      this.logger.log(
        `[DeduplicationService] Starting batch job ${jobId} for user ${userId}` +
          ` (autoResolve=${this.config.autoResolveThreshold}, autoMerge=${this.config.autoMergeThreshold})`,
      );

      // Compute pairwise similarities
      const pairs = await this.similarity.computePairwiseSimilarity(userId, {
        minSimilarity,
        maxMemories,
      });

      job.memoriesProcessed = maxMemories; // Approximation

      // Cluster similar memories
      const clusters = this.similarity.clusterSimilarMemories(
        pairs,
        minSimilarity,
      );
      job.clustersFound = clusters.length;

      this.logger.log(
        `[DeduplicationService] Found ${clusters.length} clusters`,
      );

      // Emit cluster found events
      for (const cluster of clusters) {
        try {
          this.eventEmitter?.emit(
            'dedup.cluster_found',
            new DedupClusterFoundEvent(
              cluster.id,
              cluster.memoryIds,
              cluster.avgSimilarity,
            ),
          );
        } catch {
          // fire-and-forget
        }
      }

      // Process each cluster
      for (const cluster of clusters) {
        try {
          await this.processCluster(userId, cluster, job, dryRun);
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          job.errors.push(`Cluster ${cluster.id}: ${errorMsg}`);
          this.logger.error(
            `[DeduplicationService] Error processing cluster:`,
            error,
          );
        }
      }

      job.status = BatchJobStatus.COMPLETED;
      job.completedAt = new Date();
      await this.persistJob(job);

      this.logger.log(
        `[DeduplicationService] Batch job ${jobId} completed: ` +
          `${job.autoMerged} auto-merged (incl. auto-resolved), ${job.queuedForReview} queued for review`,
      );

      // Record batch run in database
      await this.prisma.dedupBatchRun.create({
        data: {
          userId,
          status: 'completed',
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          memoriesProcessed: job.memoriesProcessed,
          clustersFound: job.clustersFound,
          autoMerged: job.autoMerged,
          queuedForReview: job.queuedForReview,
          skipped: job.skipped,
          errors: job.errors,
          configSnapshot: JSON.stringify({
            minSimilarity,
            maxMemories,
            dryRun,
          }),
        },
      });

      return {
        scanId: jobId,
        status: job.status,
        memoriesProcessed: job.memoriesProcessed,
        clustersFound: job.clustersFound,
        autoMerged: job.autoMerged,
        queuedForReview: job.queuedForReview,
        durationMs: job.completedAt.getTime() - job.startedAt.getTime(),
      };
    } catch (error) {
      job.status = BatchJobStatus.FAILED;
      job.completedAt = new Date();
      job.errors.push(error instanceof Error ? error.message : String(error));
      await this.persistJob(job);

      throw error;
    }
  }

  /**
   * Process a cluster of similar memories
   */
  private async processCluster(
    userId: string,
    cluster: MemoryCluster,
    job: BatchJob,
    dryRun: boolean,
  ): Promise<void> {
    // Check safety for all memories in cluster
    const safetyResults = await this.safety.checkMultipleSafety(
      cluster.memoryIds,
    );
    const hasProtected = safetyResults.some((r) => r.isProtected);
    const canAutoMerge =
      cluster.minSimilarity >= this.config.autoMergeThreshold &&
      safetyResults.every((r) => r.canAutoMerge);

    if (hasProtected) {
      // Skip protected clusters entirely
      job.skipped++;
      return;
    }

    if (dryRun) {
      // Just count what would happen
      if (canAutoMerge) {
        job.autoMerged++;
      } else {
        job.queuedForReview++;
      }
      return;
    }

    if (canAutoMerge) {
      // Auto-merge the cluster
      await this.executeMerge(
        userId,
        cluster.memoryIds,
        this.config.defaultStrategy,
        'batch',
        cluster.avgSimilarity,
      );
      job.autoMerged++;
    } else if (
      this.config.autoResolveThreshold > 0 &&
      cluster.minSimilarity >= this.config.autoResolveThreshold &&
      !hasProtected &&
      safetyResults.every((r) => !r.requiresReview)
    ) {
      // Auto-resolve: high confidence, no safety flags at all
      // Queue then immediately approve (creates audit trail)
      const candidate = await this.review.queueClusterForReview(
        userId,
        cluster,
      );
      await this.review.approve(candidate.id, {}, 'auto-resolve');
      job.autoMerged++;
    } else if (
      !hasProtected &&
      cluster.minSimilarity >= this.config.reviewSuggestThreshold
    ) {
      // Auto-merge medium-confidence clusters that aren't protected
      await this.executeMerge(
        userId,
        cluster.memoryIds,
        this.config.defaultStrategy,
        'batch',
        cluster.avgSimilarity,
      );
      job.autoMerged++;
    } else {
      // Only queue for review if protected or very low similarity
      await this.review.queueClusterForReview(userId, cluster);
      job.queuedForReview++;
    }
  }

  /**
   * Execute a merge operation
   */
  private async executeMerge(
    userId: string,
    memoryIds: string[],
    strategy: MergeStrategy,
    trigger: 'auto' | 'batch' | 'manual',
    similarity: number,
    approvedBy?: string,
  ): Promise<MergeResult> {
    const result = await this.merge.merge(memoryIds, strategy);
    await this.lineage.recordMerge(
      userId,
      result,
      trigger,
      similarity,
      approvedBy,
    );

    try {
      this.eventEmitter?.emit(
        'memory.merged',
        new MemoryMergedEvent(result.absorbedIds, result.survivorId, userId),
      );
    } catch {
      // fire-and-forget
    }

    return result;
  }

  /**
   * Manually trigger a merge
   */
  async manualMerge(
    dto: ManualMergeDto,
    userId: string,
    approvedBy?: string,
  ): Promise<MergeResponseDto> {
    userId = await this.resolveUserId(userId);
    if (!this.isEnabled()) {
      throw new Error('Deduplication is disabled');
    }

    const result = await this.merge.merge(dto.memoryIds, dto.strategy as any, {
      survivorId: dto.survivorId,
      customContent: dto.customContent,
    });

    const event = await this.lineage.recordMerge(
      userId,
      result,
      'manual',
      1.0,
      approvedBy,
    );

    return {
      success: true,
      mergeEventId: event.id,
      survivorId: result.survivorId,
      absorbedIds: result.absorbedIds,
      mergedContent: result.mergedContent,
    };
  }

  /**
   * Rollback a merge
   */
  async rollback(mergeEventId: string): Promise<RollbackResponseDto> {
    const result = await this.lineage.rollbackMerge(mergeEventId);
    return result;
  }

  /**
   * Get deduplication configuration
   */
  async getConfig(userId: string): Promise<ConfigResponseDto> {
    userId = await this.resolveUserId(userId);
    // Try to get user-specific config from database
    const dbConfig = await this.prisma.dedupConfig.findUnique({
      where: { userId },
    });

    if (dbConfig) {
      return {
        autoMergeThreshold: dbConfig.autoMergeThreshold,
        reviewSuggestThreshold: dbConfig.reviewSuggestThreshold,
        autoResolveThreshold: dbConfig.autoResolveThreshold,
        defaultStrategy: dbConfig.defaultStrategy as MergeStrategy,
        protectedTypes: dbConfig.protectedTypes,
        protectedKeywords: dbConfig.protectedKeywords,
        protectedImportanceThreshold: dbConfig.protectedImportanceThreshold,
        batchEnabled: dbConfig.batchEnabled,
        lastBatchRunAt: dbConfig.lastBatchRunAt ?? undefined,
      };
    }

    // Return defaults
    return {
      autoMergeThreshold: this.config.autoMergeThreshold,
      reviewSuggestThreshold: this.config.reviewSuggestThreshold,
      autoResolveThreshold: this.config.autoResolveThreshold,
      defaultStrategy: this.config.defaultStrategy,
      protectedTypes: this.safetyConfig.protectedTypes,
      protectedKeywords: this.safetyConfig.protectedKeywords,
      protectedImportanceThreshold:
        this.safetyConfig.protectedImportanceThreshold,
      batchEnabled: this.config.batchEnabled,
    };
  }

  /**
   * Update deduplication configuration
   */
  async updateConfig(
    userId: string,
    dto: UpdateConfigDto,
  ): Promise<ConfigResponseDto> {
    userId = await this.resolveUserId(userId);
    const existing = await this.prisma.dedupConfig.findUnique({
      where: { userId },
    });

    const data = {
      autoMergeThreshold:
        dto.autoMergeThreshold ??
        existing?.autoMergeThreshold ??
        this.config.autoMergeThreshold,
      reviewSuggestThreshold:
        dto.reviewSuggestThreshold ??
        existing?.reviewSuggestThreshold ??
        this.config.reviewSuggestThreshold,
      autoResolveThreshold:
        dto.autoResolveThreshold ??
        existing?.autoResolveThreshold ??
        this.config.autoResolveThreshold,
      defaultStrategy:
        dto.defaultStrategy ??
        existing?.defaultStrategy ??
        this.config.defaultStrategy,
      protectedTypes:
        dto.protectedTypes ??
        existing?.protectedTypes ??
        this.safetyConfig.protectedTypes,
      protectedKeywords:
        dto.protectedKeywords ??
        existing?.protectedKeywords ??
        this.safetyConfig.protectedKeywords,
      protectedImportanceThreshold:
        dto.protectedImportanceThreshold ??
        existing?.protectedImportanceThreshold ??
        this.safetyConfig.protectedImportanceThreshold,
      batchEnabled:
        dto.batchEnabled ?? existing?.batchEnabled ?? this.config.batchEnabled,
    };

    const config = await this.prisma.dedupConfig.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    // Update in-memory config
    if (
      dto.protectedTypes ||
      dto.protectedKeywords ||
      dto.protectedImportanceThreshold
    ) {
      this.safety.updateConfig({
        protectedTypes: config.protectedTypes as any,
        protectedKeywords: config.protectedKeywords,
        protectedImportanceThreshold: config.protectedImportanceThreshold,
      });
    }

    // Sync auto-resolve threshold to in-memory config
    this.config.autoResolveThreshold = config.autoResolveThreshold;

    return {
      autoMergeThreshold: config.autoMergeThreshold,
      reviewSuggestThreshold: config.reviewSuggestThreshold,
      autoResolveThreshold: config.autoResolveThreshold,
      defaultStrategy: config.defaultStrategy as MergeStrategy,
      protectedTypes: config.protectedTypes,
      protectedKeywords: config.protectedKeywords,
      protectedImportanceThreshold: config.protectedImportanceThreshold,
      batchEnabled: config.batchEnabled,
      lastBatchRunAt: config.lastBatchRunAt ?? undefined,
    };
  }

  /**
   * Get deduplication statistics
   */
  async getStats(userId: string): Promise<StatsResponseDto> {
    const allUserIds = await this.resolveAllUserIds(userId);
    const userFilter = { in: allUserIds };
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const weekStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalMemories,
      pendingReview,
      mergesThisWeek,
      rollbacksThisWeek,
      autoMergedToday,
      deletedMemories,
    ] = await Promise.all([
      this.prisma.memory.count({
        where: { userId: userFilter, deletedAt: null },
      }),
      this.prisma.mergeCandidate.count({
        where: { userId: userFilter, status: 'PENDING' },
      }),
      this.prisma.memoryMergeEvent.count({
        where: { userId: userFilter, createdAt: { gte: weekStart } },
      }),
      this.prisma.memoryMergeEvent.count({
        where: { userId: userFilter, rolledBackAt: { gte: weekStart } },
      }),
      this.prisma.memoryMergeEvent.count({
        where: {
          userId: userFilter,
          triggeredBy: 'auto',
          createdAt: { gte: todayStart },
        },
      }),
      this.prisma.memory.count({
        where: { userId: userFilter, deletedAt: { not: null } },
      }),
    ]);

    // Estimate clusters (simplified - count pending candidates)
    const clustersIdentified = pendingReview;

    // Compression ratio
    const originalCount = totalMemories + deletedMemories;
    const compressionRatio =
      originalCount > 0 ? deletedMemories / originalCount : 0;

    return {
      totalMemories,
      potentialDuplicates: pendingReview * 2, // Each candidate has 2+ memories
      clustersIdentified,
      autoMergedToday,
      pendingReview,
      compressionRatio,
      mergesThisWeek,
      rollbacksThisWeek,
    };
  }

  /**
   * Find similar memories (for manual inspection)
   */
  async findSimilar(
    memoryId: string,
    userId: string,
    options: { topK?: number; minSimilarity?: number } = {},
  ): Promise<SimilarMemoryDto[]> {
    userId = await this.resolveUserId(userId);
    return this.similarity.findSimilarMemories(memoryId, userId, options);
  }

  /**
   * Get batch job status
   */
  getJobStatus(jobId: string): BatchJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  /**
   * Get current job status
   */
  getCurrentJobStatus(): BatchJob | null {
    if (!this.currentJob) return null;
    return this.jobs.get(this.currentJob) ?? null;
  }

  // ─── Redis-backed job persistence ──────────────────────────────────

  private async persistJob(job: BatchJob): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(
        `${REDIS_JOB_PREFIX}${job.id}`,
        JSON.stringify(job),
        'EX',
        JOB_TTL_SECONDS,
      );
    } catch {
      // fallback to memory-only
    }
  }

  private async persistCurrentJob(jobId: string | null): Promise<void> {
    if (!this.redis) return;
    try {
      if (jobId) {
        await this.redis.set(
          REDIS_CURRENT_JOB_KEY,
          jobId,
          'EX',
          JOB_TTL_SECONDS,
        );
      } else {
        await this.redis.del(REDIS_CURRENT_JOB_KEY);
      }
    } catch {
      // ignore
    }
  }

  private deserializeJob(raw: string): BatchJob {
    const parsed = JSON.parse(raw);
    parsed.startedAt = new Date(parsed.startedAt);
    parsed.completedAt = parsed.completedAt
      ? new Date(parsed.completedAt)
      : undefined;
    return parsed;
  }

  private async restoreAndRecoverJobs(): Promise<void> {
    if (!this.redis) return;
    try {
      const keys = await this.redis.keys(`${REDIS_JOB_PREFIX}*`);
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const job = this.deserializeJob(raw);
        if (job.status === BatchJobStatus.RUNNING) {
          job.status = BatchJobStatus.FAILED;
          job.completedAt = new Date();
          job.errors.push('Interrupted by server restart');
          await this.persistJob(job);
          this.logger.warn(
            `[DeduplicationService] Marked stale job ${job.id} as failed (interrupted by restart)`,
          );
        }
        this.jobs.set(job.id, job);
      }
      // Clear stale currentJob pointer
      const currentJobId = await this.redis.get(REDIS_CURRENT_JOB_KEY);
      if (currentJobId) {
        const currentJob = this.jobs.get(currentJobId);
        if (!currentJob || currentJob.status !== BatchJobStatus.RUNNING) {
          this.currentJob = null;
          await this.persistCurrentJob(null);
        }
      }
    } catch (err) {
      this.logger.warn(
        `[DeduplicationService] Failed to restore jobs from Redis: ${err}`,
      );
    }
  }
}
