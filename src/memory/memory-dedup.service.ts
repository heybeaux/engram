import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { rlsContext } from '../prisma/rls-context';
import { EmbeddingService } from './embedding.service';
import { Memory, MemorySource } from '@prisma/client';

// Three-tier dedup thresholds (v2)
export const DEDUP_AUTO_MERGE_THRESHOLD = 0.93;
export const DEDUP_REINFORCE_THRESHOLD = 0.85;
export const DEDUP_REVIEW_THRESHOLD = 0.78;
export const DEDUP_SIMILARITY_THRESHOLD = DEDUP_AUTO_MERGE_THRESHOLD;

// Insight-specific threshold — LLM-generated insights have more wording
// variation for semantically identical content, so we use a slightly
// lower bar for auto-merge (HEY-152)
export const INSIGHT_DEDUP_THRESHOLD = 0.92;
export const RELATED_SIMILARITY_THRESHOLD = 0.65;

// Source-based confidence mapping
export const SOURCE_CONFIDENCE: Record<string, number> = {
  EXPLICIT_STATEMENT: 1.0,
  CORRECTION: 1.0,
  AGENT_OBSERVATION: 0.7,
  AGENT_REFLECTION: 0.65,
  PATTERN_DETECTED: 0.65,
  SYSTEM: 0.8,
};

export interface DedupResult {
  action: 'create' | 'reinforced' | 'merged' | 'queued_review';
  existingMemory?: Memory;
  similarityScore?: number;
}

