import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Memory, MemoryType } from '@prisma/client';
import { MergeStrategy } from './dto/deduplication.dto';

/**
 * Result from a merge operation
 */
export interface MergeResult {
  survivorId: string;
  absorbedIds: string[];
  mergedContent: string;
  mergedMetadata: MergedMetadata;
  strategy: MergeStrategy;
  contentChanged: boolean;
}

/**
 * Metadata merged from multiple memories
 */
export interface MergedMetadata {
  importanceScore: number;
  accessCount: number;
  lastAccessedAt: Date | null;
  tags: string[];
  sources: string[];
  originalSources: string[];
}

/**
 * Memory with minimal fields needed for merging
 */
type MergeableMemory = Pick<
  Memory,
  | 'id'
  | 'raw'
  | 'memoryType'
  | 'importanceScore'
  | 'createdAt'
  | 'observedAt'
  | 'retrievalCount'
  | 'lastRetrievedAt'
  | 'usedCount'
  | 'lastUsedAt'
>;

/**
 * Merge Service
 *
 * Handles the actual merging of duplicate memories.
 * Supports multiple strategies:
 * - KEEP_NEWEST: Keep the most recently created
 * - KEEP_OLDEST: Keep the original
 * - KEEP_DETAILED: Keep the most detailed/longest
 * - KEEP_IMPORTANCE: Keep highest importance score
 * - COMBINE_METADATA: Merge metadata, keep best content
 */
@Injectable()
export class MergeService {
  constructor(private prisma: PrismaService) {}

  /**
   * Get default strategy for a memory type
   */
  getDefaultStrategy(memoryType: MemoryType | null): MergeStrategy {
    switch (memoryType) {
      case MemoryType.CONSTRAINT:
        return MergeStrategy.COMBINE_METADATA;
      case MemoryType.LESSON:
        return MergeStrategy.KEEP_NEWEST;
      case MemoryType.PREFERENCE:
        return MergeStrategy.KEEP_NEWEST;
      case MemoryType.FACT:
        return MergeStrategy.KEEP_DETAILED;
      case MemoryType.EVENT:
        return MergeStrategy.KEEP_NEWEST;
      case MemoryType.TASK:
        return MergeStrategy.KEEP_NEWEST;
      default:
        return MergeStrategy.KEEP_DETAILED;
    }
  }

  /**
   * Execute a merge with the specified strategy
   */
  async merge(
    memoryIds: string[],
    strategy: MergeStrategy,
    options: {
      survivorId?: string;
      customContent?: string;
    } = {},
  ): Promise<MergeResult> {
    if (memoryIds.length < 2) {
      throw new Error('Need at least 2 memories to merge');
    }

    // Fetch memories
    const memories = await this.prisma.memory.findMany({
      where: { id: { in: memoryIds } },
      select: {
        id: true,
        raw: true,
        memoryType: true,
        importanceScore: true,
        createdAt: true,
        observedAt: true,
        retrievalCount: true,
        lastRetrievedAt: true,
        usedCount: true,
        lastUsedAt: true,
      },
    });

    if (memories.length !== memoryIds.length) {
      throw new Error('Some memories not found');
    }

    let result: MergeResult;

    switch (strategy) {
      case MergeStrategy.KEEP_NEWEST:
        result = this.mergeKeepNewest(memories);
        break;
      case MergeStrategy.KEEP_OLDEST:
        result = this.mergeKeepOldest(memories);
        break;
      case MergeStrategy.KEEP_DETAILED:
        result = this.mergeKeepDetailed(memories);
        break;
      case MergeStrategy.KEEP_IMPORTANCE:
        result = this.mergeKeepImportance(memories);
        break;
      case MergeStrategy.COMBINE_METADATA:
        result = this.mergeCombineMetadata(memories);
        break;
      default:
        result = this.mergeKeepDetailed(memories);
    }

    // Override survivor if specified
    if (options.survivorId && memoryIds.includes(options.survivorId)) {
      const newSurvivor = memories.find((m) => m.id === options.survivorId)!;
      result.absorbedIds = memoryIds.filter((id) => id !== options.survivorId);
      result.survivorId = options.survivorId;
      if (!options.customContent) {
        result.mergedContent = newSurvivor.raw;
      }
    }

    // Override content if specified
    if (options.customContent) {
      result.mergedContent = options.customContent;
      result.contentChanged = true;
    }

    return result;
  }

  /**
   * Keep the most recently created memory, preferring observedAt (event time)
   * over createdAt (ingest time) so bulk historical imports sort correctly.
   */
  private mergeKeepNewest(memories: MergeableMemory[]): MergeResult {
    const effectiveTime = (m: MergeableMemory) =>
      new Date(m.observedAt ?? m.createdAt).getTime();
    const sorted = [...memories].sort((a, b) => effectiveTime(b) - effectiveTime(a));

    const survivor = sorted[0];
    const absorbed = sorted.slice(1);

    return {
      survivorId: survivor.id,
      absorbedIds: absorbed.map((m) => m.id),
      mergedContent: survivor.raw,
      mergedMetadata: this.mergeMetadata(memories),
      strategy: MergeStrategy.KEEP_NEWEST,
      contentChanged: false,
    };
  }

