import * as crypto from 'crypto';
import {
  Injectable,
  Inject,
  Optional,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  MemoryCreatedEvent,
  MemoryUpdatedEvent,
  MemoryDeletedEvent,
} from '../events/event-types';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractionService, ExtractionContext } from './extraction.service';
import { EmbeddingService } from './embedding.service';
import { ImportanceService } from './importance.service';
import { TemporalParserService } from './temporal/temporal-parser.service';
import { CreateMemoryDto, CreateMemoryBatchDto } from './dto/create-memory.dto';
import {
  ExportedMemory,
  ImportMemoryItemDto,
  ImportResult,
} from './dto/export-import.dto';
import {
  BulkCreateMemoryDto,
  BulkCreateResult,
  BulkTextImportDto,
  BulkTextResult,
} from './dto/bulk.dto';
import { QueryMemoryDto, LoadContextDto } from './dto/query-memory.dto';
import { UpdateMemoryDto, CorrectMemoryDto } from './dto/update-memory.dto';
import { Memory, MemoryLayer, MemorySource, MemoryDurability, SubjectType } from '@prisma/client';
import { parseFlexibleDate } from '../utils/date-parser';
import { CorrectionService } from '../correction/correction.service';
import {
  MultiQueryMetadataDto,
  ResultExplanationDto,
} from '../multi-query/dto/multi-query.dto';
import { MemoryPoolService } from '../memory-pool/memory-pool.service';
import { generateContentHash } from '../common/content-hash.util';
import { MemoryAccessLogService } from '../memory-access-log/memory-access-log.service';

// Extracted services
import { MemoryDedupService, SOURCE_CONFIDENCE } from './memory-dedup.service';
import { MemoryQueryService } from './memory-query.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import { EmbeddingQueueProducer } from './embedding-queue.producer';
import { rlsContext } from '../prisma/rls-context';
import { MemoryGraphService } from './memory-graph.service';
import { MemoryExportService } from './memory-export.service';
import { HypeService } from './hype.service';
import { DurabilityClassifierService } from './durability-classifier.service';

