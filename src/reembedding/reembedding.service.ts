import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../memory/embedding.service';
import { EmbeddingService as EmbeddingProviderService } from '../embedding/embedding.service';
import { rlsContext } from '../prisma/rls-context';
import {
  ContextEnricherService,
  MemoryWithRelations,
} from './context-enricher.service';
import {
  TriggerReembeddingDto,
  ReembeddingJobDto,
  ReembeddingJobStatus,
  EnrichedMemoryPreviewDto,
} from './dto/reembedding.dto';
import { randomUUID } from 'crypto';

const REDIS_JOB_PREFIX = 'engram:reembed:job:';
const REDIS_CURRENT_JOB_KEY = 'engram:reembed:currentJob';
const JOB_TTL_SECONDS = 604_800; // 7 days

/**
 * Internal job state (in-memory for MVP)
 */
interface ReembeddingJob {
  id: string;
  status: ReembeddingJobStatus;
  totalMemories: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  options: TriggerReembeddingDto;
}

/**
 * Re-embedding Service
 *
 * MVP Implementation: Orchestrates batch re-embedding with context enrichment.
 *
 * Features:
 * - Feature flag controlled (REEMBEDDING_ENABLED)
 * - Batch processing with progress tracking
 * - Embedding versioning via metadata
 * - Dry run support for previewing changes
 */
