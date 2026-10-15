import { Injectable, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { rlsContext } from '../prisma/rls-context';
import {
  ExtractionService,
  ExtractionContext,
  EntityWithType,
} from './extraction.service';
import { EmbeddingService } from './embedding.service';
import { HierarchyService } from '../hierarchy/hierarchy.service';
import { GraphExtractionService } from '../graph/services/graph-extraction.service';
import { AttachmentPipelineService } from '../entity-profile/attachment-pipeline.service';
import { EntityMemoryService } from './entity-memory.service';
import { parseFlexibleDate } from '../utils/date-parser';
import {
  RELATED_SIMILARITY_THRESHOLD,
  DEDUP_SIMILARITY_THRESHOLD,
} from './memory-dedup.service';

/** Entry in the in-memory embedding retry queue */
interface EmbeddingRetryEntry {
  memoryId: string;
  userId: string;
  raw: string;
  attempts: number;
  lastAttempt: Date;
}

export interface EmbeddingRetryResult {
  retried: number;
  succeeded: number;
  failed: number;
  discovered: number;
  exhaustedRetries: number;
  /** true when a previous retry run was still in flight (ENG-61) */
  skipped?: boolean;
}

/** ENG-61: per-run caps for retryFailedEmbeddings (override via env). */
const DEFAULT_EMBEDDING_RETRY_BATCH_SIZE = 100;
const DEFAULT_EMBEDDING_RETRY_TIME_BUDGET_MS = 4 * 60 * 1000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

@Injectable()
export class MemoryPipelineService {
  private readonly logger = new Logger(MemoryPipelineService.name);

  /** In-memory retry queue for failed embeddings (HEY-345) */
  private readonly embeddingRetryQueue = new Map<string, EmbeddingRetryEntry>();
  private static readonly MAX_RETRY_ATTEMPTS = 5;
  /** ENG-61: single-flight guard for retryFailedEmbeddings */
  private retryInFlight = false;
  /** ENG-61: keyset cursor so bounded discovery walks the backlog across runs */
  private retryDiscoveryCursor: { createdAt: Date; id: string } | null = null;

  constructor(
    private prisma: PrismaService,
    private extraction: ExtractionService,
    private embedding: EmbeddingService,
    @Optional() private hierarchyService?: HierarchyService,
    @Optional() private graphExtraction?: GraphExtractionService,
    @Optional() private attachmentPipeline?: AttachmentPipelineService,
    @Optional() private entityMemory?: EntityMemoryService,
  ) {}

  /**
   * Extract 5W1H structure and generate embedding for a memory
   */
  async extractAndEmbed(
    memoryId: string,
    raw: string,
    userId: string,
    context?: ExtractionContext,
  ): Promise<void> {
    const inputPreview = raw.length > 80 ? raw.substring(0, 80) + '...' : raw;

    this.logger.log('[Memory] extractAndEmbed starting:', {
      memoryId,
      inputPreview,
      userId,
      userName: context?.userName,
    });

    // ENG-62: a replayed job (e.g. a FAILED memory requeued on
    // memory-embedding) finds the extraction from its first run. Only the
    // vector is missing, so embed and stop: re-extracting would hit the
    // memory_id unique constraint, re-spend the LLM call, and repeat the
    // non-idempotent side effects (GraphEntity mentionCount increments,
    // IDENTITY entity memories, graph and hierarchy processing).
    const existingExtraction = await this.prisma.memoryExtraction.findUnique({
      where: { memoryId },
      select: { id: true },
    });
    if (existingExtraction) {
      this.logger.log(
        '[Memory] extractAndEmbed replay — extraction exists, embedding only:',
        memoryId,
      );
      await this.generateAndStoreEmbedding(memoryId, raw, userId);
      return;
    }

    // HEY-350: Run extraction and embedding generation in parallel.
    // These are the two slowest operations and have no data dependency on each other.
    const [extracted, embeddingResult] = await Promise.all([
      this.extraction.extract(raw, context),
      this.embedding.generate(raw).then(
        (embedding) => ({ ok: true as const, embedding }),
        (error) => ({ ok: false as const, error }),
      ),
    ]);

    this.logger.debug('[Memory] Extraction result:', {
      memoryId,
      who: extracted.who,
      what: extracted.what?.substring(0, 50),
      hasWhen: !!extracted.when,
      hasWhere: !!extracted.where,
      hasWhy: !!extracted.why,
      hasHow: !!extracted.how,
      topicCount: extracted.topics.length,
      topics: extracted.topics,
      entityCount: extracted.entities.length,
      entities: extracted.entities.map((e) => ({ name: e.name, type: e.type })),
    });

    // 2. Build source metadata
    const sourceMetadata = context
      ? {
          source: {
            timestamp: context.timestamp?.toISOString(),
            turnIndex: context.turnIndex,
            conversationId: context.conversationId,
            userName: context.userName,
          },
        }
      : undefined;

    // 3. Save extraction
    const parsedWhen = parseFlexibleDate(
      extracted.when,
      context?.timestamp ?? new Date(),
    );

    if (extracted.when && !parsedWhen) {
      this.logger.warn('[Memory] Could not parse date:', {
        memoryId,
        rawWhen: extracted.when,
        contextTimestamp: context?.timestamp?.toISOString(),
      });
    }

    const rawJsonData = {
      ...sourceMetadata,
      ...(extracted.lesson
        ? { lesson: JSON.parse(JSON.stringify(extracted.lesson)) }
        : {}),
    };

    await this.prisma.memoryExtraction.create({
      data: {
        memoryId,
        who: extracted.who,
        what: extracted.what,
        when: parsedWhen,
        whereCtx: extracted.where,
        why: extracted.why,
        how: extracted.how,
        topics: extracted.topics,
        factKeys: extracted.factKeys ?? [],
        rawJson:
          Object.keys(rawJsonData).length > 0
            ? (rawJsonData as any)
            : undefined,
        memoryType: extracted.memoryType,
        typeConfidence: extracted.typeConfidence,
        whoConfidence: extracted.confidence.whoConfidence,
        whatConfidence: extracted.confidence.whatConfidence,
        whenConfidence: extracted.confidence.whenConfidence,
        whereConfidence: extracted.confidence.whereConfidence,
        whyConfidence: extracted.confidence.whyConfidence,
        howConfidence: extracted.confidence.howConfidence,
      },
    });
    this.logger.debug('[Memory] MemoryExtraction saved for:', memoryId, {
      parsedWhen: parsedWhen?.toISOString() ?? null,
      memoryType: extracted.memoryType,
      typeConfidence: extracted.typeConfidence,
      confidence: extracted.confidence,
    });

    // Update memory record with type, priority, and layer promotion
    if (extracted.memoryType) {
      const priority = this.extraction.getPriorityForType(extracted.memoryType);

      // HEY-193: Promote layer to TASK when LLM classifies memoryType as TASK
      // The initial layer classification (heuristic-based) may have missed it,
      // but the LLM extraction is more reliable for task detection.
      const layerUpdate =
        extracted.memoryType === 'TASK'
          ? { layer: 'TASK' as const }
          : extracted.memoryType === 'LESSON' ||
              extracted.memoryType === 'CONSTRAINT'
            ? { layer: 'IDENTITY' as const }
            : {};

      await this.prisma.memory.update({
        where: { id: memoryId },
        data: {
          memoryType: extracted.memoryType,
          typeConfidence: extracted.typeConfidence,
          priority,
          ...layerUpdate,
        },
      });
      this.logger.debug('[Memory] Memory Intelligence updated:', {
        memoryId,
        memoryType: extracted.memoryType,
        priority,
      });

      // LESSON auto-promotion
      if (
        extracted.memoryType === 'LESSON' &&
        extracted.lesson?.lessonSeverity === 'critical'
      ) {
        await this.promoteToConstraint(memoryId);
      }
    }

    // 3b. Store capability/preference signals in metadata (HEY-169, HEY-171)
    if (
      extracted.capabilities.length > 0 ||
      extracted.preferenceSignals.length > 0
    ) {
      let existingMeta: Record<string, any> = {};
      try {
        const existingMem = await this.prisma.memory.findUnique?.({
          where: { id: memoryId },
          select: { metadata: true },
        });
        existingMeta = (existingMem?.metadata as Record<string, any>) || {};
      } catch {
        /* ignore */
      }
      const metadataUpdate: Record<string, any> = { ...existingMeta };

      if (extracted.capabilities.length > 0) {
        metadataUpdate.capabilities = extracted.capabilities;
      }
      if (extracted.preferenceSignals.length > 0) {
        metadataUpdate.preferenceCategory =
          extracted.preferenceSignals[0].category;
        metadataUpdate.preference = extracted.preferenceSignals[0].preference;
        metadataUpdate.preferenceStrength =
          extracted.preferenceSignals[0].strength;
        if (extracted.preferenceSignals.length > 1) {
          metadataUpdate.additionalPreferences =
            extracted.preferenceSignals.slice(1);
        }
      }

      await this.prisma.memory.update({
        where: { id: memoryId },
        data: { metadata: metadataUpdate },
      });
      this.logger.debug('[Memory] Capability/preference signals stored:', {
        memoryId,
        capabilities: extracted.capabilities.length,
        preferences: extracted.preferenceSignals.length,
      });
    }

    // 4. Store extracted entities
    if (extracted.entities && extracted.entities.length > 0) {
      this.logger.debug('[Memory] Storing entities:', {
        memoryId,
        count: extracted.entities.length,
        entities: extracted.entities.map((e) => `${e.name}:${e.type}`),
      });
      await this.storeEntities(userId, memoryId, extracted.entities);
      this.logger.debug('[Memory] Entities stored successfully for:', memoryId);
    } else {
      this.logger.debug('[Memory] No entities to store for:', memoryId);
    }

    // 4b. Attach to entity profiles (fire-and-forget)
    // Escape inherited tx — this outlives the caller's $transaction.
    if (this.attachmentPipeline) {
      const pipeline = this.attachmentPipeline;
      void rlsContext.run(undefined as any, () =>
        pipeline.onMemoryCreated(memoryId, userId).catch((err) => {
          this.logger.warn(
            `[Memory] Entity profile attachment failed for ${memoryId}: ${err instanceof Error ? err.message : err}`,
          );
        }),
      );
    }

    // 5. Generate and store embedding (Phase 2 — resilient, HEY-345)
    await this.generateAndStoreEmbedding(memoryId, raw, userId);

    this.logger.log('[Memory] extractAndEmbed complete:', memoryId);

    // 8. Process graph extraction (HEY-349: wire GraphExtractionService into pipeline)
    if (this.graphExtraction) {
      try {
        const memory = await this.prisma.memory.findUnique({
          where: { id: memoryId },
        });
        if (memory) {
          const graphResult = await this.graphExtraction.processMemory(memory);
          this.logger.debug('[Memory] Graph extraction complete:', {
            memoryId,
            entities: graphResult.entitiesCreated + graphResult.entitiesUpdated,
            relationships: graphResult.relationshipsCreated,
            mentions: graphResult.mentionsCreated,
            ms: graphResult.processingTimeMs,
          });
        }
      } catch (graphError) {
        this.logger.warn(
          `[Memory] Graph extraction failed for ${memoryId} — continuing without graph data:`,
          graphError instanceof Error ? graphError.message : graphError,
        );
      }
    }

    // 9. Process hierarchical embeddings (fire-and-forget — escape inherited tx)
    if (this.hierarchyService?.isEnabled()) {
      const hierarchy = this.hierarchyService;
      void rlsContext.run(undefined as any, () =>
        hierarchy.processMemory(memoryId, raw, userId).catch((err) => {
          this.logger.error(
            `[Memory] Hierarchy processing failed for ${memoryId}: ${err instanceof Error ? err.message : err}`,
          );
        }),
      );
    }
  }

  /**
   * Phase 2: Generate embedding with retry queue on failure (HEY-345).
   * If embedding fails, the memory is added to an in-memory retry queue.
   */
  async generateAndStoreEmbedding(
    memoryId: string,
    raw: string,
    userId: string,
  ): Promise<boolean> {
    try {
      const embedding = await this.embedding.generate(raw);
      const embeddingId = await this.embedding.store(memoryId, embedding);
      this.logger.debug('[Memory] Embedding stored:', {
        memoryId,
        embeddingId,
      });

      await this.prisma.memory.update({
        where: { id: memoryId },
        data: { embeddingId, embeddingStatus: 'COMPLETE' },
      });

      // Link to related memories
      await this.linkRelatedMemories(memoryId, embedding, userId);

      // Remove from retry queue if it was there
      this.embeddingRetryQueue.delete(memoryId);
      return true;
    } catch (embedError) {
      const msg =
        embedError instanceof Error ? embedError.message : String(embedError);
      this.logger.warn(
        `[Memory] Embedding failed for ${memoryId} — queued for retry: ${msg}`,
      );

      // Mark as FAILED in DB
      try {
        await this.prisma.memory.update({
          where: { id: memoryId },
          data: { embeddingStatus: 'FAILED' },
        });
      } catch (e) {
        this.logger.warn(
          `[Memory] Could not update embeddingStatus for ${memoryId}:`,
          e instanceof Error ? e.message : e,
        );
      }

      // Add to retry queue
      const existing = this.embeddingRetryQueue.get(memoryId);
      this.embeddingRetryQueue.set(memoryId, {
        memoryId,
        userId,
        raw,
        attempts: (existing?.attempts ?? 0) + 1,
        lastAttempt: new Date(),
      });
      return false;
    }
  }

  /**
   * Retry failed embeddings (HEY-345), bounded per call (ENG-61).
   *
   * Single-flight: a call made while a previous retry run is still going is a
   * no-op (`skipped: true`). Before ENG-61 every 5-minute cron tick started a
   * new unbounded loop over every PENDING/FAILED row; the loops piled up in
   * each process and starved the BullMQ `memory-embedding` jobs of local
   * embed slots ("Local embedding admission timed out").
   *
   * Bounded: each run discovers at most `EMBEDDING_RETRY_BATCH_SIZE` rows
   * (keyset cursor across runs, newest first) and stops attempting new
   * embeddings once `EMBEDDING_RETRY_TIME_BUDGET_MS` has elapsed.
   */
  async retryFailedEmbeddings(): Promise<EmbeddingRetryResult> {
    if (this.retryInFlight) {
      this.logger.debug(
        '[Retry] Previous embedding retry still running — skipping',
      );
      return {
        retried: 0,
        succeeded: 0,
        failed: 0,
        discovered: 0,
        exhaustedRetries: 0,
        skipped: true,
      };
    }
    this.retryInFlight = true;
    try {
      return await this.runEmbeddingRetry();
    } finally {
      this.retryInFlight = false;
    }
  }

  private async runEmbeddingRetry(): Promise<EmbeddingRetryResult> {
    const batchSize = readPositiveIntEnv(
      'EMBEDDING_RETRY_BATCH_SIZE',
      DEFAULT_EMBEDDING_RETRY_BATCH_SIZE,
    );
    const budgetMs = readPositiveIntEnv(
      'EMBEDDING_RETRY_TIME_BUDGET_MS',
      DEFAULT_EMBEDDING_RETRY_TIME_BUDGET_MS,
    );
    const deadline = Date.now() + budgetMs;

    const isRetryable = (e: EmbeddingRetryEntry) =>
      e.attempts < MemoryPipelineService.MAX_RETRY_ATTEMPTS;

    // 1. Discover unembedded memories from DB: one bounded page per run, only
    //    enough to keep at most `batchSize` retryable entries queued.
    let retryable = 0;
    for (const entry of this.embeddingRetryQueue.values()) {
      if (isRetryable(entry)) retryable++;
    }
    let discovered = 0;
    const room = batchSize - retryable;
    if (room > 0) {
      const cursor = this.retryDiscoveryCursor;
      const unembedded = await this.prisma.memory.findMany({
        where: {
          AND: [
            {
              OR: [
                { embeddingId: null },
                { embeddingStatus: 'FAILED' },
                { embeddingStatus: 'PENDING' },
              ],
            },
            ...(cursor
              ? [
                  {
                    OR: [
                      { createdAt: { lt: cursor.createdAt } },
                      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                    ],
                  },
                ]
              : []),
          ],
          deletedAt: null,
        },
        select: { id: true, userId: true, raw: true, createdAt: true },
        take: room,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      // Wrap to the newest rows once the walk reaches the oldest.
      const last = unembedded[unembedded.length - 1];
      this.retryDiscoveryCursor =
        unembedded.length < room || !last
          ? null
          : { createdAt: last.createdAt, id: last.id };
      for (const mem of unembedded) {
        if (!this.embeddingRetryQueue.has(mem.id)) {
          this.embeddingRetryQueue.set(mem.id, {
            memoryId: mem.id,
            userId: mem.userId,
            raw: mem.raw,
            attempts: 0,
            lastAttempt: new Date(0),
          });
          discovered++;
        }
      }
    }

    // 2. Drop entries another path (e.g. the BullMQ embedding job) has already
    //    embedded, so the retry never re-embeds finished work.
    const candidates = Array.from(this.embeddingRetryQueue.values())
      .filter(isRetryable)
      .slice(0, batchSize);
    if (candidates.length > 0) {
      const stillUnembedded = await this.prisma.memory.findMany({
        where: {
          id: { in: candidates.map((c) => c.memoryId) },
          deletedAt: null,
          OR: [
            { embeddingId: null },
            { embeddingStatus: 'FAILED' },
            { embeddingStatus: 'PENDING' },
          ],
        },
        select: { id: true },
      });
      const open = new Set(stillUnembedded.map((m) => m.id));
      for (const c of candidates) {
        if (!open.has(c.memoryId)) this.embeddingRetryQueue.delete(c.memoryId);
      }
    }

    // 3. Retry sequentially within the time budget.
    let retried = 0;
    let succeeded = 0;
    let failed = 0;
    let budgetExhausted = false;
    for (const entry of candidates) {
      if (!this.embeddingRetryQueue.has(entry.memoryId)) continue;
      if (Date.now() >= deadline) {
        budgetExhausted = true;
        break;
      }
      retried++;
      const ok = await this.generateAndStoreEmbedding(
        entry.memoryId,
        entry.raw,
        entry.userId,
      );
      if (ok) {
        succeeded++;
      } else {
        failed++;
      }
    }

    let exhaustedRetries = 0;
    for (const entry of this.embeddingRetryQueue.values()) {
      if (!isRetryable(entry)) exhaustedRetries++;
    }

    if (exhaustedRetries > 0) {
      this.logger.error({
        event: 'embedding_retry.dead_letter',
        exhaustedRetries,
        maxRetryAttempts: MemoryPipelineService.MAX_RETRY_ATTEMPTS,
        message: `${exhaustedRetries} memories have exhausted all embedding retry attempts and will never be searchable`,
      });
    }

    this.logger.log(
      `[Retry] Embedding retry complete: ${succeeded}/${retried} succeeded, ${discovered} discovered from DB, ${exhaustedRetries} exhausted${budgetExhausted ? ', time budget reached' : ''}`,
    );
    return { retried, succeeded, failed, discovered, exhaustedRetries };
  }

  /**
   * Get embedding status counts (HEY-345).
   */
  async getEmbeddingStatus(userId?: string): Promise<{
    withEmbedding: number;
    withoutEmbedding: number;
    failedEmbedding: number;
    pendingEmbedding: number;
    retryQueueSize: number;
    exhaustedRetries: number;
  }> {
    const baseWhere: any = { deletedAt: null };
    if (userId) baseWhere.userId = userId;

    const [withEmbedding, withoutEmbedding, failedEmbedding, pendingEmbedding] =
      await Promise.all([
        this.prisma.memory.count({
          where: { ...baseWhere, embeddingStatus: 'COMPLETE' },
        }),
        this.prisma.memory.count({
          where: { ...baseWhere, embeddingId: null },
        }),
        this.prisma.memory.count({
          where: { ...baseWhere, embeddingStatus: 'FAILED' },
        }),
        this.prisma.memory.count({
          where: { ...baseWhere, embeddingStatus: 'PENDING' },
        }),
      ]);

    const retryQueueSize = this.embeddingRetryQueue.size;
    let exhaustedRetries = 0;
    for (const entry of this.embeddingRetryQueue.values()) {
      if (entry.attempts >= MemoryPipelineService.MAX_RETRY_ATTEMPTS) {
        exhaustedRetries++;
      }
    }

    return {
      withEmbedding,
      withoutEmbedding,
      failedEmbedding,
      pendingEmbedding,
      retryQueueSize,
      exhaustedRetries,
    };
  }

  /**
   * Store extracted entities and link them to the memory
   */
  async storeEntities(
    userId: string,
    memoryId: string,
    entities: EntityWithType[],
  ): Promise<void> {
    for (const entity of entities) {
      try {
        const normalizedName = entity.name.toLowerCase().trim();

        const upsertedEntity = await this.prisma.entity.upsert({
          where: {
            userId_normalizedName_type: {
              userId,
              normalizedName,
              type: entity.type,
            },
          },
          create: {
            userId,
            name: entity.name,
            normalizedName,
            type: entity.type,
          },
          update: {},
        });

        const entityId = upsertedEntity.id;

        await this.prisma.memoryEntity.upsert({
          where: {
            memoryId_entityId: { memoryId, entityId },
          },
          create: { memoryId, entityId },
          update: {},
        });

        // HEY-358: Sync Entity → GraphEntity mapping layer
        // Keep both entity systems in sync until full unification
        try {
          const graphType = this.mapToGraphEntityType(entity.type);
          await this.prisma.graphEntity.upsert({
            where: {
              userId_name_type: {
                userId,
                name: entity.name,
                type: graphType,
              },
            },
            create: {
              userId,
              name: entity.name,
              type: graphType,
              mentionCount: 1,
              firstSeenMemoryId: memoryId,
            },
            update: {
              mentionCount: { increment: 1 },
            },
          });

          // Also create a GraphEntityMention
          const graphEntity = await this.prisma.graphEntity.findUnique({
            where: {
              userId_name_type: {
                userId,
                name: entity.name,
                type: graphType,
              },
            },
            select: { id: true },
          });
          if (graphEntity) {
            await this.prisma.graphEntityMention.upsert({
              where: {
                entityId_memoryId: {
                  entityId: graphEntity.id,
                  memoryId,
                },
              },
              create: {
                entityId: graphEntity.id,
                memoryId,
                userId,
                role: 'REFERENCE',
              },
              update: {},
            });
          }
        } catch (syncError) {
          // Don't fail the pipeline if graph sync fails
          this.logger.debug(
            `[Entity→GraphEntity sync] Failed for ${entity.name}: ${syncError instanceof Error ? syncError.message : syncError}`,
          );
        }
      } catch (error) {
        this.logger.error(`Failed to store entity ${entity.name}:`, error);
      }
    }

    // ENG-50: Create IDENTITY memories for person/org entities (fire-and-forget)
    if (this.entityMemory) {
      for (const entity of entities) {
        this.entityMemory
          .ensureEntityMemory({ name: entity.name, type: entity.type, userId })
          .catch((err) =>
            this.logger.warn(
              `Failed to ensure entity memory for ${entity.name}: ${err instanceof Error ? err.message : err}`,
            ),
          );
      }
    }
  }

  /**
   * HEY-358: Map Entity type string to GraphEntityType enum.
   * Entity uses free-form strings; GraphEntity uses a fixed enum.
   */
  private mapToGraphEntityType(type: string): any {
    const mapping: Record<string, string> = {
      PERSON: 'PERSON',
      PLACE: 'PLACE',
      LOCATION: 'PLACE',
      ORGANIZATION: 'ORGANIZATION',
      ORG: 'ORGANIZATION',
      CONCEPT: 'CONCEPT',
      TOPIC: 'CONCEPT',
      EVENT: 'EVENT',
      OBJECT: 'OBJECT',
      THING: 'OBJECT',
      TIME: 'TIME',
      DATE: 'TIME',
    };
    return mapping[type.toUpperCase()] || 'UNKNOWN';
  }

  /**
   * Link this memory to related memories based on embedding similarity
   */
  async linkRelatedMemories(
    memoryId: string,
    embedding: number[],
    userId: string,
  ): Promise<void> {
    try {
      const similar = await this.embedding.search(userId, embedding, 10);

      const related = similar.filter(
        (m) =>
          m.id !== memoryId &&
          m.score >= RELATED_SIMILARITY_THRESHOLD &&
          m.score < DEDUP_SIMILARITY_THRESHOLD,
      );

      if (related.length > 0) {
        this.logger.debug(
          `[linkRelatedMemories] Memory ${memoryId}: found ${related.length} linkable memories (scores: ${related.map((r) => r.score.toFixed(3)).join(', ')})`,
        );
      }

      let linksCreated = 0;
      for (const match of related) {
        try {
          await this.prisma.memoryChainLink.upsert({
            where: {
              sourceId_targetId_linkType: {
                sourceId: memoryId,
                targetId: match.id,
                linkType: 'RELATED',
              },
            },
            create: {
              sourceId: memoryId,
              targetId: match.id,
              linkType: 'RELATED',
              confidence: match.score,
              createdBy: 'system',
            },
            update: {
              confidence: match.score,
            },
          });
          linksCreated++;
        } catch (error) {
          this.logger.debug(
            `[linkRelatedMemories] Link skipped (may exist): ${memoryId} -> ${match.id}`,
          );
        }
      }

      if (linksCreated > 0) {
        this.logger.debug(
          `[linkRelatedMemories] Memory ${memoryId}: created ${linksCreated} links`,
        );
      }
    } catch (error) {
      this.logger.error(
        '[linkRelatedMemories] Failed to link related memories:',
        error,
      );
    }
  }

  /**
   * Promote a LESSON memory to CONSTRAINT
   */
  async promoteToConstraint(memoryId: string): Promise<void> {
    await this.prisma.memory.update({
      where: { id: memoryId },
      data: {
        memoryType: 'CONSTRAINT',
        priority: 1,
        promotedFrom: memoryId,
      },
    });
    this.logger.log(
      `[LESSON→CONSTRAINT] Auto-promoted critical lesson: ${memoryId}`,
    );
  }
}
