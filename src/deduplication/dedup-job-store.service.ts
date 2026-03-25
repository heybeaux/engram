import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { BatchJobStatus } from './dto/deduplication.dto';

const REDIS_JOB_PREFIX = 'engram:dedup:job:';
const REDIS_CURRENT_JOB_KEY = 'engram:dedup:currentJob';
const JOB_TTL_SECONDS = 604_800; // 7 days

/**
 * Batch job state
 */
export interface BatchJob {
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
 * DedupJobStoreService
 *
 * Manages in-memory and Redis-backed persistence for batch deduplication jobs.
 * Extracted from DeduplicationService to keep the orchestrator focused.
 */
@Injectable()
export class DedupJobStoreService {
  private readonly logger = new Logger(DedupJobStoreService.name);
  private jobs: Map<string, BatchJob> = new Map();
  private currentJob: string | null = null;
  private redis: Redis | null = null;

  constructor(private configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (redisUrl && redisUrl.startsWith('redis')) {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      this.redis.connect().catch((err) => {
        this.logger.warn(
          `[DedupJobStoreService] Redis connect failed, falling back to in-memory: ${err.message}`,
        );
        this.redis = null;
      });
    }
  }

  getJob(jobId: string): BatchJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  getCurrentJobId(): string | null {
    return this.currentJob;
  }

  getCurrentJob(): BatchJob | null {
    if (!this.currentJob) return null;
    return this.jobs.get(this.currentJob) ?? null;
  }

  setJob(job: BatchJob): void {
    this.jobs.set(job.id, job);
  }

  setCurrentJobId(jobId: string | null): void {
    this.currentJob = jobId;
  }

  getRunningJobs(): BatchJob[] {
    return Array.from(this.jobs.values()).filter(
      (j) => j.status === BatchJobStatus.RUNNING,
    );
  }

  async persist(job: BatchJob): Promise<void> {
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

  async persistCurrentJobId(jobId: string | null): Promise<void> {
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

  async restoreAndRecoverJobs(): Promise<void> {
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
          await this.persist(job);
          this.logger.warn(
            `[DedupJobStoreService] Marked stale job ${job.id} as failed (interrupted by restart)`,
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
          await this.persistCurrentJobId(null);
        }
      }
    } catch (err) {
      this.logger.warn(
        `[DedupJobStoreService] Failed to restore jobs from Redis: ${err}`,
      );
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
}
