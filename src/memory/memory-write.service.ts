import * as crypto from 'crypto';
import { Injectable, Optional, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MemoryCreatedEvent } from '../events/event-types';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractionService, ExtractionContext } from './extraction.service';
import { EmbeddingService } from './embedding.service';
import { ImportanceService } from './importance.service';
import { CreateMemoryDto, CreateMemoryBatchDto } from './dto/create-memory.dto';
import {
  BulkCreateMemoryDto,
  BulkCreateResult,
  BulkTextImportDto,
  BulkTextResult,
} from './dto/bulk.dto';
import {
  MemoryLayer,
  MemorySource,
  SubjectType,
} from '@prisma/client';
import { CorrectionService } from '../correction/correction.service';
import { MemoryPoolService } from '../memory-pool/memory-pool.service';
import { generateContentHash } from '../common/content-hash.util';
import { MemoryAccessLogService } from '../memory-access-log/memory-access-log.service';
import { SOURCE_CONFIDENCE } from './memory-dedup.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import { EmbeddingQueueProducer } from './embedding-queue.producer';
import { rlsContext } from '../prisma/rls-context';
import { HypeService } from './hype.service';
import { DurabilityClassifierService } from './durability-classifier.service';
import { MemoryWithExtraction } from './memory.types';
import { ElasticsearchService } from '../search/elasticsearch.service';

@Injectable()
export class MemoryWriteService {
  private readonly logger = new Logger(MemoryWriteService.name);

  constructor(
    private prisma: PrismaService,
    private extraction: ExtractionService,
    private embedding: EmbeddingService,
    private importance: ImportanceService,
    private pipelineService: MemoryPipelineService,
    private elasticsearchService: ElasticsearchService,
    @Optional() private correctionService?: CorrectionService,
    @Optional() private memoryPoolService?: MemoryPoolService,
    @Optional() private memoryAccessLogService?: MemoryAccessLogService,
    @Optional() private eventEmitter?: EventEmitter2,
    @Optional() private readonly embeddingQueue?: EmbeddingQueueProducer,
    @Optional() private readonly hypeService?: HypeService,
    @Optional() private durabilityClassifier?: DurabilityClassifierService,
  ) {}

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
        tags: dto.tags ?? [],
      },
    });

    // HyPE: generate hypothetical prompt embeddings (fire-and-forget)
    if (this.hypeService) {
      setImmediate(() => {
        this.hypeService
          ?.generateAndStore(memory.id, rawContent, userId)
          .catch((err) => this.logger.warn(`[HyPE] Failed: ${err.message}`));
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

    // 12. Index into Elasticsearch (fire-and-forget)
    setImmediate(() => {
      this.elasticsearchService
        .indexMemory({
          id: memory.id,
          content: rawContent,
          userId,
          agentId: memory.agentId ?? undefined,
          accountId,
          layer: memory.layer,
          source: memory.source,
          tags: (memory as any).tags ?? [],
          createdAt: memory.createdAt,
          updatedAt: memory.updatedAt,
        })
        .catch((err) =>
          this.logger.warn(
            `[Memory] ES index failed for ${memory.id}: ${(err as Error).message}`,
          ),
        );
    });

    return memory;
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
      this.logger.error('[BulkCreate] Failed to increment memoriesUsed:', err);
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
  chunkText(text: string, targetSize: number): string[] {
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
   * Resolve sessionId from DB or create new session
   */
  async resolveSessionId(
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

  /**
   * Run a fire-and-forget callback with a fresh RLS-aware transaction context.
   */
  private runWithRls(
    accountId: string | undefined,
    fn: () => Promise<void>,
  ): void {
    if (!accountId) {
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
   * Increment (or decrement) memoriesUsed on the account that owns this user.
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
}
