/**
 * Prefetch Service
 *
 * Main orchestration service for predictive pre-fetching.
 * Coordinates topic detection, memory selection, caching, and metrics.
 */

import { Injectable, OnModuleInit, Optional, Logger } from '@nestjs/common';
import { MemoryService, MemoryWithScore } from '../memory/memory.service';
import { EmbeddingService } from '../memory/embedding.service';
import { PrismaService } from '../prisma/prisma.service';
import { TopicDetectionService } from './topic-detection.service';
import { PrefetchCacheService } from './prefetch-cache.service';
import { PrefetchMetricsService } from './prefetch-metrics.service';
import {
  TopicId,
  TopicScore,
  PrefetchConfig,
  PrefetchResult,
  EnhancedContextResult,
  ConversationContext,
  CachedMemory,
  MemorySelectionResult,
  SelectedMemory,
} from './prefetch.types';
import { getTopicDefinition, getRelatedTopics } from './topic-taxonomy';

/**
 * Default prefetch configuration
 */
export const DEFAULT_PREFETCH_CONFIG: PrefetchConfig = {
  cache: {
    maxSize: 500,
    ttlMs: 10 * 60 * 1000,
    topicSlots: 50,
    enableMetrics: true,
  },
  detection: {
    layerWeights: {
      keyword: 0.6,
      embedding: 0.4,
    },
    minConfidence: 0.3,
    maxTopics: 3,
    contextWindowSize: 5,
    enableEmbeddingClassification: false,
  },
  enabled: true,
  backgroundPrefetch: true,
  maxPrefetchBatchSize: 50,
  prefetchDelayMs: 100,
};

@Injectable()
export class PrefetchService implements OnModuleInit {
  private readonly logger = new Logger(PrefetchService.name);
  private config: PrefetchConfig;
  private prefetchQueue: Array<{ userId: string; topics: TopicScore[] }> = [];
  private isProcessingQueue = false;
  private prefetchIdCounter = 0;

  constructor(
    private topicDetection: TopicDetectionService,
    private cache: PrefetchCacheService,
    private metrics: PrefetchMetricsService,
    private prisma: PrismaService,
    @Optional() private memoryService?: MemoryService,
    @Optional() private embeddingService?: EmbeddingService,
  ) {
    this.config = { ...DEFAULT_PREFETCH_CONFIG };
  }

  async onModuleInit(): Promise<void> {
    // Initialize topic prototypes if embedding classification is enabled
    if (this.config.detection.enableEmbeddingClassification) {
      await this.topicDetection.initializePrototypes();
    }
  }

  /**
   * Configure the prefetch system
   */
  configure(config: Partial<PrefetchConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      cache: { ...this.config.cache, ...config.cache },
      detection: { ...this.config.detection, ...config.detection },
    };