  /**
   * Keep the oldest (original) memory
   */
  private mergeKeepOldest(memories: MergeableMemory[]): MergeResult {
    const sorted = [...memories].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    const survivor = sorted[0];
    const absorbed = sorted.slice(1);

    return {
      survivorId: survivor.id,
      absorbedIds: absorbed.map((m) => m.id),
      mergedContent: survivor.raw,
      mergedMetadata: this.mergeMetadata(memories),
      strategy: MergeStrategy.KEEP_OLDEST,
      contentChanged: false,
    };
  }

  /**
   * Keep the most detailed/informative memory
   */
  private mergeKeepDetailed(memories: MergeableMemory[]): MergeResult {
    const scored = memories.map((m) => ({
      memory: m,
      score: this.computeDetailScore(m.raw),
    }));

    scored.sort((a, b) => b.score - a.score);

    const survivor = scored[0].memory;
    const absorbed = scored.slice(1).map((s) => s.memory);

    return {
      survivorId: survivor.id,
      absorbedIds: absorbed.map((m) => m.id),
      mergedContent: survivor.raw,
      mergedMetadata: this.mergeMetadata(memories),
      strategy: MergeStrategy.KEEP_DETAILED,
      contentChanged: false,
    };
  }

  /**
   * Keep the memory with highest importance score
   */
  private mergeKeepImportance(memories: MergeableMemory[]): MergeResult {
    const sorted = [...memories].sort(
      (a, b) => b.importanceScore - a.importanceScore,
    );

    const survivor = sorted[0];
    const absorbed = sorted.slice(1);

    return {
      survivorId: survivor.id,
      absorbedIds: absorbed.map((m) => m.id),
      mergedContent: survivor.raw,
      mergedMetadata: this.mergeMetadata(memories),
      strategy: MergeStrategy.KEEP_IMPORTANCE,
      contentChanged: false,
    };
  }

  /**
   * Keep best content, combine all metadata
   */
  private mergeCombineMetadata(memories: MergeableMemory[]): MergeResult {
    // Find most detailed content
    const contentWinner = memories.reduce((best, current) =>
      this.computeDetailScore(current.raw) > this.computeDetailScore(best.raw)
        ? current
        : best,
    );

    return {
      survivorId: contentWinner.id,
      absorbedIds: memories
        .filter((m) => m.id !== contentWinner.id)
        .map((m) => m.id),
      mergedContent: contentWinner.raw,
      mergedMetadata: this.mergeMetadata(memories),
      strategy: MergeStrategy.COMBINE_METADATA,
      contentChanged: false,
    };
  }

  /**
   * Compute a "detail score" for content
   * Higher score = more detailed/informative
   */
  computeDetailScore(content: string): number {
    let score = 0;

    // Length (normalized, max 30 points)
    score += Math.min(content.length / 500, 1) * 30;

    // Word count diversity (unique words, max 20 points)
    const words = new Set(content.toLowerCase().split(/\s+/));
    score += Math.min(words.size / 50, 1) * 20;

    // Has specific dates/numbers (max 15 points)
    const hasNumbers = /\d{4}|\d+\s*(years?|months?|days?|weeks?)/.test(
      content,
    );
    if (hasNumbers) score += 15;

    // Has proper nouns (rough heuristic, max 15 points)
    const properNouns = content.match(/[A-Z][a-z]+/g) || [];
    score += Math.min(properNouns.length * 2, 15);

    // Has punctuation variety (indicates structure, max 10 points)
    const punctuation = content.match(/[.,;:!?]/g) || [];
    score += Math.min(punctuation.length * 2, 10);

    // Has connecting words (indicates explanation, max 10 points)
    const connectors = [
      'because',
      'therefore',
      'since',
      'when',
      'where',
      'who',
      'which',
    ];
    const hasConnectors = connectors.some((c) =>
      content.toLowerCase().includes(c),
    );
    if (hasConnectors) score += 10;

    return score;
  }

  /**
   * Merge metadata from multiple memories
   */
  private mergeMetadata(memories: MergeableMemory[]): MergedMetadata {
    // Highest importance wins
    const importanceScore = Math.max(...memories.map((m) => m.importanceScore));

    // Sum access counts
    const accessCount = memories.reduce(
      (sum, m) => sum + (m.retrievalCount ?? 0) + (m.usedCount ?? 0),
      0,
    );

    // Most recent access
    const accessDates = memories
      .map((m) => m.lastRetrievedAt ?? m.lastUsedAt)
      .filter((d): d is Date => d !== null);
    const lastAccessedAt =
      accessDates.length > 0
        ? new Date(Math.max(...accessDates.map((d) => d.getTime())))
        : null;

    return {
      importanceScore,
      accessCount,
      lastAccessedAt,
      tags: [], // Would come from metadata JSON
      sources: [], // Would come from metadata JSON
      originalSources: memories.map((m) => m.id),
    };
  }
}
