import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { LLMService } from '../llm/llm.service';
import { VectorService } from '../vector/vector.service';
import {
  SegmentationService,
  SentenceUnit,
  ParagraphUnit,
} from './segmentation.service';
import {
  QueryRouterService,
  HierarchyLevel,
  QueryAnalysis,
} from './query-router.service';
import {
  HierarchyLevel as PrismaHierarchyLevel,
  HierarchyUnit,
} from '@prisma/client';
import * as crypto from 'crypto';

// Simple UUID v4 generator using crypto
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Result of processing a memory into hierarchy units
 */
export interface ProcessResult {
  memoryId: string;
  unitsCreated: number;
  levels: HierarchyLevel[];
  units: Array<{
    id: string;
    level: HierarchyLevel;
    text: string;
  }>;
}

/**
 * Search result from hierarchy search
 */
export interface HierarchySearchResult {
  id: string;
  level: HierarchyLevel;
  text: string;
  score: number;
  sourceMemoryId: string | null;
  metadata: Record<string, any>;
}

/**
 * Aggregated search results across levels
 */
export interface AggregatedSearchResult {
  results: HierarchySearchResult[];
  routing: QueryAnalysis;
  levelsSearched: HierarchyLevel[];
}

/**
 * Retry a function up to `maxAttempts` times with exponential backoff.
 * Base delay: 200 ms — doubles each attempt (200 → 400 → 800).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 200,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Hierarchy Service
 *
 * Main facade for hierarchical embeddings functionality.
 * Handles:
 * - Processing memories into L0/L1 units
 * - Storing embeddings in Pinecone with level metadata
 * - Multi-level search with result aggregation
 * - Query routing
 *
 * IMPORTANT: processMemory is called fire-and-forget from the memory pipeline
 * (after the HTTP request ends). All background DB writes MUST use
 * `servicePrisma` (ServicePrismaService) — NOT `prisma` (RLS proxy) — to
 * avoid "Transaction already closed" errors caused by the AsyncLocalStorage
 * context expiring with the HTTP request. Same pattern as HEY-458.
 */