    // Apply configurations to sub-services
    this.cache.configure(this.config.cache);
    this.topicDetection.configure(this.config.detection);
  }

  /**
   * Get current configuration
   */
  getConfig(): PrefetchConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  /**
   * Check if prefetch is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Process a message and trigger prefetch
   * Returns detected topics immediately, prefetch happens in background
   */
  async processMessage(
    message: string,
    userId: string,
    context?: ConversationContext,
  ): Promise<TopicScore[]> {
    if (!this.config.enabled) {
      return [];
    }

    const startTime = Date.now();

    // Detect topics
    const detection = await this.topicDetection.detect(message, context);

    // Record detection latency
    this.metrics.recordDetectionLatency(detection.processingTimeMs);

    // Schedule background prefetch
    if (this.config.backgroundPrefetch && detection.topics.length > 0) {
      this.schedulePrefetch(userId, detection.topics);
    }

    return detection.topics;
  }

  /**
   * Load context with prefetch support
   * First checks cache, then falls back to database
   */
  async loadContextWithPrefetch(
    userId: string,
    query: string,
    limit: number = 10,
    context?: ConversationContext,
  ): Promise<EnhancedContextResult> {
    const startTime = Date.now();

    if (!this.config.enabled) {
      // Prefetch disabled, return empty result
      return {
        memories: [],
        fromCache: false,
        cacheHits: 0,
        cacheMisses: 0,
        prefetchTriggered: false,
        topics: [],
        latencyMs: Date.now() - startTime,
      };
    }

    // Detect topics from query
    const detection = await this.topicDetection.detect(query, context);
    this.metrics.recordDetectionLatency(detection.processingTimeMs);

    // Try to get memories from cache
    const cachedMemories: CachedMemory[] = [];
    let cacheMisses = 0;

    for (const topicScore of detection.topics) {
      const topicMemories = this.cache.getByTopic(topicScore.topic);
      for (const mem of topicMemories) {
        if (!cachedMemories.some((m) => m.id === mem.id)) {
          cachedMemories.push(mem);
        }
      }
    }

    const visible = cachedMemories.length
      ? await this.prisma.memory.findMany({
          where: {
            id: { in: cachedMemories.map((memory) => memory.id) },
            userId,
            deletedAt: null,
            userHidden: false,
          },
          select: { id: true },
        })
      : [];
    const visibleIds = new Set(visible.map((memory) => memory.id));
    const eligibleMemories = cachedMemories.filter((memory) =>
      visibleIds.has(memory.id),
    );
    const cacheHits = eligibleMemories.length;
    for (let index = 0; index < cacheHits; index++) {
      this.metrics.recordCacheResult(true);
    }

    // Record cache misses if we didn't get enough
    if (eligibleMemories.length < limit) {
      cacheMisses = limit - eligibleMemories.length;
      for (let i = 0; i < cacheMisses; i++) {
        this.metrics.recordCacheResult(false);
      }
    }

    // Sort by score and limit
    const sortedMemories = eligibleMemories
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Trigger background prefetch for next queries
    if (this.config.backgroundPrefetch) {
      const predictedTopics = this.topicDetection.predictNextTopics(
        detection.topics,
      );
      if (predictedTopics.length > 0) {
        this.schedulePrefetch(userId, predictedTopics);
      }
    }

    const latencyMs = Date.now() - startTime;
    this.metrics.recordLookupLatency(latencyMs);

    return {
      memories: sortedMemories,
      fromCache: cacheHits > 0,
      cacheHits,
      cacheMisses,
      prefetchTriggered:
        this.config.backgroundPrefetch && detection.topics.length > 0,
      topics: detection.topics,
      latencyMs,
    };
  }

  /**
   * Manually trigger prefetch for specific topics
   */
  async prefetchForTopics(
    userId: string,
    topics: TopicScore[],
  ): Promise<PrefetchResult> {
    const startTime = Date.now();
    const prefetchId = this.generatePrefetchId();

    if (!this.memoryService || !this.embeddingService) {
      return {
        prefetchedCount: 0,
        topics: topics.map((t) => t.topic),
        timeMs: Date.now() - startTime,
        cacheHits: 0,
        cacheMisses: 0,
      };
    }

    const cachedIds = this.cache.getCachedIds();
    let totalPrefetched = 0;
    let cacheHits = 0;

    for (const topicScore of topics) {
      const topicDef = getTopicDefinition(topicScore.topic);
      if (!topicDef) continue;

      // Select memories for this topic
      const selection = await this.selectMemoriesForTopic(
        userId,
        topicScore,
        topicDef.defaultMemoryLimit,
        cachedIds,
      );

      if (selection.memories.length === 0) continue;

      // Fetch full memories
      const memoryIds = selection.memories.map((m) => m.id);
      const memories = await this.fetchMemories(userId, memoryIds);

      if (memories.length === 0) continue;

      // Add to cache
      const prefetchedCount = this.cache.prefetchForTopic(
        memories.map((m) => ({
          id: m.id,
          content: m.raw,
          embedding: [], // Embeddings fetched separately if needed
          score: m.score ?? 0.5,
          layer: m.layer,
        })),
        topicScore.topic,
      );

      totalPrefetched += prefetchedCount;

      // Record metrics
      for (const mem of selection.memories) {
        if (!cachedIds.has(mem.id)) {
          this.metrics.recordPrefetch(
            prefetchId,
            userId,
            topicScore.topic,
            mem.id,
            topicScore.confidence,
            mem.score,
          );
          cachedIds.add(mem.id);
        } else {
          cacheHits++;
        }
      }
    }

    const timeMs = Date.now() - startTime;
    this.metrics.recordPrefetchLatency(timeMs);

    return {
      prefetchedCount: totalPrefetched,
      topics: topics.map((t) => t.topic),
      timeMs,
      cacheHits,
      cacheMisses: totalPrefetched,
    };
  }

  /**
   * Warm the cache for a user session
   * Pre-loads common topics
   */
  async warmCache(
    userId: string,
    initialTopics?: TopicId[],
  ): Promise<PrefetchResult> {
    const topics: TopicScore[] = (
      initialTopics || ['identity', 'family', 'schedule', 'projects/active']
    ).map((topic) => ({
      topic: topic,
      confidence: 0.5,
      source: 'merged',
    }));

    return this.prefetchForTopics(userId, topics);
  }

  /**
   * Handle topic shift - evict old topics, prefetch new
   */
  async handleTopicShift(
    userId: string,
    currentTopics: TopicScore[],
  ): Promise<void> {
    const shift = this.topicDetection.detectTopicShift(userId, currentTopics);

    if (!shift) return;

    // Evict departed topics (with grace period handled internally)
    for (const topic of shift.departedTopics) {
      // Don't immediately evict - check if still somewhat relevant
      const stillRelevant = currentTopics.some(
        (t) => t.topic === topic && t.confidence > 0.3,
      );

      if (!stillRelevant) {
        this.cache.evictTopic(topic);
      }
    }

    // Prefetch arrived topics
    if (shift.arrivedTopics.length > 0) {
      const newTopics: TopicScore[] = shift.arrivedTopics.map((topic) => ({
        topic,
        confidence: 0.7,
        source: 'merged',
      }));

      this.schedulePrefetch(userId, newTopics);
    }
  }

  /**
   * Record that a memory was accessed
   */
  recordMemoryAccess(memoryId: string, prefetchId?: string): void {
    // Update cache access count
    this.cache.get(memoryId);

    // Record metrics
    if (prefetchId) {
      this.metrics.recordAccess(prefetchId, memoryId);
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Get prefetch metrics
   */
  getMetrics() {
    return this.metrics.getMetrics();
  }

  /**
   * Get precision/recall metrics
   */
  getPrecisionRecall(userId?: string, windowMs?: number) {
    return this.metrics.calculatePrecisionRecall(userId, windowMs);
  }

  /**
   * Clear cache for a user
   */
  clearUserCache(userId: string): void {
    // Clear all topics
    const stats = this.cache.getStats();
    // Note: We don't track per-user in this simple implementation
    // A more complete implementation would add user tracking
  }

  /**
   * Clear topic history for a user
   */
  clearTopicHistory(userId: string): void {
    this.topicDetection.clearHistory(userId);
  }

  /**
   * Reset all metrics
   */
  resetMetrics(): void {
    this.metrics.reset();
    this.cache.resetMetrics();
  }

  /**
   * Clear the entire cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Schedule a prefetch operation
   */
  private schedulePrefetch(userId: string, topics: TopicScore[]): void {
    this.prefetchQueue.push({ userId, topics });

    // Process queue if not already processing
    if (!this.isProcessingQueue) {
      this.processQueue();
    }
  }

  /**
   * Process the prefetch queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.prefetchQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.prefetchQueue.length > 0) {
      const item = this.prefetchQueue.shift();
      if (!item) break;

      try {
        await this.prefetchForTopics(item.userId, item.topics);
      } catch (error) {
        this.logger.error('Prefetch failed:', error);
      }

      // Small delay between prefetches to avoid overwhelming the system
      if (this.config.prefetchDelayMs > 0 && this.prefetchQueue.length > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.prefetchDelayMs),
        );
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Select memories for a topic
   */
  private async selectMemoriesForTopic(
    userId: string,
    topic: TopicScore,
    limit: number,
    excludeIds: Set<string>,
  ): Promise<MemorySelectionResult> {
    const startTime = Date.now();
    const memories: SelectedMemory[] = [];

    if (!this.memoryService) {
      return {
        memories: [],
        processingTimeMs: Date.now() - startTime,
        strategy: 'semantic',
      };
    }

    const topicDef = getTopicDefinition(topic.topic);
    if (!topicDef) {
      return {
        memories: [],
        processingTimeMs: Date.now() - startTime,
        strategy: 'semantic',
      };
    }

    try {
      // Use semantic search with topic's prototype query
      const result = await this.memoryService.recall(userId, {
        query: topicDef.prototypeQuery,
        limit: limit * 2, // Over-fetch to allow filtering
      });

      for (const mem of result.memories) {
        if (excludeIds.has(mem.id)) continue;

        memories.push({
          id: mem.id,
          score: (mem.score ?? 0.5) * topic.confidence,
          source: 'semantic',
        });

        if (memories.length >= limit) break;
      }
    } catch (error) {
      this.logger.error('Memory selection failed:', error);
    }

    return {
      memories: memories.slice(0, limit),
      processingTimeMs: Date.now() - startTime,
      strategy: 'semantic',
    };
  }

  /**
   * Fetch full memories from database
   */
  private async fetchMemories(
    userId: string,
    memoryIds: string[],
  ): Promise<MemoryWithScore[]> {
    if (!this.memoryService || memoryIds.length === 0) {
      return [];
    }

    // Use recall with each ID - not ideal but works for now
    // A more efficient implementation would add a findByIds method
    const results: MemoryWithScore[] = [];

    for (const id of memoryIds.slice(0, this.config.maxPrefetchBatchSize)) {
      try {
        const mem = await this.memoryService.getById(id);
        if (mem && !mem.userHidden && mem.userId === userId) {
          results.push({ ...mem, score: 0.5 });
        }
      } catch {
        // Skip failed fetches
      }
    }

    return results;
  }

  /**
   * Generate a unique prefetch ID
   */
  private generatePrefetchId(): string {
    return `pf-${Date.now()}-${this.prefetchIdCounter++}`;
  }
}