@Injectable()
export class ReembeddingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReembeddingService.name);
  private jobs: Map<string, ReembeddingJob> = new Map();
  private currentJob: string | null = null;
  private redis: Redis | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private embedding: EmbeddingService,
    private enricher: ContextEnricherService,
    private embeddingProvider: EmbeddingProviderService,
  ) {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (redisUrl && redisUrl.startsWith('redis')) {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      this.redis.connect().catch((err) => {
        this.logger.warn(
          `[ReembeddingService] Redis connect failed, falling back to in-memory: ${err.message}`,
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
      (j) => j.status === ReembeddingJobStatus.RUNNING,
    );
    if (runningJobs.length > 0) {
      this.logger.warn(
        `Shutting down with ${runningJobs.length} re-embedding job(s) still in progress: ${runningJobs.map((j) => j.id).join(', ')}`,
      );
      for (const job of runningJobs) {
        job.status = ReembeddingJobStatus.FAILED;
        job.completedAt = new Date();
        job.error =
          (job.error ? job.error + '; ' : '') +
          'Interrupted by server shutdown';
        this.persistJob(job).catch(() => {});
      }
    }
  }

  /**
   * Check if re-embedding is enabled via feature flag
   */
  isEnabled(): boolean {
    const enabled = this.config.get<string>('REEMBEDDING_ENABLED');
    return enabled === 'true' || enabled === '1';
  }

  /**
   * Trigger a re-embedding batch job
   *
   * @param dto - Options for the re-embedding run
   * @returns Job status
   */
  async triggerReembedding(
    dto: TriggerReembeddingDto,
  ): Promise<ReembeddingJobDto> {
    if (!this.isEnabled()) {
      throw new Error(
        'Re-embedding is disabled. Set REEMBEDDING_ENABLED=true to enable.',
      );
    }

    // Prevent concurrent jobs (MVP limitation)
    if (this.currentJob) {
      const current = this.jobs.get(this.currentJob);
      if (current && current.status === ReembeddingJobStatus.RUNNING) {
        throw new Error(
          `A re-embedding job is already running: ${this.currentJob}`,
        );
      }
    }

    // Create job
    const jobId = randomUUID();
    const job: ReembeddingJob = {
      id: jobId,
      status: ReembeddingJobStatus.PENDING,
      totalMemories: 0,
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      options: dto,
    };
    this.jobs.set(jobId, job);
    this.currentJob = jobId;
    this.persistJob(job).catch(() => {});
    this.persistCurrentJob(jobId).catch(() => {});

    // Start processing asynchronously — run OUTSIDE the current AsyncLocalStorage
    // context so the RLS transaction from the HTTP request (already committed
    // by the time this callback runs) does not leak into the job's DB queries.
    rlsContext.run(undefined as any, () => {
      this.runJob(jobId).catch((error) => {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `[ReembeddingService] Job ${jobId} failed: ${errMsg}`,
        );
        const failedJob = this.jobs.get(jobId);
        if (failedJob) {
          failedJob.status = ReembeddingJobStatus.FAILED;
          failedJob.error = errMsg;
          failedJob.completedAt = new Date();
          this.persistJob(failedJob).catch(() => {});
        }
      });
    });

    return this.toDto(job);
  }

  /**
   * Get status of a re-embedding job
   */
  getJobStatus(jobId: string): ReembeddingJobDto | null {
    const job = this.jobs.get(jobId);
    return job ? this.toDto(job) : null;
  }

  /**
   * Get the current job status (if any)
   */
  getCurrentJobStatus(): ReembeddingJobDto | null {
    if (!this.currentJob) return null;
    return this.getJobStatus(this.currentJob);
  }

  /**
   * List all jobs (most recent first)
   */
  listJobs(limit: number = 10): ReembeddingJobDto[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => {
        const aTime = a.startedAt?.getTime() ?? 0;
        const bTime = b.startedAt?.getTime() ?? 0;
        return bTime - aTime;
      })
      .slice(0, limit)
      .map((job) => this.toDto(job));
  }

  /**
   * Preview enrichment for a single memory (for debugging/testing)
   */
  async previewEnrichment(
    memoryId: string,
  ): Promise<EnrichedMemoryPreviewDto | null> {
    const memory = await this.enricher.getMemoryForEnrichment(memoryId);
    if (!memory) return null;

    const enrichment = await this.enricher.enrich(memory);
    const currentVersion = await this.getEmbeddingVersion(memoryId);

    return {
      memoryId: memory.id,
      originalContent: enrichment.originalContent,
      enrichedContent: enrichment.enrichedContent,
      temporalContext: enrichment.metadata.temporalContext,
      entityContext: enrichment.metadata.entityContext,
      importanceContext: enrichment.metadata.importanceContext,
      currentVersion,
      newVersion: currentVersion + 1,
    };
  }

  /**
   * Re-embed a single memory
   *
   * @param memoryId - Memory to re-embed
   * @param dryRun - If true, don't actually update the embedding
   * @returns Preview of the enrichment
   */
  async reembedMemory(
    memoryId: string,
    dryRun: boolean = false,
  ): Promise<EnrichedMemoryPreviewDto | null> {
    const memory = await this.enricher.getMemoryForEnrichment(memoryId);
    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    const enrichment = await this.enricher.enrich(memory);
    const currentVersion = await this.getEmbeddingVersion(memoryId);
    const newVersion = currentVersion + 1;

    if (!dryRun) {
      // Generate new embedding from enriched content
      const embedding = await this.embedding.generate(
        enrichment.enrichedContent,
      );

      // Store with updated metadata
      await this.embedding.store(memoryId, embedding, {
        userId: memory.userId,
        layer: memory.layer,
        importance: memory.effectiveScore ?? memory.importanceScore,
        createdAt: memory.createdAt,
      });

      // Update embedding version in database
      await this.updateEmbeddingVersion(memoryId, newVersion, enrichment);

      this.logger.log(
        `[ReembeddingService] Re-embedded memory ${memoryId} (v${newVersion})`,
      );
    }

    return {
      memoryId: memory.id,
      originalContent: enrichment.originalContent,
      enrichedContent: enrichment.enrichedContent,
      temporalContext: enrichment.metadata.temporalContext,
      entityContext: enrichment.metadata.entityContext,
      importanceContext: enrichment.metadata.importanceContext,
      currentVersion,
      newVersion,
    };
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Run the batch re-embedding job
   */
  private async runJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = ReembeddingJobStatus.RUNNING;
    job.startedAt = new Date();

    this.logger.log(
      `Starting job ${jobId} (provider: ${this.embeddingProvider.getProviderName()})`,
    );

    try {
      // Pre-flight check: verify embedding provider is reachable
      const healthy = await this.embeddingProvider.healthCheck();
      if (!healthy) {
        const provider = this.embeddingProvider.getProviderName();
        throw new Error(
          `Embedding provider '${provider}' health check failed. ` +
            (provider === 'local'
              ? 'The local engram-embed server (port 8080) is not running. ' +
                'Set EMBEDDING_PROVIDER=cloud-ensemble for cloud deployments.'
              : 'Check OPENAI_API_KEY and COHERE_API_KEY are set and quota is not exhausted. ' +
                'See logs for per-model error details.'),
        );
      }

      // Fetch memories to process
      const memories = await this.enricher.getMemoriesForEnrichment({
        userId: job.options.userId,
        staleDays: job.options.staleDays,
        limit: job.options.limit ?? 1000,
      });

      job.totalMemories = memories.length;
      this.logger.log(
        `[ReembeddingService] Found ${memories.length} memories to process`,
      );

      // Process in batches of 10
      const batchSize = 10;
      for (let i = 0; i < memories.length; i += batchSize) {
        const batch = memories.slice(i, i + batchSize);

        await Promise.all(
          batch.map(async (memory) => {
            try {
              await this.processMemory(memory, job.options.dryRun ?? false);
              job.successCount++;
            } catch (error) {
              this.logger.error(
                `[ReembeddingService] Failed to process memory ${memory.id}:`,
                error,
              );
              job.failureCount++;
            }
            job.processedCount++;
          }),
        );

        // Log progress every 100 memories
        if (
          job.processedCount % 100 === 0 ||
          job.processedCount === job.totalMemories
        ) {
          this.logger.log(
            `[ReembeddingService] Progress: ${job.processedCount}/${job.totalMemories} ` +
              `(${job.successCount} success, ${job.failureCount} failed)`,
          );
        }
      }

      job.status = ReembeddingJobStatus.COMPLETED;
      job.completedAt = new Date();
      await this.persistJob(job);

      this.logger.log(
        `[ReembeddingService] Job ${jobId} completed: ` +
          `${job.successCount} success, ${job.failureCount} failed`,
      );
    } catch (error) {
      job.status = ReembeddingJobStatus.FAILED;
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = new Date();
      await this.persistJob(job);
      throw error;
    }
  }

  /**
   * Process a single memory for re-embedding
   */
  private async processMemory(
    memory: MemoryWithRelations,
    dryRun: boolean,
  ): Promise<void> {
    const enrichment = await this.enricher.enrich(memory);
    const currentVersion = await this.getEmbeddingVersion(memory.id);
    const newVersion = currentVersion + 1;

    if (dryRun) {
      // Just log what would happen
      this.logger.debug(
        `[ReembeddingService] [DRY RUN] Would re-embed ${memory.id} to v${newVersion}`,
      );
      return;
    }

    // Generate new embedding from enriched content
    const embedding = await this.embedding.generate(enrichment.enrichedContent);

    // Store with updated metadata
    await this.embedding.store(memory.id, embedding, {
      userId: memory.userId,
      layer: memory.layer,
      importance: memory.effectiveScore ?? memory.importanceScore,
      createdAt: memory.createdAt,
    });

    // Update embedding version in database
    await this.updateEmbeddingVersion(memory.id, newVersion, enrichment);
  }

  /**
   * Get current embedding version for a memory
   * MVP: Stored in extraction.rawJson.embeddingVersion
   */
  private async getEmbeddingVersion(memoryId: string): Promise<number> {
    const extraction = await this.prisma.memoryExtraction.findUnique({
      where: { memoryId },
      select: { rawJson: true },
    });

    if (!extraction?.rawJson) return 0;

    const rawJson = extraction.rawJson as any;
    return rawJson.embeddingVersion ?? 0;
  }

  /**
   * Update embedding version and enrichment metadata
   */
  private async updateEmbeddingVersion(
    memoryId: string,
    version: number,
    enrichment: { metadata: { enrichmentVersion: string; enrichedAt: Date } },
  ): Promise<void> {
    const extraction = await this.prisma.memoryExtraction.findUnique({
      where: { memoryId },
      select: { rawJson: true },
    });

    const existingJson = (extraction?.rawJson as any) ?? {};

    await this.prisma.memoryExtraction.upsert({
      where: { memoryId },
      update: {
        rawJson: {
          ...existingJson,
          embeddingVersion: version,
          enrichmentVersion: enrichment.metadata.enrichmentVersion,
          lastReembeddedAt: enrichment.metadata.enrichedAt.toISOString(),
        },
      },
      create: {
        memoryId,
        rawJson: {
          embeddingVersion: version,
          enrichmentVersion: enrichment.metadata.enrichmentVersion,
          lastReembeddedAt: enrichment.metadata.enrichedAt.toISOString(),
        },
      },
    });
  }

  /**
   * Convert internal job to DTO
   */
  private toDto(job: ReembeddingJob): ReembeddingJobDto {
    return {
      jobId: job.id,
      status: job.status,
      totalMemories: job.totalMemories,
      processedCount: job.processedCount,
      successCount: job.successCount,
      failureCount: job.failureCount,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
    };
  }

  // ─── Redis-backed job persistence ──────────────────────────────────

  private async persistJob(job: ReembeddingJob): Promise<void> {
    if (!this.redis) return;
    try {
      // Omit non-serializable options field for storage
      const serializable = { ...job, options: undefined };
      await this.redis.set(
        `${REDIS_JOB_PREFIX}${job.id}`,
        JSON.stringify(serializable),
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

  private deserializeJob(raw: string): ReembeddingJob {
    const parsed = JSON.parse(raw);
    parsed.startedAt = parsed.startedAt
      ? new Date(parsed.startedAt)
      : undefined;
    parsed.completedAt = parsed.completedAt
      ? new Date(parsed.completedAt)
      : undefined;
    parsed.options = parsed.options ?? {};
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
        if (
          job.status === ReembeddingJobStatus.RUNNING ||
          job.status === ReembeddingJobStatus.PENDING
        ) {
          job.status = ReembeddingJobStatus.FAILED;
          job.completedAt = new Date();
          job.error =
            (job.error ? job.error + '; ' : '') +
            'Interrupted by server restart';
          await this.persistJob(job);
          this.logger.warn(
            `[ReembeddingService] Marked stale job ${job.id} as failed (interrupted by restart)`,
          );
        }
        this.jobs.set(job.id, job);
      }
      // Clear stale currentJob pointer
      const currentJobId = await this.redis.get(REDIS_CURRENT_JOB_KEY);
      if (currentJobId) {
        const currentJob = this.jobs.get(currentJobId);
        if (!currentJob || currentJob.status !== ReembeddingJobStatus.RUNNING) {
          this.currentJob = null;
          await this.persistCurrentJob(null);
        }
      }
    } catch (err) {
      this.logger.warn(
        `[ReembeddingService] Failed to restore jobs from Redis: ${err}`,
      );
    }
  }
}
