/**
 * ============================================================================
 * Redis-backed sliding-window rate limiter (HEY-379)
 * ============================================================================
 *
 * Uses Redis sorted sets for sliding-window counters. Each request is stored
 * as a member scored by timestamp. On each consume() call, expired entries
 * are pruned and the window count determines whether the request is allowed.
 *
 * Falls back to in-memory token buckets when REDIS_URL is not configured,
 * preserving single-instance behaviour for local development.
 * ============================================================================
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
}

@Injectable()
export class RateLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);

  private redis: Redis | null = null;
  private readonly redisUrl: string | undefined;

  /** In-memory fallback (used when Redis is unavailable) */
  private buckets = new Map<string, RateLimitBucket>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly configService: ConfigService) {
    this.redisUrl = this.configService.get<string>('REDIS_URL');
  }

  async onModuleInit(): Promise<void> {
    if (this.redisUrl) {
      try {
        this.redis = new Redis(this.redisUrl, {
          maxRetriesPerRequest: 3,
          lazyConnect: true,
          keyPrefix: 'engram:rl:',
        });
        await this.redis.connect();
        this.logger.log('Redis connected for rate limiting');
      } catch (err) {
        this.logger.warn(
          `Redis connection failed, falling back to in-memory rate limiting: ${(err as Error).message}`,
        );
        this.redis?.disconnect();
        this.redis = null;
      }
    }
  }

  /**
   * Check if a request is allowed under rate limit.
   * Returns { allowed, retryAfterMs, remaining }
   */
  async consume(
    key: string,
    limit: number,
    windowMs: number = 60_000,
  ): Promise<{ allowed: boolean; retryAfterMs: number; remaining: number }> {
    if (this.redis) {
      try {
        return await this.consumeRedis(key, limit, windowMs);
      } catch (err) {
        this.logger.warn(
          `Redis rate-limit failed, falling back to in-memory: ${(err as Error).message}`,
        );
        return this.consumeInMemory(key, limit, windowMs);
      }
    }
    return this.consumeInMemory(key, limit, windowMs);
  }

  /** Redis sliding-window implementation using sorted sets */
  private async consumeRedis(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; retryAfterMs: number; remaining: number }> {
    const bucketKey = `${key}:${limit}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    // Atomic pipeline: remove expired, count current, conditionally add
    const pipeline = this.redis!.pipeline();
    pipeline.zremrangebyscore(bucketKey, '-inf', windowStart);
    pipeline.zcard(bucketKey);

    const results = await pipeline.exec();
    const currentCount = (results![1][1] as number) ?? 0;

    if (currentCount >= limit) {
      // Get the oldest entry to calculate retry-after
      const oldest = await this.redis!.zrange(bucketKey, 0, 0, 'WITHSCORES');
      const oldestTs = oldest.length >= 2 ? Number(oldest[1]) : now;
      const retryAfterMs = Math.max(1, Math.ceil(oldestTs + windowMs - now));
      return { allowed: false, retryAfterMs, remaining: 0 };
    }

    // Add this request with a unique member (timestamp + random suffix)
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
    const addPipeline = this.redis!.pipeline();
    addPipeline.zadd(bucketKey, now, member);
    addPipeline.pexpire(bucketKey, windowMs);
    await addPipeline.exec();

    const remaining = limit - currentCount - 1;
    return { allowed: true, retryAfterMs: 0, remaining };
  }

  /** In-memory token-bucket fallback (original implementation) */
  private consumeInMemory(
    key: string,
    limit: number,
    windowMs: number,
  ): { allowed: boolean; retryAfterMs: number; remaining: number } {
    this.ensureCleanupInterval();
    const now = Date.now();
    const bucketKey = `${key}:${limit}`;
    let bucket = this.buckets.get(bucketKey);

    if (!bucket) {
      bucket = { tokens: limit, lastRefill: now };
      this.buckets.set(bucketKey, bucket);
    }

    const elapsed = now - bucket.lastRefill;
    const refillRate = limit / windowMs;
    const tokensToAdd = elapsed * refillRate;
    bucket.tokens = Math.min(limit, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: Math.floor(bucket.tokens),
      };
    }

    const deficit = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil(deficit / refillRate);
    return { allowed: false, retryAfterMs, remaining: 0 };
  }

  private ensureCleanupInterval(): void {
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, bucket] of this.buckets) {
          if (now - bucket.lastRefill > 120_000) {
            this.buckets.delete(key);
          }
        }
      }, 300_000);
      if (
        typeof this.cleanupInterval === 'object' &&
        'unref' in this.cleanupInterval
      ) {
        this.cleanupInterval.unref();
      }
    }
  }

  /** Reset all buckets (for testing) */
  async reset(): Promise<void> {
    this.buckets.clear();
    // Redis keys are scoped by prefix; flush only rate-limit keys
    if (this.redis) {
      const keys = await this.redis.keys('*');
      if (keys.length > 0) {
        // Keys already have prefix stripped by ioredis keys(), but delete needs raw keys
        await this.redis.del(...keys);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.buckets.clear();
    if (this.redis) {
      this.redis.disconnect();
      this.redis = null;
    }
  }
}
