import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CandidateDetectionService, DetectionStats } from './candidate-detection.service';
import { DedupClassificationService } from './dedup-classification.service';
import { DedupResolutionService, ResolutionStats } from './dedup-resolution.service';
import {
  DEDUP_AUTO_DETECTION_QUEUE,
  DEDUP_AUTO_JOBS,
} from './candidate-detection.processor';

export interface PipelineRunResult {
  startedAt: Date;
  finishedAt: Date;
  detection: DetectionStats;
  classification: { processed: number; errors: number };
  resolution: ResolutionStats;
  skipped: boolean;
  reason?: string;
}

/**
 * Dedup Pipeline Service — Orchestrates all 3 phases
 *
 * Phase 1 → CandidateDetectionService.detectCandidates()
 * Phase 2 → DedupClassificationService.processPendingCandidates()
 * Phase 3 → DedupResolutionService.processClassifiedCandidates()
 *
 * Environment variables:
 *   DEDUP_PIPELINE_ENABLED         — set to "false" to disable (default: true)
 *   DEDUP_DETECTION_WINDOW_HOURS   — hours to look back for new memories (default: 2)
 *   DEDUP_AUTO_RESOLVE_THRESHOLD   — confidence threshold for auto-resolve (default: 0.7)
 *
 * Cron: daily at 04:00 (staggered 1h after Dream Cycle at 03:00)
 */
@Injectable()
export class DedupPipelineService implements OnModuleInit {
  private readonly logger = new Logger(DedupPipelineService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly detection: CandidateDetectionService,
    private readonly classification: DedupClassificationService,
    private readonly resolution: DedupResolutionService,
    @InjectQueue(DEDUP_AUTO_DETECTION_QUEUE)
    private readonly detectionQueue: Queue,
  ) {}

  onModuleInit(): void {
    const enabled = this.isPipelineEnabled();
    this.logger.log(
      `[DedupPipeline] Pipeline ${enabled ? 'ENABLED' : 'DISABLED'} — cron: daily 04:00`,
    );
  }

  // ---------------------------------------------------------------------------
  // Cron trigger — 4am daily, staggered from Dream Cycle at 3am
  // ---------------------------------------------------------------------------

  @Cron('0 4 * * *', { name: 'dedup-pipeline-daily' })
  async handleDailyCron(): Promise<void> {
    if (!this.isPipelineEnabled()) {
      this.logger.log('[DedupPipeline] Cron fired but pipeline is disabled — skipping');
      return;
    }
    this.logger.log('[DedupPipeline] Daily cron triggered');
    await this.runPipeline();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run the full 3-phase pipeline synchronously.
   * Returns a summary of all phases.
   */
  async runPipeline(): Promise<PipelineRunResult> {
    const startedAt = new Date();

    if (!this.isPipelineEnabled()) {
      const finishedAt = new Date();
      return {
        startedAt,
        finishedAt,
        detection: { scanned: 0, created: 0, skipped: 0 },
        classification: { processed: 0, errors: 0 },
        resolution: {
          processed: 0,
          autoMerged: 0,
          autoConsolidated: 0,
          queued: 0,
          skipped: 0,
          errors: 0,
        },
        skipped: true,
        reason: 'DEDUP_PIPELINE_ENABLED=false',
      };
    }

    this.logger.log('[DedupPipeline] Starting full pipeline run');

    // Phase 1 — Candidate Detection
    this.logger.log('[DedupPipeline] Phase 1: Candidate Detection');
    const detection = await this.detection.detectCandidates();
    this.logger.log(
      `[DedupPipeline] Phase 1 complete — scanned: ${detection.scanned}, created: ${detection.created}, skipped: ${detection.skipped}`,
    );

    // Phase 2 — LLM Classification
    this.logger.log('[DedupPipeline] Phase 2: LLM Classification');
    const classification = await this.classification.processPendingCandidates();
    this.logger.log(
      `[DedupPipeline] Phase 2 complete — processed: ${classification.processed}, errors: ${classification.errors}`,
    );

    // Phase 3 — Auto-Resolution
    this.logger.log('[DedupPipeline] Phase 3: Auto-Resolution');
    const resolution = await this.resolution.processClassifiedCandidates();
    this.logger.log(
      `[DedupPipeline] Phase 3 complete — merged: ${resolution.autoMerged}, consolidated: ${resolution.autoConsolidated}, queued: ${resolution.queued}`,
    );

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    this.logger.log(
      `[DedupPipeline] Full pipeline complete in ${durationMs}ms`,
    );

    return {
      startedAt,
      finishedAt,
      detection,
      classification,
      resolution,
      skipped: false,
    };
  }

  /**
   * Enqueue a detection job in BullMQ for async processing.
   */
  async enqueueDetection(): Promise<void> {
    await this.detectionQueue.add(
      DEDUP_AUTO_JOBS.DETECT_CANDIDATES,
      {},
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );
    this.logger.log('[DedupPipeline] Enqueued detection job');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isPipelineEnabled(): boolean {
    const val = this.config.get<string>('DEDUP_PIPELINE_ENABLED') ?? 'true';
    return val.toLowerCase() !== 'false';
  }
}