// Re-export types for backward compatibility
export type {
  MemoryWithExtraction,
  MemoryWithScore,
  QueryResult,
  ContextResult,
} from './memory.types';
import {
  MemoryWithExtraction,
  MemoryWithScore,
  QueryResult,
  ContextResult,
} from './memory.types';

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  constructor(
    private prisma: PrismaService,
    private extraction: ExtractionService,
    private embedding: EmbeddingService,
    private importance: ImportanceService,
    private temporalParser: TemporalParserService,
    private dedupService: MemoryDedupService,
    private queryService: MemoryQueryService,
    private pipelineService: MemoryPipelineService,
    private graphService: MemoryGraphService,
    private exportService: MemoryExportService,
    @Optional() private durabilityClassifier?: DurabilityClassifierService,
    @Optional() private correctionService?: CorrectionService,
    @Optional() private memoryPoolService?: MemoryPoolService,
    @Optional() private memoryAccessLogService?: MemoryAccessLogService,
    @Optional() private eventEmitter?: EventEmitter2,
    @Optional() private readonly embeddingQueue?: EmbeddingQueueProducer,
    @Optional() private readonly hypeService?: HypeService,
  ) {}

  /**
   * Run a fire-and-forget callback with a fresh RLS-aware transaction context.
   * This ensures background ops (extraction, embedding, etc.) that outlive the
   * HTTP request still respect tenant isolation instead of bypassing RLS.
   */
  private runWithRls(
    accountId: string | undefined,
    fn: () => Promise<void>,
  ): void {
    if (!accountId) {
      // No account context (self-hosted / LAN mode) — run without RLS
      fn().catch((err) =>
        this.logger.error('[Memory] Background op failed:', err),
      );
      return;
    }
    const sanitized = accountId.replace(/[^a-zA-Z0-9_-]/g, '');
    this.prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_account_id = '${sanitized}'`,
        );
        await rlsContext.run(tx as any, () => fn());
      })
      .catch((err) =>
        this.logger.error('[Memory] Background RLS op failed:', err),
      );
  }

  /**
   * Create a single memory
   */
  async remember(
    userId: string,
    dto: CreateMemoryDto,
  ): Promise<MemoryWithExtraction> {
    const rawContent = dto.raw || (dto as any).content;
    if (!rawContent) {
      throw new Error(
        'Memory content is required (use "raw" or "content" field)',
      );
    }

    // 1. Fetch user info for extraction context
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        externalId: true,
        displayName: true,
        accountId: true,
      },
    });
    const accountId = user?.accountId ?? undefined;

    // 2. Determine source type
    const source = dto.source ?? MemorySource.EXPLICIT_STATEMENT;

    // 3. [HEY-462] Dedup now runs async in EmbeddingQueueProcessor — skipped on hot path

    // 4. Calculate initial importance score
    const importanceScore = this.importance.calculate({
      hint: dto.importanceHint,
      layer: dto.layer as any,
    });

    // 5. Set confidence based on source type
    const confidence = SOURCE_CONFIDENCE[source] ?? 1.0;

    // 6. Resolve sessionId
    const sessionId = await this.resolveSessionId(
      userId,
      dto.context?.sessionId,
    );

    // 7a. Determine layer
    let layer = dto.layer;
    if (!layer) {
      layer = this.extraction.classifyLayer(rawContent);
      this.logger.log('[Memory] Smart layer classification:', {
        rawPreview: rawContent.substring(0, 50),
        layer,
      });
    }

    // 7b. Determine subject fields
    const subjectType = dto.subjectType ?? SubjectType.USER;
    const subjectId =
      dto.subjectId ??
      (subjectType === SubjectType.USER ? userId : dto.agentId);

    // 7. Create memory record
    const contentHash = generateContentHash(rawContent);
    const memory = await this.prisma.memory.create({
      data: {
        userId,
        raw: rawContent,
        layer: layer as any,
        source: source as any,
        importanceHint: dto.importanceHint,
        importanceScore,
        confidence,
        projectId: dto.context?.projectId,
        sessionId,
        subjectType: subjectType as any,
        subjectId,
        agentId: dto.agentId,
        createdBySession: dto.agentSessionKey ?? undefined,
        visibility: (dto.visibility ?? 'PRIVATE') as any,
        contentHash,
      },
    });

    // HyPE: generate hypothetical prompt embeddings (fire-and-forget)
    if (this.hypeService) {
      setImmediate(() => {
        this.hypeService
          ?.generateAndStore(memory.id, rawContent, userId)
          .catch((err) =>
            this.logger.warn(`[HyPE] Failed: ${err.message}`),
          );
      });
    }

    // v0.7: Auto-add to global pool and log creation
    if (dto.agentSessionKey) {
      this.addToGlobalPoolAndLog(memory.id, userId, dto.agentSessionKey).catch(
        (err) => {
          this.logger.error(
            `[Memory] Failed to add to global pool / log creation for ${memory.id}:`,
            err,
          );
        },
      );
    }

    // v0.9: Pool-scoped memory write
    if (dto.poolId && this.memoryPoolService) {
      this.memoryPoolService
        .addMemory(dto.poolId, {
          memoryId: memory.id,
          addedBy: dto.agentSessionKey ?? 'system',
        })
        .catch((err) => {
          this.logger.error(
            `[Memory] Failed to add memory ${memory.id} to pool ${dto.poolId}:`,
            err,
          );
        });
    }

    // 8. Build extraction context
    const extractionContext: ExtractionContext = {
      userId,
      userName: user?.displayName || user?.externalId,
      timestamp: dto.sourceTimestamp ?? new Date(),
      turnIndex: dto.sourceTurnIndex,
      conversationId: dto.context?.sessionId,
    };

    // 9. Extract structure asynchronously (with fresh RLS context)
    if (this.embeddingQueue) {
      await this.embeddingQueue.enqueueEmbedding({
        memoryId: memory.id,
        userId,
        raw: rawContent,
        runDedup: true,
      });
    } else {
      this.runWithRls(accountId, () =>
        this.pipelineService.extractAndEmbed(
          memory.id,
          rawContent,
          userId,
          extractionContext,
        ),
      );
    }

    // 10a. Increment account memoriesUsed
    this.runWithRls(accountId, () => this.incrementMemoriesUsed(userId, 1));

    // 10. Emit memory.created event
    this.emitEvent(
      'memory.created',
      new MemoryCreatedEvent(
        memory.id,
        memory.layer,
        importanceScore,
        [],
        userId,
        rawContent.substring(0, 200),
      ),
    );

    // 10b. ENG-31: Classify durability (fire-and-forget, non-blocking)
    if (this.durabilityClassifier) {
      const classifier = this.durabilityClassifier;
      setImmediate(() => {
        const durability = classifier.classify(rawContent);
        this.prisma.memory
          .update({
            where: { id: memory.id },
            data: { durability, durabilityClassifiedAt: new Date() },
          })
          .catch((err) =>
            this.logger.error(
              `[Memory] Durability classification failed for ${memory.id}:`,
              err,
            ),
          );
      });
    }

    // 11. Check for contradictions
    if (this.correctionService) {
      this.runWithRls(accountId, async () => {
        await this.correctionService!.checkForContradictions(
          memory.id,
          userId,
          rawContent,
        );
      });
    }

    return memory;
  }

  /**
   * v0.7: Add memory to global pool and log creation
   */
  private async addToGlobalPoolAndLog(
    memoryId: string,
    userId: string,
    agentSessionKey: string,
  ): Promise<void> {
    const globalPool = await this.prisma.memoryPool.findFirst({
      where: { userId, name: 'global', visibility: 'GLOBAL', archivedAt: null },
      select: { id: true },
    });
    if (globalPool) {
      try {
        await this.prisma.memoryPoolMembership.create({
          data: {
            memoryId,
            poolId: globalPool.id,
            addedBy: agentSessionKey,
          },
        });
      } catch (err: any) {
        if (!err?.code?.includes('P2002')) throw err;
      }
    }

    if (this.memoryAccessLogService) {
      this.memoryAccessLogService
        .logCreated(memoryId, agentSessionKey)
        .catch(() => {});
    }
  }

  /**
   * Create multiple memories in batch
   */
  async rememberAll(
    userId: string,
    dto: CreateMemoryBatchDto,
  ): Promise<{ created: number; failed: number }> {
    let created = 0;
    let failed = 0;

    for (const item of dto.memories) {
      try {
        await this.remember(userId, {
          raw: item.raw,
          layer: item.layer,
          importanceHint: item.importanceHint,
          context: dto.context,
        });
        created++;
      } catch (err) {
        this.logger.error('Batch create failed:', err);
        failed++;
      }
    }

    return { created, failed };
  }

  /**
   * Bulk create memories using createMany for fast Postgres insertion,
   * then queue embeddings asynchronously via EmbeddingQueueProducer.
   */
  async bulkCreate(
    userId: string,
    dto: BulkCreateMemoryDto,
  ): Promise<BulkCreateResult> {
    const memoryIds: string[] = [];
    const now = new Date();

    const data = dto.memories.map((item) => {
      const id = crypto.randomUUID();
      memoryIds.push(id);

      const layer =
        item.layer &&
        Object.values(MemoryLayer).includes(item.layer as MemoryLayer)
          ? (item.layer as MemoryLayer)
          : this.extraction.classifyLayer(item.raw);

      const importanceScore = this.importance.calculate({
        hint: item.importanceHint,
        layer: layer as any,
      });

      return {
        id,
        userId,
        raw: item.raw,
        layer: layer as any,
        source: (item.source as any) ?? MemorySource.EXPLICIT_STATEMENT,
        importanceHint: item.importanceHint ?? undefined,
        importanceScore,
        confidence: 1.0,
        contentHash: generateContentHash(item.raw),
        projectId: dto.context?.projectId ?? null,
        sessionId: dto.context?.sessionId ?? null,
        agentId: dto.agentId ?? null,
        metadata: item.metadata ?? undefined,
        createdAt: now,
        updatedAt: now,
      };
    });

    // Batch insert via createMany for performance
    await this.prisma.memory.createMany({ data });

    // Queue embedding jobs asynchronously
    if (this.embeddingQueue) {
      for (const record of data) {
        this.embeddingQueue
          .enqueueEmbedding({
            memoryId: record.id,
            userId,
            raw: record.raw,
            runDedup: true,
          })
          .catch((err) => {
            this.logger.error(
              `[BulkCreate] Failed to enqueue embedding for ${record.id}:`,
              err,
            );
          });
      }
    }

    // Increment account memoriesUsed
    this.incrementMemoriesUsed(userId, memoryIds.length).catch((err) => {
      this.logger.error(
        '[BulkCreate] Failed to increment memoriesUsed:',
        err,
      );
    });

    return { created: memoryIds.length, memoryIds };
  }

  /**
   * Accept raw text, auto-chunk at ~chunkSize chars on paragraph boundaries,
   * then bulk-insert all chunks.
   */
  async bulkTextImport(
    userId: string,
    dto: BulkTextImportDto,
  ): Promise<BulkTextResult> {
    const chunkSize = dto.chunkSize ?? 3500;
    const chunks = this.chunkText(dto.text, chunkSize);

    const bulkDto: BulkCreateMemoryDto = {
      memories: chunks.map((chunk) => ({
        raw: chunk,
        layer: dto.layer,
      })),
      context: dto.context,
    };

    const result = await this.bulkCreate(userId, bulkDto);
    return {
      created: result.created,
      chunks: chunks.length,
      memoryIds: result.memoryIds,
    };
  }

  /**
   * Split text into chunks of approximately `targetSize` characters,
   * breaking on paragraph boundaries (double newlines), then sentence
   * boundaries (. ! ?), to keep chunks semantically coherent.
   */
  private chunkText(text: string, targetSize: number): string[] {
    if (text.length <= targetSize) {
      return [text.trim()];
    }

    const paragraphs = text.split(/\n\s*\n/);
    const chunks: string[] = [];
    let current = '';

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      if (!trimmed) continue;

      // If adding this paragraph stays under target, append it
      if (current.length + trimmed.length + 2 <= targetSize) {
        current = current ? current + '\n\n' + trimmed : trimmed;
        continue;
      }

      // If current chunk has content, push it
      if (current) {
        chunks.push(current);
        current = '';
      }

      // If a single paragraph exceeds target, split on sentences
      if (trimmed.length > targetSize) {
        const sentences = trimmed.match(/[^.!?]+[.!?]+\s*/g) || [trimmed];
        for (const sentence of sentences) {
          if (current.length + sentence.length <= targetSize) {
            current = current ? current + sentence : sentence;
          } else {
            if (current) chunks.push(current.trim());
            current = sentence;
          }
        }
      } else {
        current = trimmed;
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    return chunks;
  }

  /**
   * Export memories with filters, supporting JSON/CSV/NDJSON format.
   * Returns cursor-paginated batches for streaming.
   */
  async exportMemoriesFiltered(
    userId: string,
    filters: {
      layer?: string;
      projectId?: string;
      startDate?: string;
      endDate?: string;
    },
    take: number,
    cursor?: string,
  ): Promise<ExportedMemory[]> {
    const where: any = { userId, deletedAt: null };
    if (filters.layer) where.layer = filters.layer;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = new Date(filters.startDate);
      if (filters.endDate) where.createdAt.lte = new Date(filters.endDate);
    }

    const memories = await this.prisma.memory.findMany({
      where,
      include: { extraction: true },
      orderBy: { createdAt: 'asc' },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    return memories.map((m) => ({
      id: m.id,
      raw: m.raw,
      layer: m.layer,
      importance: m.importanceScore,
      tags: (m as any).extraction?.topics ?? [],
      metadata: {
        source: m.source,
        confidence: m.confidence,
        subjectType: m.subjectType,
        subjectId: m.subjectId,
        projectId: m.projectId,
        sessionId: m.sessionId,
      },
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      graph: { entities: [], relationships: [] },
    }));
  }

  /**
   * Semantic search for memories — delegates to MemoryQueryService
   */
  async recall(
    userId: string | string[],
    dto: QueryMemoryDto,
  ): Promise<QueryResult> {
    return this.queryService.recall(userId, dto);
  }

  /**
   * Load context for session start — delegates to MemoryQueryService
   */
  async loadContext(
    userId: string,
    dto: LoadContextDto,
  ): Promise<ContextResult> {
    return this.queryService.loadContext(userId, dto);
  }

  /**
   * Verify memory ownership. Throws if not found or not owned by userId.
   */
  private async verifyOwnership(
    memoryId: string,
    userId: string,
    accountUserIds?: string[],
  ): Promise<void> {
    const memory = await this.prisma.memory.findUnique({
      where: { id: memoryId },
      select: { userId: true },
    });
    if (!memory) {
      throw new NotFoundException(`Memory not found: ${memoryId}`);
    }
    // Allow if the memory belongs to any user under the same account
    const allowedIds = accountUserIds ?? [userId];
    if (!allowedIds.includes(memory.userId)) {
      throw new ForbiddenException(
        'Access denied: Memory belongs to another user',
      );
    }
  }

  /**
   * Mark a memory as used
   */
  async markUsed(memoryId: string, userId?: string): Promise<void> {
    if (userId) {
      await this.verifyOwnership(memoryId, userId);
    }
    await this.prisma.memory.update({
      where: { id: memoryId },
      data: {
        usedCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
  }

  /**
   * Get a single memory by ID (with ownership check)
   */
  async getById(
    memoryId: string,
    userId?: string,
    accountUserIds?: string[],
    accountId?: string,
  ): Promise<MemoryWithExtraction | null> {
    const memory = await this.prisma.memory.findUnique({
      where: { id: memoryId },
      include: { extraction: true },
    });
    if (!memory) return null;
    // Account-level access: if the request carries an accountId, the caller
    // has already been authenticated as belonging to this account.
    // Allow access to any memory without per-user checks — the account
    // owns all its data regardless of which internal userId created it.
    if (accountId) {
      return memory;
    }
    // Per-user access fallback (no account context)
    const allowedIds = accountUserIds || (userId ? [userId] : []);
    if (allowedIds.length > 0 && !allowedIds.includes(memory.userId)) {
      throw new ForbiddenException(
        'Access denied: Memory belongs to another user',
      );
    }
    return memory;
  }

  /**
   * Soft delete a memory (with ownership check)
   */
  async delete(
    memoryId: string,
    userId?: string,
    accountUserIds?: string[],
  ): Promise<void> {
    if (userId) {
      await this.verifyOwnership(memoryId, userId, accountUserIds);
    }
    await this.prisma.memory.update({
      where: { id: memoryId },
      data: { deletedAt: new Date() },
    });

    // Decrement account memoriesUsed
    if (userId) {
      this.incrementMemoriesUsed(userId, -1).catch((err) => {
        this.logger.error(`[Memory] Failed to decrement memoriesUsed:`, err);
      });
    }

    this.emitEvent(
      'memory.deleted',
      new MemoryDeletedEvent(memoryId, userId ?? 'unknown'),
    );
  }

  /**
   * Update an existing memory
   */
  async update(
    userId: string,
    memoryId: string,
    dto: UpdateMemoryDto,
  ): Promise<MemoryWithExtraction> {
    // 1. Fetch memory and verify ownership
    const memory = await this.prisma.memory.findUnique({
      where: { id: memoryId },
      include: {
        extraction: true,
        user: { select: { id: true, externalId: true, displayName: true } },
      },
    });

    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    if (memory.userId !== userId) {
      throw new Error(`Access denied: Memory belongs to another user`);
    }

    if (memory.deletedAt) {
      throw new Error(`Cannot update deleted memory: ${memoryId}`);
    }

    // 2. Check if content changed
    const contentChanged = dto.raw && dto.raw !== memory.raw;

    // 3. Update memory record
    const updateData: any = {
      ...(dto.raw && { raw: dto.raw }),
      ...(dto.layer && { layer: dto.layer }),
      ...(dto.importanceHint && { importanceHint: dto.importanceHint }),
      ...(dto.importanceScore !== undefined && {
        importanceScore: dto.importanceScore,
      }),
    };

    if (dto.importanceHint && dto.importanceScore === undefined) {
      updateData.importanceScore = this.importance.calculate({
        hint: dto.importanceHint,
        layer: (dto.layer ?? memory.layer) as any,
      });
    }

    const updated = await this.prisma.memory.update({
      where: { id: memoryId },
      data: updateData,
      include: { extraction: true },
    });

    this.emitEvent(
      'memory.updated',
      new MemoryUpdatedEvent(memoryId, updateData, userId),
    );

    // 4. Update extraction fields if provided
    if (dto.extraction && memory.extraction) {
      const extractionUpdate: any = {};

      if (dto.extraction.who !== undefined)
        extractionUpdate.who = dto.extraction.who;
      if (dto.extraction.what !== undefined)
        extractionUpdate.what = dto.extraction.what;
      if (dto.extraction.where !== undefined)
        extractionUpdate.whereCtx = dto.extraction.where;
      if (dto.extraction.why !== undefined)
        extractionUpdate.why = dto.extraction.why;
      if (dto.extraction.how !== undefined)
        extractionUpdate.how = dto.extraction.how;
      if (dto.extraction.topics !== undefined)
        extractionUpdate.topics = dto.extraction.topics;

      if (dto.extraction.when !== undefined) {
        if (dto.extraction.when === null) {
          extractionUpdate.when = null;
        } else {
          extractionUpdate.when = parseFlexibleDate(
            dto.extraction.when,
            new Date(),
          );
        }
      }

      if (Object.keys(extractionUpdate).length > 0) {
        await this.prisma.memoryExtraction.update({
          where: { memoryId },
          data: extractionUpdate,
        });
      }
    }

    // 5. Re-embed if content changed
    if (contentChanged && dto.raw) {
      this.logger.log(`[Memory] Content changed, re-embedding: ${memoryId}`);

      const embedding = await this.embedding.generate(dto.raw);
      await this.embedding.store(memoryId, embedding, {
        userId,
        layer: updated.layer,
        importance: updated.importanceScore,
      });

      await this.pipelineService.linkRelatedMemories(
        memoryId,
        embedding,
        userId,
      );

      const context: ExtractionContext = {
        userId,
        userName: (memory.user as any)?.displayName || memory.user?.externalId,
      };
      this.extraction
        .extract(dto.raw, context)
        .then(async (extracted) => {
          await this.prisma.memoryExtraction.update({
            where: { memoryId },
            data: {
              who: extracted.who,
              what: extracted.what,
              when: parseFlexibleDate(extracted.when, new Date()),
              whereCtx: extracted.where,
              why: extracted.why,
              how: extracted.how,
              topics: extracted.topics,
              extractedAt: new Date(),
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
          if (extracted.memoryType) {
            const priority = this.extraction.getPriorityForType(
              extracted.memoryType,
            );
            await this.prisma.memory.update({
              where: { id: memoryId },
              data: {
                memoryType: extracted.memoryType,
                typeConfidence: extracted.typeConfidence,
                priority,
              },
            });
          }

          // HEY-363: Re-extract entities when content changes
          if (extracted.entities?.length > 0) {
            await this.pipelineService.storeEntities(
              userId,
              memoryId,
              extracted.entities,
            );
            this.logger.log(
              `[Memory] Re-extracted ${extracted.entities.length} entities for ${memoryId}`,
            );
          }
        })
        .catch((err) => {
          this.logger.error(
            `[Memory] Re-extraction failed for ${memoryId}:`,
            err,
          );
        });
    }

    return this.getById(memoryId) as Promise<MemoryWithExtraction>;
  }

  /**
   * Correct a memory with contradiction tracking
   */
  async correctMemory(
    userId: string,
    memoryId: string,
    dto: CorrectMemoryDto,
  ): Promise<MemoryWithExtraction> {
    const original = await this.prisma.memory.findUnique({
      where: { id: memoryId },
      include: {
        user: {
          select: {
            id: true,
            externalId: true,
            displayName: true,
            accountId: true,
          },
        },
      },
    });
    const correctionAccountId =
      (original?.user as any)?.accountId ?? undefined;

    if (!original) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    if (original.userId !== userId) {
      throw new Error(`Access denied: Memory belongs to another user`);
    }

    if (original.deletedAt) {
      throw new Error(`Cannot correct deleted memory: ${memoryId}`);
    }

    if (original.supersededById) {
      throw new Error(
        `Memory already superseded by: ${original.supersededById}`,
      );
    }

    const correctionImportance = dto.importanceHint
      ? this.importance.calculate({
          hint: dto.importanceHint,
          layer: (dto.layer ?? original.layer) as any,
        })
      : Math.min(1.0, original.importanceScore + 0.1);

    const correction = await this.prisma.memory.create({
      data: {
        userId,
        raw: dto.correctedContent,
        layer: (dto.layer ?? original.layer) as any,
        source: MemorySource.CORRECTION,
        importanceHint:
          dto.importanceHint ?? original.importanceHint ?? undefined,
        importanceScore: correctionImportance,
        projectId: original.projectId,
        sessionId: original.sessionId,
      },
    });

    await this.prisma.memory.update({
      where: { id: memoryId },
      data: {
        supersededById: correction.id,
        supersededAt: new Date(),
      },
    });

    await this.prisma.memoryChainLink.create({
      data: {
        sourceId: correction.id,
        targetId: memoryId,
        linkType: 'CONTRADICTS',
        confidence: 1.0,
        createdBy: dto.reason ? `user:${dto.reason}` : 'user:correction',
      },
    });

    const context: ExtractionContext = {
      userId,
      userName:
        (original.user as any)?.displayName || original.user?.externalId,
    };
    this.runWithRls(correctionAccountId, () =>
      this.pipelineService.extractAndEmbed(
        correction.id,
        dto.correctedContent,
        userId,
        context,
      ),
    );

    // Increment memoriesUsed for the correction
    this.runWithRls(correctionAccountId, () =>
      this.incrementMemoriesUsed(userId, 1),
    );

    this.logger.log(
      `[Memory] Created correction: ${correction.id} supersedes ${memoryId}`,
    );

    return correction;
  }

  /**
   * Get graph data for visualization — delegates to MemoryGraphService
   */
  async getGraphData(
    userId: string,
    limit: number = 500,
    includeAgent: boolean = false,
  ) {
    return this.graphService.getGraphData(userId, limit, includeAgent);
  }

  /**
   * Increment (or decrement) memoriesUsed on the account that owns this user.
   * Resolves accountId via user → agent → account chain.
   */
  private async incrementMemoriesUsed(
    userId: string,
    delta: number,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { accountId: true },
    });
    const accountId = user?.accountId;
    if (!accountId) return;

    if (delta > 0) {
      await this.prisma.account.update({
        where: { id: accountId },
        data: { memoriesUsed: { increment: delta } },
      });
    } else {
      // Decrement but don't go below 0
      await this.prisma.$executeRawUnsafe(
        `UPDATE accounts SET memories_used = GREATEST(0, memories_used + $1) WHERE id = $2`,
        delta,
        accountId,
      );
    }
  }

  /**
   * Fire-and-forget event emission
   */
  private emitEvent(eventName: string, payload: any): void {
    try {
      this.eventEmitter?.emit(eventName, payload);
    } catch (err) {
      this.logger.error(`[Memory] Failed to emit ${eventName}:`, err);
    }
  }

  // =========================================================================
  // EXPORT / IMPORT — delegated to MemoryExportService (HEY-221)
  // =========================================================================

  async exportMemories(userId: string): Promise<ExportedMemory[]> {
    return this.exportService.exportMemories(userId);
  }

  async exportMemoriesBatch(
    userId: string,
    take: number,
    cursor?: string,
  ): Promise<ExportedMemory[]> {
    return this.exportService.exportMemoriesBatch(userId, take, cursor);
  }

  async importMemories(
    userId: string,
    items: ImportMemoryItemDto[],
  ): Promise<ImportResult> {
    return this.exportService.importMemories(userId, items);
  }

  /**
   * Resolve sessionId
   */
  private async resolveSessionId(
    userId: string,
    sessionId?: string,
  ): Promise<string | undefined> {
    if (!sessionId) return undefined;

    const existingById = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });
    if (existingById) return existingById.id;

    const existingByExternalId = await this.prisma.session.findFirst({
      where: {
        userId,
        externalId: sessionId,
      },
      select: { id: true },
    });
    if (existingByExternalId) return existingByExternalId.id;

    const newSession = await this.prisma.session.create({
      data: {
        userId,
        externalId: sessionId,
      },
    });
    return newSession.id;
  }
}
