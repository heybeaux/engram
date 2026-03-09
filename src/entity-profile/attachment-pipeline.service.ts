import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EntityMentionService } from './entity-mention.service';
import { EntitySemanticService } from './entity-semantic.service';
import { AttachMethod } from '@prisma/client';

export interface AttachmentResult {
  memoryId: string;
  attached: Array<{
    profileId: string;
    attachMethod: AttachMethod;
    relevanceScore: number;
  }>;
  skipped: number;
}

export interface BatchResult {
  processed: number;
  failed: number;
  totalAttached: number;
  results: AttachmentResult[];
}

/** Minimum confidence to create an AUTO_MENTION attachment */
const MENTION_CONFIDENCE_THRESHOLD = 0.75;

/** Default cosine similarity threshold for AUTO_SEMANTIC */
const SEMANTIC_SIMILARITY_THRESHOLD = 0.75;

@Injectable()
export class AttachmentPipelineService {
  private readonly logger = new Logger(AttachmentPipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mentionService: EntityMentionService,
    private readonly semanticService: EntitySemanticService,
  ) {}

  /**
   * Hook called after a memory is created.
   * Runs the attachment pipeline in the background (fire-and-forget).
   */
  async onMemoryCreated(memoryId: string, userId: string): Promise<void> {
    try {
      await this.attachMemory(memoryId, userId);
    } catch (err) {
      this.logger.error(
        `onMemoryCreated failed for memory ${memoryId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Attach relevant entity profiles to a single memory.
   *
   * Process:
   * 1. Run mention detection (fast, text-based)
   * 2. Run semantic matching (slower, embedding-based)
   * 3. Upsert EntityProfileMemory records, preferring AUTO_MENTION over AUTO_SEMANTIC
   */
  async attachMemory(
    memoryId: string,
    userId: string,
  ): Promise<AttachmentResult> {
    // Load memory text
    const memory = await this.prisma.memory.findFirst({
      where: { id: memoryId, userId, deletedAt: null },
      select: { id: true, raw: true },
    });

    if (!memory) {
      this.logger.warn(
        `attachMemory: memory ${memoryId} not found for user ${userId}`,
      );
      return { memoryId, attached: [], skipped: 0 };
    }

    // Gather candidates from both detectors
    // Map: profileId -> { attachMethod, relevanceScore }
    const candidateMap = new Map<
      string,
      { attachMethod: AttachMethod; relevanceScore: number }
    >();

    // 1. Mention detection
    try {
      const mentions = await this.mentionService.detectMentions(
        memory.raw,
        userId,
      );
      for (const mention of mentions) {
        if (mention.confidence >= MENTION_CONFIDENCE_THRESHOLD) {
          // Mention wins over semantic (higher priority)
          candidateMap.set(mention.profileId, {
            attachMethod: AttachMethod.AUTO_MENTION,
            relevanceScore: mention.confidence,
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `Mention detection failed for memory ${memoryId}: ${(err as Error).message}`,
      );
    }

    // 2. Semantic matching
    try {
      const semanticMatches = await this.semanticService.findSemanticMatches(
        memoryId,
        userId,
        SEMANTIC_SIMILARITY_THRESHOLD,
      );
      for (const match of semanticMatches) {
        // Don't overwrite a stronger AUTO_MENTION match
        if (!candidateMap.has(match.profileId)) {
          candidateMap.set(match.profileId, {
            attachMethod: AttachMethod.AUTO_SEMANTIC,
            relevanceScore: match.similarity,
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `Semantic matching failed for memory ${memoryId}: ${(err as Error).message}`,
      );
    }

    if (!candidateMap.size) {
      return { memoryId, attached: [], skipped: 0 };
    }

    // Load existing attachments to deduplicate
    const existing = await this.prisma.entityProfileMemory.findMany({
      where: { memoryId },
      select: { profileId: true },
    });
    const existingProfileIds = new Set(existing.map((e) => e.profileId));

    const toCreate: Array<{
      profileId: string;
      attachMethod: AttachMethod;
      relevanceScore: number;
    }> = [];

    let skipped = 0;

    for (const [profileId, candidate] of candidateMap.entries()) {
      if (existingProfileIds.has(profileId)) {
        skipped++;
        continue;
      }
      toCreate.push({ profileId, ...candidate });
    }

    if (!toCreate.length) {
      return { memoryId, attached: [], skipped };
    }

    // Bulk create
    await this.prisma.entityProfileMemory.createMany({
      data: toCreate.map((c) => ({
        profileId: c.profileId,
        memoryId,
        relevanceScore: c.relevanceScore,
        attachMethod: c.attachMethod,
      })),
      skipDuplicates: true,
    });

    this.logger.log(
      `Attached ${toCreate.length} profiles to memory ${memoryId} (skipped ${skipped} duplicates)`,
    );

    return {
      memoryId,
      attached: toCreate,
      skipped,
    };
  }

  /**
   * Attach entity profiles to multiple memories efficiently.
   * Batch-loads profiles once, reuses for all memories.
   */
  async attachBatch(
    memoryIds: string[],
    userId: string,
  ): Promise<BatchResult> {
    if (!memoryIds.length) {
      return { processed: 0, failed: 0, totalAttached: 0, results: [] };
    }

    const results: AttachmentResult[] = [];
    let failed = 0;
    let totalAttached = 0;

    // Process in parallel with limited concurrency (5 at a time)
    const CONCURRENCY = 5;
    for (let i = 0; i < memoryIds.length; i += CONCURRENCY) {
      const batch = memoryIds.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((id) => this.attachMemory(id, userId)),
      );

      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          results.push(outcome.value);
          totalAttached += outcome.value.attached.length;
        } else {
          failed++;
          this.logger.error(
            `Batch attach failed: ${outcome.reason?.message ?? outcome.reason}`,
          );
        }
      }
    }

    return {
      processed: memoryIds.length - failed,
      failed,
      totalAttached,
      results,
    };
  }

  /**
   * Scan recent unattached memories for a user and run the attachment pipeline.
   *
   * "Unattached" = memory has no EntityProfileMemory records at all.
   */
  async scanRecentUnattached(
    userId: string,
    limit = 50,
  ): Promise<BatchResult> {
    // Find memories with no entity profile attachments
    const memories = await this.prisma.memory.findMany({
      where: {
        userId,
        deletedAt: null,
        entityProfiles: { none: {} },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true },
    });

    const memoryIds = memories.map((m) => m.id);
    this.logger.log(
      `Scanning ${memoryIds.length} unattached memories for user ${userId}`,
    );

    return this.attachBatch(memoryIds, userId);
  }
}