@Injectable()
export class HierarchyService {
  private readonly logger = new Logger(HierarchyService.name);
  private readonly enabled: boolean;
  private readonly pineconeNamespacePrefix: string;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private servicePrisma: ServicePrismaService,
    private llm: LLMService,
    private vector: VectorService,
    private segmentation: SegmentationService,
    private queryRouter: QueryRouterService,
  ) {
    this.enabled =
      this.config.get<string>('HIERARCHY_ENABLED', 'true') === 'true';
    this.pineconeNamespacePrefix = this.config.get<string>(
      'HIERARCHY_NAMESPACE_PREFIX',
      'hierarchy',
    );

    this.logger.log(
      `Hierarchical embeddings: ${this.enabled ? 'enabled' : 'disabled'}`,
    );
  }

  /**
   * Check if hierarchy processing is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Process a memory into hierarchical units (L0 sentences, L1 paragraphs)
   *
   * Called fire-and-forget from the memory pipeline — HTTP request may have
   * already ended by the time DB writes occur. Uses ServicePrismaService to
   * bypass the RLS proxy.
   *
   * @param memoryId - The memory to process
   * @param text - The memory content
   * @param userId - The user who owns this memory
   * @returns Processing result with created units
   */
  async processMemory(
    memoryId: string,
    text: string,
    userId: string,
  ): Promise<ProcessResult> {
    if (!this.enabled) {
      return {
        memoryId,
        unitsCreated: 0,
        levels: [],
        units: [],
      };
    }

    const startedAt = Date.now();
    const units: ProcessResult['units'] = [];
    let sentencesCount = 0;
    let paragraphsCount = 0;
    let l0Failures = 0;
    let l1Failures = 0;

    try {
      // Extract sentences (L0)
      const sentences = this.segmentation.extractSentences(text);
      sentencesCount = sentences.length;

      // Extract paragraphs (L1)
      const paragraphs = this.segmentation.extractParagraphs(text);
      paragraphsCount = paragraphs.length;

      this.logger.debug({
        event: 'hierarchy.process.start',
        memoryId,
        userId,
        textLength: text.length,
        sentences: sentencesCount,
        paragraphs: paragraphsCount,
      });

      // Generate embeddings and store L0 units
      for (const sentence of sentences) {
        const unit = await this.createAndStoreUnit(
          'L0',
          sentence.text,
          memoryId,
          userId,
          sentence.position,
          sentence.charStart,
          sentence.charEnd,
        );

        if (unit) {
          units.push({
            id: unit.id,
            level: 'L0',
            text: sentence.text,
          });
        } else {
          l0Failures++;
        }
      }

      // Generate embeddings and store L1 units
      for (const paragraph of paragraphs) {
        // For L1, we embed the full paragraph text
        // (In Phase 2, we might generate summaries for longer paragraphs)
        const unit = await this.createAndStoreUnit(
          'L1',
          paragraph.text,
          memoryId,
          userId,
          paragraph.position,
          paragraph.charStart,
          paragraph.charEnd,
        );

        if (unit) {
          units.push({
            id: unit.id,
            level: 'L1',
            text: paragraph.text,
          });
        } else {
          l1Failures++;
        }
      }

      const failures = l0Failures + l1Failures;
      const logPayload = {
        event: 'hierarchy.process.complete',
        memoryId,
        userId,
        sentences: sentencesCount,
        paragraphs: paragraphsCount,
        unitsCreated: units.length,
        l0Failures,
        l1Failures,
        elapsedMs: Date.now() - startedAt,
      };
      if (failures > 0) {
        this.logger.warn(logPayload);
      } else {
        this.logger.debug(logPayload);
      }

      return {
        memoryId,
        unitsCreated: units.length,
        levels: ['L0', 'L1'],
        units,
      };
    } catch (error) {
      const err = error as Error;
      const message = err?.message ?? String(error);
      const txClosed = /transaction already closed|tx.*closed/i.test(message);
      this.logger.error({
        event: 'hierarchy.process.failed',
        memoryId,
        userId,
        textLength: text.length,
        sentences: sentencesCount,
        paragraphs: paragraphsCount,
        unitsCreatedBeforeFailure: units.length,
        l0Failures,
        l1Failures,
        transactionClosed: txClosed,
        error: message,
        stack: err?.stack,
      });
      throw error;
    }
  }

  /**
   * Create a hierarchy unit and store its embedding.
   *
   * Uses ServicePrismaService (BYPASSRLS) for the PostgreSQL write so that
   * this method is safe to call after the originating HTTP request has ended
   * (fire-and-forget from the memory pipeline).
   *
   * Retries up to 3 times with exponential backoff (200 ms base) to handle
   * transient connection errors that previously failed silently.
   */
  private async createAndStoreUnit(
    level: HierarchyLevel,
    text: string,
    sourceMemoryId: string,
    userId: string,
    position: number,
    charStart: number,
    charEnd: number,
    parentUnitId?: string,
  ): Promise<HierarchyUnit | null> {
    try {
      // Generate embedding
      const embeddingResult = await this.llm.embed(text);
      const embedding = embeddingResult.embedding;

      // Generate unique IDs
      const unitId = `${level.toLowerCase()}_${generateId()}`;
      const pineconeId = `${this.pineconeNamespacePrefix}_${unitId}`;
      const namespace = `${this.pineconeNamespacePrefix}_${level}`;

      // Store in Pinecone
      await this.vector.upsert({
        id: pineconeId,
        embedding,
        metadata: {
          userId,
          level,
          sourceMemoryId,
          position,
          text: text.substring(0, 1000), // Truncate for metadata
          createdAt: new Date().toISOString(),
        },
      });

      // Store in PostgreSQL via ServicePrismaService (BYPASSRLS).
      // This call happens after the HTTP request may have ended, so we MUST
      // NOT use the RLS-scoped PrismaService here — its AsyncLocalStorage
      // context is gone and the transaction is closed (HEY-458 pattern).
      // Retry up to 3x with exponential backoff for transient errors.
      const unit = await withRetry(() =>
        this.servicePrisma.hierarchyUnit.create({
          data: {
            id: unitId,
            level: level as PrismaHierarchyLevel,
            text,
            sourceMemoryId,
            parentUnitId,
            position,
            charStart,
            charEnd,
            pineconeId,
            pineconeNamespace: namespace,
            userId,
          },
        }),
      );

      return unit;
    } catch (error) {
      const err = error as Error;
      const message = err?.message ?? String(error);
      const txClosed = /transaction already closed|tx.*closed/i.test(message);
      this.logger.error({
        event: 'hierarchy.unit.create_failed',
        level,
        sourceMemoryId,
        userId,
        position,
        textLength: text.length,
        transactionClosed: txClosed,
        afterRetries: true,
        error: message,
        stack: err?.stack,
      });
      return null;
    }
  }

  /**
   * Search across hierarchy levels
   *
   * @param query - The search query
   * @param userId - The user to search for
   * @param options - Search options
   */
  async search(
    query: string,
    userId: string,
    options: {
      levels?: HierarchyLevel[];
      routing?: 'auto' | 'explicit';
      topK?: number;
    } = {},
  ): Promise<AggregatedSearchResult> {
    const topK = options.topK || 10;

    // Determine which levels to search
    let routing: QueryAnalysis;
    let levels: HierarchyLevel[];

    if (options.routing === 'explicit' && options.levels) {
      levels = options.levels.filter((l) => l === 'L0' || l === 'L1'); // MVP: only L0/L1
      routing = {
        query,
        suggestedLevels: levels,
        confidence: 1.0,
        reasoning: 'Explicit level selection',
      };
    } else {
      routing = this.queryRouter.analyze(query);
      levels = routing.suggestedLevels.filter((l) => l === 'L0' || l === 'L1');
    }

    // Generate query embedding
    const embeddingResult = await this.llm.embed(query);
    const queryEmbedding = embeddingResult.embedding;

    // Search each level
    const allResults: HierarchySearchResult[] = [];

    for (const level of levels) {
      const results = await this.searchLevel(
        queryEmbedding,
        userId,
        level,
        topK,
      );
      allResults.push(...results);
    }

    // Sort by score
    allResults.sort((a, b) => b.score - a.score);

    // Deduplicate (prefer higher-level results for same source)
    const deduplicated = this.deduplicateResults(allResults);

    return {
      results: deduplicated.slice(0, topK),
      routing,
      levelsSearched: levels,
    };
  }

  /**
   * Search a specific hierarchy level
   */
  private async searchLevel(
    embedding: number[],
    userId: string,
    level: HierarchyLevel,
    topK: number,
  ): Promise<HierarchySearchResult[]> {
    try {
      // Search Pinecone with level filter
      const results = await this.vector.search(embedding, {
        userId,
        limit: topK,
        filter: {
          // Note: This requires updating the vector interface to support custom filters
          // For now, we'll filter in post-processing
        },
      });

      // Filter to correct level and transform results
      const filtered: HierarchySearchResult[] = [];

      for (const result of results) {
        // Check if this is a hierarchy result by looking at the ID prefix
        if (result.id.startsWith(this.pineconeNamespacePrefix)) {
          const resultLevel = result.metadata?.level as HierarchyLevel;
          if (resultLevel === level) {
            filtered.push({
              id: result.id,
              level: resultLevel,
              text: result.metadata?.text || '',
              score: result.score,
              sourceMemoryId: result.metadata?.sourceMemoryId || null,
              metadata: result.metadata || {},
            });
          }
        }
      }

      return filtered;
    } catch (error) {
      this.logger.error(`Failed to search level ${level}:`, error);
      return [];
    }
  }

  /**
   * Deduplicate results across levels
   * Prefer higher-level (L1 > L0) when same source memory
   */
  private deduplicateResults(
    results: HierarchySearchResult[],
  ): HierarchySearchResult[] {
    const seen = new Map<string, HierarchySearchResult>();
    const levelPriority: Record<HierarchyLevel, number> = {
      L3: 4,
      L2: 3,
      L1: 2,
      L0: 1,
    };

    for (const result of results) {
      const key = result.sourceMemoryId || result.id;
      const existing = seen.get(key);

      if (
        !existing ||
        levelPriority[result.level] > levelPriority[existing.level]
      ) {
        seen.set(key, result);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Get hierarchy units for a memory
   */
  async getUnitsForMemory(memoryId: string): Promise<HierarchyUnit[]> {
    return this.prisma.hierarchyUnit.findMany({
      where: { sourceMemoryId: memoryId },
      orderBy: [{ level: 'asc' }, { position: 'asc' }],
    });
  }

  /**
   * Get hierarchy statistics for a user
   */
  async getStats(userId: string): Promise<{
    totalUnits: number;
    byLevel: Record<string, number>;
    lastUpdated: Date | null;
  }> {
    const counts = await this.prisma.hierarchyUnit.groupBy({
      by: ['level'],
      where: { userId },
      _count: { id: true },
    });

    const latest = await this.prisma.hierarchyUnit.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    });

    const byLevel: Record<string, number> = {};
    let total = 0;

    for (const count of counts) {
      byLevel[count.level] = count._count.id;
      total += count._count.id;
    }

    return {
      totalUnits: total,
      byLevel,
      lastUpdated: latest?.updatedAt || null,
    };
  }

  /**
   * Delete hierarchy units for a memory
   */
  async deleteUnitsForMemory(memoryId: string): Promise<void> {
    const units = await this.prisma.hierarchyUnit.findMany({
      where: { sourceMemoryId: memoryId },
      select: { pineconeId: true },
    });

    // Delete from Pinecone
    for (const unit of units) {
      try {
        await this.vector.delete(unit.pineconeId);
      } catch (error) {
        this.logger.warn(
          `Failed to delete Pinecone vector ${unit.pineconeId}:`,
          error,
        );
      }
    }

    // Delete from PostgreSQL
    await this.prisma.hierarchyUnit.deleteMany({
      where: { sourceMemoryId: memoryId },
    });
  }

  /**
   * Reprocess all memories for a user (for backfill)
   */
  async reprocessUser(
    userId: string,
    options: { batchSize?: number } = {},
  ): Promise<{ processed: number; failed: number }> {
    const batchSize = options.batchSize || 50;
    let processed = 0;
    let failed = 0;

    // Get all memories for user
    const memories = await this.prisma.memory.findMany({
      where: {
        userId,
        deletedAt: null,
      },
      select: {
        id: true,
        raw: true,
      },
    });

    for (const memory of memories) {
      try {
        // Delete existing units first
        await this.deleteUnitsForMemory(memory.id);

        // Reprocess
        await this.processMemory(memory.id, memory.raw, userId);
        processed++;
      } catch (error) {
        this.logger.error(`Failed to reprocess memory ${memory.id}:`, error);
        failed++;
      }
    }

    return { processed, failed };
  }
}
