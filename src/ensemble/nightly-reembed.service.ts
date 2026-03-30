/**
 * Nightly Re-embed Service
 *
 * Handles batch re-embedding of memories with multiple models.
 * Uses pgvector for storage (replaced Pinecone).
 *
 * Features:
 * - Scheduled nightly runs (2 AM Pacific)
 * - Incremental and full re-embed modes
 * - Checkpointing for resumability
 * - Drift detection
 * - Shadow model support
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { EnsembleService } from './ensemble.service';
import { DriftDetectionService } from './drift-detection.service';
import { CheckpointService } from './checkpoint.service';
import { ModelRegistryService } from './model-registry.service';
import {
  PgVectorEnsembleProvider,
  EnsembleEmbeddingRecord,
} from './pgvector-ensemble.provider';
import {
  ModelId,
  ReembedMode,
  ReembedJobConfig,
  ReembedJobState,
  ReembedJobResult,
  ReembedProgress,
  ReembedMetrics,
  ModelMetrics,
  ReembedJobStatus,
  DriftSummary,
  MODEL_CONFIGS,
} from './ensemble.types';

// Cron schedule for nightly runs
const NIGHTLY_SCHEDULE = {
  hour: 2, // 2 AM
  minute: 0,
  timezone: 'America/Vancouver',
};

// Default batch configuration
const DEFAULT_BATCH_CONFIG = {
  batchSize: 100,
  checkpointInterval: 10,
  maxDurationMs: 4 * 60 * 60 * 1000, // 4 hours
};

@Injectable()
export class NightlyReembedService implements OnModuleInit {
  private readonly logger = new Logger(NightlyReembedService.name);
  private activeJob: ReembedJobState | null = null;
  private cancelRequested = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: ServicePrismaService,
    private readonly ensembleService: EnsembleService,
    private readonly driftService: DriftDetectionService,
    private readonly checkpointService: CheckpointService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly pgvectorProvider: PgVectorEnsembleProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Check for interrupted jobs on startup
      const checkpoint = await this.checkpointService.findActiveCheckpoint();
      if (checkpoint) {
        this.logger.warn(
          `Found interrupted job ${checkpoint.jobId}. ` +
            `Run manually with resumeJobId to continue.`,
        );
      }
    } catch (err) {
      // Don't crash the server if DB isn't ready during startup
      this.logger.warn(
        `Failed to check reembed checkpoint on startup: ${err.message}`,
      );
    }
  }

  /**
   * Execute nightly re-embed (called by scheduler)
   */
  async runNightlyReembed(): Promise<ReembedJobResult | null> {
    if (!this.isEnabled()) {
      this.logger.debug('Nightly re-embed is disabled');
      return null;
    }

    const jobId = this.generateJobId();
    this.logger.log(`Starting nightly re-embed job: ${jobId}`);

    try {
      return await this.executeReembedJob({
        jobId,
        mode: 'incremental',
        models: await this.getActiveAndShadowModels(),
        batchSize: DEFAULT_BATCH_CONFIG.batchSize,
        checkpointInterval: DEFAULT_BATCH_CONFIG.checkpointInterval,
        driftCheck: true,
      });
    } catch (error) {
      this.logger.error(`Nightly re-embed failed: ${error}`);
      throw error;
    }
  }

  /**
   * Start a manual re-embed job
   */
  async startManualJob(options: {
    mode: ReembedMode;
    models?: ModelId[];
    memoryIds?: string[];
    dryRun?: boolean;
    resumeJobId?: string;
  }): Promise<string> {
    if (this.activeJob) {
      throw new Error(`Job already running: ${this.activeJob.jobId}`);
    }

    const jobId = options.resumeJobId || this.generateJobId();
    const models = options.models || (await this.getActiveAndShadowModels());

    // Create job record BEFORE async work (RLS transaction may close after response)
    await this.createJobRecord(jobId, options.mode, models);

    // Start job asynchronously. ServicePrismaService bypasses RLS,
    // so no need to escape the ALS store.
    setImmediate(() => {
      this.executeReembedJob({
        jobId,
        mode: options.mode,
        models,
        batchSize: DEFAULT_BATCH_CONFIG.batchSize,
        checkpointInterval: DEFAULT_BATCH_CONFIG.checkpointInterval,
        dryRun: options.dryRun,
        driftCheck: true,
        skipCreateRecord: true,
      }).catch((error) => {
        this.logger.error(`Manual job ${jobId} failed: ${error}`);
      });
    });

    return jobId;
  }

  /**
   * Execute a re-embed job with checkpointing
   */
  async executeReembedJob(
    config: ReembedJobConfig & { jobId: string; skipCreateRecord?: boolean },
  ): Promise<ReembedJobResult> {
    const {
      jobId,
      mode,
      models,
      batchSize,
      checkpointInterval,
      dryRun,
      driftCheck,
      skipCreateRecord,
    } = config;
    const startTime = Date.now();

    // Initialize job state
    const state: ReembedJobState = {
      jobId,
      startedAt: new Date(),
      status: 'running',
      progress: {
        totalMemories: 0,
        processedMemories: 0,
        currentBatch: 0,
        totalBatches: 0,
        currentModel: null,
      },
      checkpoint: null,
      metrics: this.initializeMetrics(models),
      estimatedCompletion: null,
    };

    this.activeJob = state;
    this.cancelRequested = false;

    // Create DB job record (unless already created by caller)
    if (!skipCreateRecord) {
      await this.createJobRecord(jobId, mode, models);
    }

    try {
      // Check for existing checkpoint (resume interrupted job)
      const existingCheckpoint = await this.checkpointService.get(jobId);
      if (existingCheckpoint) {
        state.checkpoint = existingCheckpoint;
        state.progress = existingCheckpoint.progress;
        this.logger.log(
          `Resuming job ${jobId} from checkpoint at batch ${existingCheckpoint.progress.currentBatch}`,
        );
      }

      // Fetch memories to process
      const memories = await this.fetchMemoriesToReembed(
        mode,
        state.checkpoint?.lastProcessedId,
      );
      state.progress.totalMemories = memories.length;
      state.progress.totalBatches = Math.ceil(memories.length / batchSize);

      if (memories.length === 0) {
        this.logger.log('No memories to re-embed');
        await this.completeJob(state, 'completed');
        return this.toResult(state, Date.now() - startTime);
      }

      this.logger.log(`Found ${memories.length} memories to re-embed`);

      // Process in batches
      for (
        let i = state.progress.currentBatch;
        i < state.progress.totalBatches;
        i++
      ) {
        // Check for cancellation
        if (this.cancelRequested) {
          await this.saveCheckpoint(state, memories[i * batchSize]?.id);
          await this.completeJob(state, 'cancelled');
          return this.toResult(state, Date.now() - startTime);
        }

        const batch = memories.slice(i * batchSize, (i + 1) * batchSize);
        state.progress.currentBatch = i;

        try {
          await this.processMemoryBatch(
            batch,
            models,
            state,
            dryRun,
            driftCheck,
          );
          state.progress.processedMemories += batch.length;

          // Save checkpoint periodically
          if ((i + 1) % checkpointInterval === 0) {
            await this.saveCheckpoint(state, batch[batch.length - 1].id);
          }

          // Update progress estimate
          this.updateEstimatedCompletion(state, startTime);

          // Report progress
          await this.updateJobProgress(state);
        } catch (error) {
          // Save checkpoint for resume
          await this.saveCheckpoint(state, batch[0]?.id);
          state.status = 'failed';
          state.metrics.memoriesFailed += batch.length;
          throw error;
        }
      }

      // Cleanup checkpoint on success
      await this.checkpointService.delete(jobId);
      await this.completeJob(state, 'completed');

      return this.toResult(state, Date.now() - startTime);
    } catch (error) {
      state.status = 'failed';
      await this.prisma.ensembleReembedJob.update({
        where: { jobId },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        },
      });
      throw error;
    } finally {
      this.activeJob = null;
    }
  }

  /**
   * Cancel the currently running job
   */
  async cancelActiveJob(): Promise<boolean> {
    if (!this.activeJob) return false;
    this.cancelRequested = true;
    return true;
  }

  /**
   * Get status of active job
   */
  getActiveJobStatus(): ReembedJobState | null {
    return this.activeJob;
  }

  /**
   * Re-embed specific memories (for event-triggered re-embedding)
   */
  async reembedMemories(memoryIds: string[]): Promise<void> {
    const models = await this.getActiveModels();
    const memories = await this.prisma.memory.findMany({
      where: { id: { in: memoryIds } },
    });

    if (memories.length === 0) return;

    const state: ReembedJobState = {
      jobId: `event-${Date.now()}`,
      startedAt: new Date(),
      status: 'running',
      progress: {
        totalMemories: memories.length,
        processedMemories: 0,
        currentBatch: 0,
        totalBatches: 1,
        currentModel: null,
      },
      checkpoint: null,
      metrics: this.initializeMetrics(models),
      estimatedCompletion: null,
    };

    await this.processMemoryBatch(memories as any, models, state, false, false);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private isEnabled(): boolean {
    return (
      this.config.get<string>('ENSEMBLE_REEMBED_ENABLED', 'false') === 'true'
    );
  }

  private generateJobId(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const time = now.toISOString().slice(11, 19).replace(/:/g, '');
    return `reembed-${date}-${time}`;
  }

  private async getActiveAndShadowModels(): Promise<ModelId[]> {
    return this.modelRegistry.getActiveAndShadowModels();
  }

  private async getActiveModels(): Promise<ModelId[]> {
    return this.modelRegistry.getActiveModels();
  }

  private initializeMetrics(models: ModelId[]): ReembedMetrics {
    const perModel: Record<string, ModelMetrics> = {};
    for (const model of models) {
      perModel[model] = {
        memoriesProcessed: 0,
        totalDurationMs: 0,
        avgLatencyMs: 0,
        errors: 0,
        latencyMs: [],
      };
    }

    return {
      totalDurationMs: 0,
      avgBatchDurationMs: 0,
      memoriesProcessed: 0,
      memoriesSkipped: 0,
      memoriesFailed: 0,
      perModel: perModel as Record<ModelId, ModelMetrics>,
      drift: {
        measured: false,
        avgCosineDrift: 0,
        maxCosineDrift: 0,
        memoriesWithHighDrift: 0,
        driftThreshold: 0.15,
        byModel: {} as Record<
          ModelId,
          { avg: number; max: number; flagged: number }
        >,
      },
    };
  }

  private async fetchMemoriesToReembed(
    mode: ReembedMode,
    afterId?: string,
  ): Promise<Array<{ id: string; raw: string; userId: string }>> {
    if (mode === 'full') {
      return this.prisma.memory.findMany({
        where: afterId ? { id: { gt: afterId } } : {},
        orderBy: { id: 'asc' },
        select: { id: true, raw: true, userId: true },
      });
    }

    // Incremental: only memories changed since last run
    const lastRun = await this.getLastSuccessfulRunTime();
    return this.prisma.memory.findMany({
      where: {
        OR: [
          { updatedAt: { gt: lastRun } },
          { embeddingModel: null },
          // NOTE: embeddingVersion check deferred — field not yet in schema
        ],
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      select: { id: true, raw: true, userId: true },
    });
  }

  private async getLastSuccessfulRunTime(): Promise<Date> {
    const lastJob = await this.prisma.ensembleReembedJob.findFirst({
      where: { status: 'COMPLETED' },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    });

    // Default to 24 hours ago if no successful run
    return lastJob?.completedAt || new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  private async processMemoryBatch(
    memories: Array<{ id: string; raw: string; userId: string }>,
    models: ModelId[],
    state: ReembedJobState,
    dryRun?: boolean,
    driftCheck?: boolean,
  ): Promise<void> {
    const texts = memories.map((m) => m.raw);
    const batchStart = Date.now();

    for (const model of models) {
      state.progress.currentModel = model;
      const modelStart = Date.now();
      const modelConfig = MODEL_CONFIGS[model];

      try {
        // Generate embeddings
        const embedResult = await this.ensembleService.embedBatch(texts, [
          model,
        ]);
        const latencyMs = Date.now() - modelStart;

        state.metrics.perModel[model].latencyMs.push(latencyMs);
        state.metrics.perModel[model].totalDurationMs += latencyMs;

        // Check for drift if enabled and old embeddings exist
        if (driftCheck && embedResult.embeddings.length > 0) {
          const driftAnalyses = await this.driftService.measureBatchDrift(
            memories,
            embedResult.embeddings.map((e) => e.embedding),
            model,
          );
          this.updateDriftMetrics(state.metrics.drift, driftAnalyses, model);
        }

        // Upsert to pgvector (unless dry run)
        if (!dryRun && embedResult.embeddings.length > 0) {
          await this.upsertBatchToPgVector(
            memories,
            embedResult,
            model,
            modelConfig.dimensions,
          );
        }

        state.metrics.perModel[model].memoriesProcessed += memories.length;
      } catch (error) {
        this.logger.error(`Failed to embed with ${model}: ${error}`);
        state.metrics.perModel[model].errors += memories.length;
        throw error;
      }
    }

    state.metrics.avgBatchDurationMs =
      (state.metrics.avgBatchDurationMs * state.progress.currentBatch +
        (Date.now() - batchStart)) /
      (state.progress.currentBatch + 1);
  }

  /**
   * Upsert batch of embeddings to pgvector memory_embeddings table
   */
  private async upsertBatchToPgVector(
    memories: Array<{ id: string; raw: string; userId: string }>,
    embedResult: {
      embeddings: Array<{
        model: ModelId;
        embedding: number[];
        dimensions: number;
      }>;
    },
    model: ModelId,
    dimensions: number,
  ): Promise<void> {
    // Group embeddings by memory
    // For batch responses, embeddings are in order: [text1_model1, text2_model1, ...]
    const records: EnsembleEmbeddingRecord[] = [];

    // Filter embeddings for this specific model
    const modelEmbeddings = embedResult.embeddings.filter(
      (e) => e.model === model,
    );

    for (let i = 0; i < memories.length; i++) {
      const memory = memories[i];
      const embedding = modelEmbeddings[i];

      if (embedding) {
        records.push({
          memoryId: memory.id,
          modelId: model,
          embedding: embedding.embedding,
          dimensions: embedding.dimensions || dimensions,
        });
      }
    }

    if (records.length > 0) {
      await this.pgvectorProvider.upsertEmbeddings(records);
    }
  }

  private updateDriftMetrics(
    drift: DriftSummary,
    analyses: Array<{ cosineDrift: number; flagged: boolean }>,
    model: ModelId,
  ): void {
    if (analyses.length === 0) return;

    drift.measured = true;
    const drifts = analyses.map((a) => a.cosineDrift);
    const avgDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
    const maxDrift = Math.max(...drifts);
    const flaggedCount = analyses.filter((a) => a.flagged).length;

    // Update overall metrics
    drift.avgCosineDrift = (drift.avgCosineDrift + avgDrift) / 2;
    drift.maxCosineDrift = Math.max(drift.maxCosineDrift, maxDrift);
    drift.memoriesWithHighDrift += flaggedCount;

    // Update per-model metrics
    drift.byModel[model] = {
      avg: avgDrift,
      max: maxDrift,
      flagged: flaggedCount,
    };
  }

  private async saveCheckpoint(
    state: ReembedJobState,
    lastProcessedId: string | undefined,
  ): Promise<void> {
    if (!lastProcessedId) return;

    await this.checkpointService.save({
      jobId: state.jobId,
      createdAt: new Date(),
      lastProcessedId,
      progress: state.progress,
      completedModels: [],
      metrics: state.metrics,
    });

    this.logger.debug(`Saved checkpoint at ${lastProcessedId}`);
  }

  private updateEstimatedCompletion(
    state: ReembedJobState,
    startTime: number,
  ): void {
    const elapsed = Date.now() - startTime;
    const progressRatio =
      state.progress.processedMemories / state.progress.totalMemories;

    if (progressRatio > 0) {
      const estimatedTotal = elapsed / progressRatio;
      const remaining = estimatedTotal - elapsed;
      state.estimatedCompletion = new Date(Date.now() + remaining);
    }
  }

  private async createJobRecord(
    jobId: string,
    mode: ReembedMode,
    models: ModelId[],
  ): Promise<void> {
    await this.prisma.ensembleReembedJob.create({
      data: {
        jobId,
        status: 'RUNNING',
        mode: mode.toUpperCase() as 'INCREMENTAL' | 'FULL',
        models,
        triggeredBy: 'manual',
      },
    });
  }

  private async updateJobProgress(state: ReembedJobState): Promise<void> {
    await this.prisma.ensembleReembedJob.update({
      where: { jobId: state.jobId },
      data: {
        processedMemories: state.progress.processedMemories,
        totalMemories: state.progress.totalMemories,
        metrics: state.metrics as any,
        avgDrift: state.metrics.drift.avgCosineDrift,
        maxDrift: state.metrics.drift.maxCosineDrift,
        driftFlags: state.metrics.drift.memoriesWithHighDrift,
      },
    });

    // Log progress periodically
    const progress = Math.round(
      (state.progress.processedMemories / state.progress.totalMemories) * 100,
    );
    if (progress % 10 === 0) {
      this.logger.log(
        `Job ${state.jobId}: ${progress}% (${state.progress.processedMemories}/${state.progress.totalMemories})`,
      );
    }
  }

  private async completeJob(
    state: ReembedJobState,
    status: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    const dbStatus = status.toUpperCase() as
      | 'COMPLETED'
      | 'FAILED'
      | 'CANCELLED';

    await this.prisma.ensembleReembedJob.update({
      where: { jobId: state.jobId },
      data: {
        status: dbStatus,
        completedAt: new Date(),
        processedMemories: state.progress.processedMemories,
        failedMemories: state.metrics.memoriesFailed,
        metrics: state.metrics as any,
        avgDrift: state.metrics.drift.avgCosineDrift,
        maxDrift: state.metrics.drift.maxCosineDrift,
        driftFlags: state.metrics.drift.memoriesWithHighDrift,
      },
    });

    this.logger.log(
      `Job ${state.jobId} ${status}: ` +
        `${state.progress.processedMemories} processed, ` +
        `${state.metrics.memoriesFailed} failed`,
    );
  }

  private toResult(
    state: ReembedJobState,
    durationMs: number,
  ): ReembedJobResult {
    return {
      jobId: state.jobId,
      status: state.status,
      startedAt: state.startedAt,
      completedAt: new Date(),
      durationMs,
      memoriesProcessed: state.progress.processedMemories,
      memoriesFailed: state.metrics.memoriesFailed,
      avgDrift: state.metrics.drift.avgCosineDrift,
    };
  }
}