@Injectable()
export class MemoryDedupService {
  private readonly logger = new Logger(MemoryDedupService.name);
  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
  ) {}

  /**
   * Legacy dedup method kept for compatibility
   */
  async findDuplicate(
    userId: string,
    text: string,
    threshold: number = DEDUP_SIMILARITY_THRESHOLD,
  ): Promise<Memory | null> {
    const result = await this.findDuplicateV2(userId, text, threshold);
    return result.existingMemory ?? null;
  }

  /**
   * Three-tier semantic deduplication (v2)
   * - ≥0.93: auto-merge (combine content, boost confidence)
   * - ≥0.85: reinforce (increment accessCount, update lastAccessedAt)
   * - ≥0.78: flag for review (add to MergeCandidate table)
   */
  async findDuplicateV2(
    userId: string,
    text: string,
    threshold: number = DEDUP_SIMILARITY_THRESHOLD,
    excludeMemoryId?: string,
  ): Promise<DedupResult> {
    // Use a PostgreSQL SAVEPOINT so that any DB-level failure inside the dedup
    // check does not abort the caller's RLS transaction (HEY-433).
    // Without this, a failed query here leaves the shared Prisma tx in a
    // PostgreSQL-aborted state (25P02), causing memory.create() to fail too.
    const txClient = rlsContext.getStore();
    const savepointName = `dedup_${Date.now()}`;
    if (txClient) {
      try {
        await (txClient as any).$executeRawUnsafe(`SAVEPOINT ${savepointName}`);
      } catch {
        // If SAVEPOINT fails (e.g. already aborted), skip dedup safely
        return { action: 'create' };
      }
    }

    try {
      const embedding = await this.embedding.generate(text);
      // When dedup runs after the new memory has already been embedded, vector
      // search can legitimately return the candidate itself at score=1.0. Pull
      // one extra result when an exclusion is supplied so filtering out self does
      // not reduce the effective candidate pool.
      const similar = await this.embedding.search(
        userId,
        embedding,
        excludeMemoryId ? 6 : 5,
      );

      let bestMatch: (typeof similar)[number] | null = null;
      let existingMemory: Memory | null = null;

      for (const match of similar) {
        // Never let a post-embed dedup pass match the candidate memory itself.
        // A self-match would mark the row DUPLICATE of itself, making fresh
        // memories effectively non-recallable.
        if (excludeMemoryId && match.id === excludeMemoryId) {
          this.logger.debug(`[Dedup] Ignoring self-match memory=${match.id}`);
          continue;
        }

        const candidate = await this.prisma.memory.findUnique({
          where: { id: match.id },
        });

        if (!candidate || candidate.deletedAt) {
          continue;
        }

        bestMatch = match;
        existingMemory = candidate;
        break;
      }

      if (!bestMatch || !existingMemory) {
        if (txClient) {
          await (txClient as any).$executeRawUnsafe(
            `RELEASE SAVEPOINT ${savepointName}`,
          );
        }
        return { action: 'create' };
      }

      let result: DedupResult;

      if (bestMatch.score >= threshold) {
        this.logger.log(
          `[Dedup] Auto-merge: score=${bestMatch.score.toFixed(3)} memory=${bestMatch.id}`,
        );
        result = {
          action: 'merged',
          existingMemory,
          similarityScore: bestMatch.score,
        };
      } else if (bestMatch.score >= DEDUP_REINFORCE_THRESHOLD) {
        this.logger.log(
          `[Dedup] Reinforce: score=${bestMatch.score.toFixed(3)} memory=${bestMatch.id}`,
        );
        result = {
          action: 'reinforced',
          existingMemory,
          similarityScore: bestMatch.score,
        };
      } else if (bestMatch.score >= DEDUP_REVIEW_THRESHOLD) {
        this.logger.log(
          `[Dedup] Queue for review: score=${bestMatch.score.toFixed(3)} memory=${bestMatch.id}`,
        );
        try {
          await this.prisma.mergeCandidate.create({
            data: {
              userId,
              memoryIds: [existingMemory.id],
              similarity: bestMatch.score,
              suggestedStrategy: 'SEMANTIC_SIMILAR',
              suggestedSurvivorId: existingMemory.id,
              status: 'PENDING',
            },
          });
        } catch (err) {
          this.logger.error('[Dedup] Failed to create MergeCandidate:', err);
        }
        result = { action: 'create' };
      } else {
        result = { action: 'create' };
      }

      // Release savepoint — transaction is still healthy
      if (txClient) {
        try {
          await (txClient as any).$executeRawUnsafe(
            `RELEASE SAVEPOINT ${savepointName}`,
          );
        } catch {
          // Savepoint may have already been released; not fatal
        }
      }
      return result;
    } catch (error) {
      this.logger.error('Duplicate check failed:', error);
      // Roll back to savepoint to restore transaction health (HEY-433).
      // Without this, a PostgreSQL-level error in the dedup check leaves
      // the shared transaction in an aborted state (25P02), causing
      // memory.create() to fail even though the dedup error was caught.
      if (txClient) {
        try {
          await (txClient as any).$executeRawUnsafe(
            `ROLLBACK TO SAVEPOINT ${savepointName}`,
          );
        } catch {
          // Best-effort; if rollback also fails the tx is truly broken
        }
      }
      return { action: 'create' };
    }
  }

  /**
   * Auto-merge: combine content from new memory into existing, boost confidence
   */
  async autoMergeMemory(
    existingId: string,
    newContent: string,
    newSource: MemorySource,
  ): Promise<void> {
    const existing = await this.prisma.memory.findUnique({
      where: { id: existingId },
    });
    if (!existing) return;

    const newConfidence = SOURCE_CONFIDENCE[newSource] ?? 1.0;
    const boostedConfidence = Math.min(
      1.0,
      Math.max(existing.confidence, newConfidence) + 0.05,
    );

    await this.prisma.$executeRaw`
      UPDATE memories SET
        confidence = ${boostedConfidence},
        used_count = used_count + 1,
        last_used_at = NOW(),
        importance_score = LEAST(1.0, importance_score + 0.05)
      WHERE id = ${existingId}
    `;
  }

  /**
   * Reinforce an existing memory (boost importance, track sessions)
   */
  async reinforceMemory(memoryId: string, sessionId?: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE memories SET
        used_count = used_count + 1,
        last_used_at = NOW(),
        importance_score = LEAST(1.0, importance_score + 0.05)
      WHERE id = ${memoryId}
    `;

    const memory = await this.prisma.memory.findUnique({
      where: { id: memoryId },
    });
    if (memory && memory.importanceScore > 1.0) {
      await this.prisma.memory.update({
        where: { id: memoryId },
        data: { importanceScore: 1.0 },
      });
    }
  }
}
