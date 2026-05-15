import {
  Injectable,
  Logger,
  OnModuleDestroy,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

export const MAX_BATCH_SIZE = 10_000;

/**
 * Job status for individual memory processing jobs.
 */
export type JobStatus =
  | 'pending'
  | 'extracting'
  | 'embedding'
  | 'completed'
  | 'failed';

export interface MemoryJob {
  id: string;
  memoryId: string;
  userId: string;
  raw: string;
  extractionContext?: any;
  status: JobStatus;
  error?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BatchJob {
  id: string;
  userId: string;
  totalCount: number;
  memoryIds: string[];
  jobs: Map<string, MemoryJob>;
  createdAt: Date;
}

export interface BatchStatus {
  jobId: string;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  status: 'processing' | 'completed' | 'partial' | 'failed';
  errors: Array<{ memoryId: string; error: string }>;
  createdAt: Date;
}

/**
 * Simple in-process job queue for memory extraction and embedding.
 * No Redis dependency — jobs are processed via a concurrent worker pool.
 *
 * HEY-344: Async batch endpoint
 * HEY-345: Decoupled extraction/embedding with retry
 */
@Injectable()
export class MemoryJobQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(MemoryJobQueueService.name);
  private readonly batches = new Map<string, BatchJob>();
  private readonly pendingJobs: MemoryJob[] = [];
  /**
   * Guards the scheduling loop against re-entrant concurrent calls.
   * Only one logical "tick" of processNext may run at a time; subsequent
   * callers set this flag and return immediately, knowing the running tick
   * will pick up the work before it exits.
   *
   * GIN-37: Without this flag, multiple concurrent `.finally()` callbacks
   * each enter the while-loop simultaneously, all reading a stale activeCount
   * before any of them has incremented it — causing more than `concurrency`
   * jobs to be dispatched at once (double-dispatch race).
   */
  private _scheduling = false;
  private concurrency = 3;
  private activeCount = 0;
  private processor?: (job: MemoryJob) => Promise<void>;
  private shutdownRequested = false;

  // Cleanup old batches after 1 hour
  private readonly BATCH_TTL_MS = 60 * 60 * 1000;
  private cleanupInterval?: NodeJS.Timeout;

  constructor() {
    this.cleanupInterval = setInterval(
      () => this.cleanupOldBatches(),
      this.BATCH_TTL_MS,
    );
    this.cleanupInterval.unref();
  }

  onModuleDestroy() {
    this.shutdownRequested = true;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * Register the job processor function (called by MemoryJobProcessor).
   */
  registerProcessor(fn: (job: MemoryJob) => Promise<void>): void {
    this.processor = fn;
  }

  /**
   * Create a batch of jobs and start processing.
   */
  createBatch(
    userId: string,
    memories: Array<{ memoryId: string; raw: string; extractionContext?: any }>,
  ): string {
    if (memories.length > MAX_BATCH_SIZE) {
      throw new BadRequestException(
        `Batch size ${memories.length} exceeds maximum of ${MAX_BATCH_SIZE}`,
      );
    }
    const batchId = randomUUID();
    const jobs = new Map<string, MemoryJob>();

    for (const mem of memories) {
      const job: MemoryJob = {
        id: randomUUID(),
        memoryId: mem.memoryId,
        userId,
        raw: mem.raw,
        extractionContext: mem.extractionContext,
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      jobs.set(job.id, job);
      this.pendingJobs.push(job);
    }

    this.batches.set(batchId, {
      id: batchId,
      userId,
      totalCount: memories.length,
      memoryIds: memories.map((m) => m.memoryId),
      jobs,
      createdAt: new Date(),
    });

    this.logger.log(
      `[Queue] Batch ${batchId} created with ${memories.length} jobs`,
    );
    this.processNext();

    return batchId;
  }

  /**
   * Queue a single memory job (for retry or individual embedding).
   * Returns the job ID.
   */
  enqueueEmbedding(
    memoryId: string,
    userId: string,
    raw: string,
    extractionContext?: any,
  ): string {
    const job: MemoryJob = {
      id: randomUUID(),
      memoryId,
      userId,
      raw,
      extractionContext,
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.pendingJobs.push(job);
    this.processNext();
    return job.id;
  }

  /**
   * Get batch status.
   */
  getBatchStatus(batchId: string): BatchStatus | null {
    const batch = this.batches.get(batchId);
    if (!batch) return null;

    let completed = 0;
    let failed = 0;
    let pending = 0;
    const errors: Array<{ memoryId: string; error: string }> = [];

    for (const job of batch.jobs.values()) {
      switch (job.status) {
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          errors.push({
            memoryId: job.memoryId,
            error: job.error || 'Unknown error',
          });
          break;
        default:
          pending++;
          break;
      }
    }

    let status: BatchStatus['status'] = 'processing';
    if (pending === 0) {
      if (failed === 0) status = 'completed';
      else if (completed === 0) status = 'failed';
      else status = 'partial';
    }

    return {
      jobId: batchId,
      total: batch.totalCount,
      completed,
      failed,
      pending,
      status,
      errors,
      createdAt: batch.createdAt,
    };
  }

  private processNext(): void {
    // Non-reentrant: if the scheduling loop is already running, signal that
    // it should re-check for work when it finishes its current pass (by not
    // returning early from the outer loop below) rather than spinning up a
    // second concurrent loop that would race on activeCount.
    if (this._scheduling) return;

    this._scheduling = true;
    try {
      while (
        !this.shutdownRequested &&
        this.processor &&
        this.activeCount < this.concurrency &&
        this.pendingJobs.length > 0
      ) {
        const job = this.pendingJobs.shift()!;
        // Increment synchronously before any await so that subsequent
        // synchronous re-entries (from other .finally() callbacks that are
        // queued as microtasks) see the updated count.
        this.activeCount++;
        this.runJob(job).finally(() => {
          this.activeCount--;
          // Release the guard before re-entering so that this call becomes
          // the new owner of the scheduling loop.
          this._scheduling = false;
          this.processNext();
        });
      }
    } finally {
      // If we didn't hand off ownership via a .finally() callback (e.g. the
      // loop exited because the queue is empty or we hit the concurrency cap),
      // release the guard here.
      this._scheduling = false;
    }
  }

  private async runJob(job: MemoryJob): Promise<void> {
    job.attempts++;
    job.updatedAt = new Date();

    try {
      await this.processor!(job);
      job.status = 'completed';
      job.updatedAt = new Date();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Queue] Job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}): ${message}`,
      );

      if (job.attempts < job.maxAttempts) {
        // Exponential backoff: 1s, 4s, 9s...
        const delayMs = job.attempts * job.attempts * 1000;
        this.logger.log(`[Queue] Retrying job ${job.id} in ${delayMs}ms`);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref();
        });
        if (!this.shutdownRequested) {
          this.pendingJobs.push(job);
        }
      } else {
        job.status = 'failed';
        job.error = message;
        job.updatedAt = new Date();
      }
    }
  }

  private cleanupOldBatches(): void {
    const cutoff = Date.now() - this.BATCH_TTL_MS;
    for (const [id, batch] of this.batches) {
      if (batch.createdAt.getTime() < cutoff) {
        this.batches.delete(id);
      }
    }
  }
}
