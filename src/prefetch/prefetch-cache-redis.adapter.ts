/**
 * PrefetchCacheRedisAdapter
 *
 * Handles all Redis write-through persistence for the prefetch cache.
 * Extracted from PrefetchCacheService to keep that class focused on
 * in-memory LRU logic only.
 */

import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { CachedMemory, TopicId } from './prefetch.types';

const CACHE_PREFIX = 'prefetch:cache:';
const TOPIC_INDEX_PREFIX = 'prefetch:topic:';

export class PrefetchCacheRedisAdapter {
  private readonly logger = new Logger(PrefetchCacheRedisAdapter.name);

  constructor(private readonly redis: Redis) {}

  persist(memory: CachedMemory, ttlMs: number): void {
    const ttlSec = Math.ceil(ttlMs / 1000);
    const key = CACHE_PREFIX + memory.id;
    this.redis
      .set(key, JSON.stringify(memory), 'EX', ttlSec)
      .catch((err) => this.logger.warn('Redis persist failed', err));

    for (const topic of memory.topics) {
      const topicKey = TOPIC_INDEX_PREFIX + topic;
      this.redis
        .sadd(topicKey, memory.id)
        .then(() => this.redis.expire(topicKey, ttlSec * 2))
        .catch((err) => this.logger.warn('Redis topic index failed', err));
    }
  }

  delete(memoryId: string, topics: TopicId[]): void {
    this.redis
      .del(CACHE_PREFIX + memoryId)
      .catch((err) => this.logger.warn('Redis delete failed', err));
    for (const topic of topics) {
      this.redis
        .srem(TOPIC_INDEX_PREFIX + topic, memoryId)
        .catch((err) => this.logger.warn('Redis srem failed', err));
    }
  }

  deleteTopicIndex(topic: TopicId): void {
    this.redis
      .del(TOPIC_INDEX_PREFIX + topic)
      .catch((err) => this.logger.warn('Redis topic delete failed', err));
  }

  clearAll(): void {
    const stream = this.redis.scanStream({ match: 'prefetch:*', count: 100 });
    stream.on('data', (keys: string[]) => {
      if (keys.length > 0) {
        this.redis.del(...keys).catch(() => {});
      }
    });
  }

  async hydrate(ttlMs: number): Promise<CachedMemory[]> {
    const keys: string[] = [];
    const stream = this.redis.scanStream({
      match: CACHE_PREFIX + '*',
      count: 100,
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (batch: string[]) => keys.push(...batch));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    if (keys.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.get(key);
    const results = await pipeline.exec();
    if (!results) return [];

    const memories: CachedMemory[] = [];
    for (const [err, val] of results) {
      if (err || !val) continue;
      try {
        const memory: CachedMemory = JSON.parse(val as string);
        if (Date.now() - memory.cachedAt > ttlMs) continue;
        memories.push(memory);
      } catch {
        // skip malformed entries
      }
    }

    return memories;
  }
}
