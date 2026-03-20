import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ImportJobState,
  JobStatus,
  ImportStats,
  RowError,
} from './import.types';

/**
 * ImportJobService
 *
 * In-memory job tracker for bulk import operations.
 * Stores job state keyed by jobId, with progress and per-row error accumulation.
 *
 * Note: This is an in-memory store. Jobs are lost on server restart.
 * For production multi-instance deployments, swap to a Redis-backed store.
 */
@Injectable()
export class ImportJobService {
  private readonly logger = new Logger(ImportJobService.name);
  private readonly jobs = new Map<string, ImportJobState>();

  /** TTL for completed/failed jobs (1 hour in ms) */
  private readonly JOB_TTL_MS = 60 * 60 * 1000;

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Create a new job and return its ID.
   */
  createJob(userId: string): { jobId: string } {
    const jobId = randomUUID();
    const now = new Date();

    const state: ImportJobState = {
      jobId,
      userId,
      status: 'PROCESSING',
      progress: 0,
      stats: { profileCount: 0, memoryCount: 0, errorCount: 0 },
      errors: [],
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(jobId, state);
    this.logger.debug(`Job created: ${jobId} for user ${userId}`);

    // Schedule cleanup after TTL (unref so it doesn't block process exit in tests)
    setTimeout(() => this.evictJob(jobId), this.JOB_TTL_MS).unref();

    return { jobId };
  }

  /**
   * Get current job state. Throws NotFoundException if not found.
   */
  getJob(jobId: string): ImportJobState {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new NotFoundException(`Import job not found: ${jobId}`);
    }
    return { ...job };
  }

  /**
   * Update job progress (0.0–1.0) and current stats.
   */
  updateProgress(
    jobId: string,
    progress: number,
    stats: Partial<ImportStats>,
  ): void {
    const job = this.requireJob(jobId);
    job.progress = Math.min(1, Math.max(0, progress));
    job.stats = { ...job.stats, ...stats };
    job.updatedAt = new Date();
  }

  /**
   * Append a per-row error to the job.
   */
  addError(jobId: string, error: RowError): void {
    const job = this.requireJob(jobId);
    job.errors.push(error);
    job.stats.errorCount = job.errors.length;
    job.updatedAt = new Date();
  }

  /**
   * Mark job as COMPLETED with final stats.
   */
  completeJob(jobId: string, stats: ImportStats): void {
    const job = this.requireJob(jobId);
    job.status = 'COMPLETED';
    job.progress = 1;
    job.stats = stats;
    job.updatedAt = new Date();
    this.logger.debug(`Job completed: ${jobId}`, stats);
  }

  /**
   * Mark job as FAILED.
   */
  failJob(jobId: string, reason: string): void {
    const job = this.requireJob(jobId);
    job.status = 'FAILED';
    job.updatedAt = new Date();
    job.errors.push({ rowNumber: 0, message: `Job failed: ${reason}` });
    this.logger.warn(`Job failed: ${jobId} — ${reason}`);
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private requireJob(jobId: string): ImportJobState {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundException(`Import job not found: ${jobId}`);
    return job;
  }

  private evictJob(jobId: string): void {
    this.jobs.delete(jobId);
    this.logger.debug(`Job evicted (TTL): ${jobId}`);
  }

  /** Returns job count — useful for testing/monitoring */
  get size(): number {
    return this.jobs.size;
  }
}
