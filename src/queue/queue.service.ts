import { flushAndDisconnectRedis } from './redis-shutdown';
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

const REDIS_KEY_PREFIX = 'engram:queue:job:';
const JOB_TTL_SECONDS = 604_800; // 7 days

export type JobStatus = {
  id: string;
  type: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  total: number;
  createdAt: Date;
  completedAt: Date | null;
  error: string | null;
  errors: Array<{ index: number; message: string }>;
};

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly jobs = new Map<string, JobStatus>();
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
          `[QueueService] Redis connect failed, falling back to in-memory: ${err.message}`,
        );
        this.redis?.disconnect();
        this.redis = null;
      });
    }
  }

  async onModuleInit(): Promise<void> {
    await this.restoreAndRecoverJobs();
  }

  async onModuleDestroy(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    // Mark running jobs as interrupted in Redis
    for (const job of this.jobs.values()) {
      if (job.status === 'pending' || job.status === 'processing') {
        job.status = 'failed';
        job.completedAt = new Date();
        job.error =
          (job.error ? job.error + '; ' : '') +
          'Interrupted by server shutdown';
        pending.push(this.persistJob(job));
      }
    }
    await flushAndDisconnectRedis(this.redis, pending);
    this.redis = null;
  }

  enqueue(
    type: string,
    items: any[],
    processor: (item: any, index: number) => Promise<void>,
  ): string {
    const id = randomUUID();
    const job: JobStatus = {
      id,
      type,
      status: 'pending',
      progress: 0,
      total: items.length,
      createdAt: new Date(),
      completedAt: null,
      error: null,
      errors: [],
    };
    this.jobs.set(id, job);
    this.persistJob(job).catch(() => {});

    // Fire and forget — process in background
    this.processJob(job, items, processor).catch((err) => {
      this.logger.error(`Job ${id} unexpected error: ${err.message}`);
    });

    return id;
  }

  getStatus(jobId: string): JobStatus | null {
    return this.jobs.get(jobId) ?? null;
  }

  private async processJob(
    job: JobStatus,
    items: any[],
    processor: (item: any, index: number) => Promise<void>,
  ): Promise<void> {
    job.status = 'processing';

    for (let i = 0; i < items.length; i++) {
      try {
        await processor(items[i], i);
      } catch (err: any) {
        job.errors.push({ index: i, message: err.message ?? String(err) });
        this.logger.warn(`Job ${job.id} item ${i} failed: ${err.message}`);
      }
      job.progress = i + 1;
    }

    job.status =
      job.errors.length === items.length && items.length > 0
        ? 'failed'
        : 'completed';
    job.completedAt = new Date();

    if (job.errors.length > 0) {
      job.error = `${job.errors.length}/${job.total} items failed`;
    }

    await this.persistJob(job).catch(() => {});
  }

  // ─── Redis helpers ──────────────────────────────────────────────────

  private async persistJob(job: JobStatus): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(
        `${REDIS_KEY_PREFIX}${job.id}`,
        JSON.stringify(job),
        'EX',
        JOB_TTL_SECONDS,
      );
    } catch {
      // fallback to memory-only
    }
  }

  private deserializeJob(raw: string): JobStatus {
    const parsed = JSON.parse(raw);
    parsed.createdAt = new Date(parsed.createdAt);
    parsed.completedAt = parsed.completedAt
      ? new Date(parsed.completedAt)
      : null;
    return parsed;
  }

  private async restoreAndRecoverJobs(): Promise<void> {
    if (!this.redis) return;
    try {
      const keys = await this.redis.keys(`${REDIS_KEY_PREFIX}*`);
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const job = this.deserializeJob(raw);
        if (job.status === 'pending' || job.status === 'processing') {
          job.status = 'failed';
          job.completedAt = new Date();
          job.error =
            (job.error ? job.error + '; ' : '') +
            'Interrupted by server restart';
          await this.persistJob(job);
        }
        this.jobs.set(job.id, job);
      }
    } catch (err) {
      this.logger.warn(
        `[QueueService] Failed to restore jobs from Redis: ${err}`,
      );
    }
  }
}
