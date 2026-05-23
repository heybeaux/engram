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
import { MemoryLayer, MemorySource, SubjectType } from '@prisma/client';
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
import { TemporalGapMarkerService } from './temporal-gap-marker.service';

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
    @Optional()
    private readonly temporalGapMarker?: TemporalGapMarkerService,
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

    // 6b. ENG-131: Insert a temporal-gap marker before this memory if the
    // gap since the last memory for this agent/session exceeds the threshold.
    // Best-effort: failures here must not block the actual write.
    if (this.temporalGapMarker && dto.agentId) {
      try {
        await this.temporalGapMarker.maybeInsertMarker({
          userId,
          agentId: dto.agentId,
          sessionId,
          enqueueEmbedding: this.embeddingQueue
            ? (memoryId, raw) =>
                this.embeddingQueue!.enqueueEmbedding({
                  memoryId,
                  userId,
                  raw,
                  // Markers are deterministic anchors - no dedup needed.
                  runDedup: false,
                })
            : undefined,
        });
      } catch (err) {
        this.logger.warn(
          `[Memory] Temporal gap marker step failed (continuing): ${(err as Error).message}`,
        );
      }
    }

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
        sessionPosition: item.sessionPosition ?? null,
        createdAt: now,
        updatedAt: now,
      };
    });

    // Batch insert via createMany for performance
    const insertStart = Date.now();
    try {
      await this.prisma.memory.createMany({ data });
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      const txClosed = /transaction already closed|tx.*closed/i.test(message);
      this.logger.error({
        event: 'bulk_create.insert_failed',
        userId,
        chunkCount: data.length,
        transactionClosed: txClosed,
        error: message,
        stack: (err as Error)?.stack,
      });
      throw err;
    }
    this.logger.log({
      event: 'bulk_create.insert_complete',
      userId,
      chunkCount: data.length,
      elapsedMs: Date.now() - insertStart,
    });

    // Queue embedding jobs asynchronously
    const progressEvery = Math.max(
      50,
      parseInt(process.env.BULK_INGEST_LOG_EVERY ?? '100', 10),
    );
    let enqueued = 0;
    let enqueueErrors = 0;
    if (this.embeddingQueue) {
      const enqueueStart = Date.now();
      for (const record of data) {
        this.embeddingQueue
          .enqueueEmbedding({
            memoryId: record.id,
            userId,
            raw: record.raw,
            runDedup: true,
          })
          .then(() => {
            enqueued++;
            if (enqueued % progressEvery === 0) {
              this.logger.log({
                event: 'bulk_create.enqueue_progress',
                userId,
                enqueued,
                total: data.length,
                errors: enqueueErrors,
                elapsedMs: Date.now() - enqueueStart,
              });
            }
          })
          .catch((err) => {
            enqueueErrors++;
            const message = (err as Error)?.message ?? String(err);
            const txClosed = /transaction already closed|tx.*closed/i.test(
              message,
            );
            this.logger.error({
              event: 'bulk_create.enqueue_failed',
              memoryId: record.id,
              userId,
              transactionClosed: txClosed,
              error: message,
            });
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
   * Accept raw text, chunk it (by round, paragraph, or character count),
   * then bulk-insert all chunks as individual memory records.
   *
   * granularity:
   *   'ROUND'     — one record per conversation exchange (user+assistant turn pair)
   *   'PARAGRAPH' — split on blank lines (legacy paragraph boundary mode)
   *   'CHUNK'     — split at ~chunkSize chars on paragraph/sentence boundaries (default, back-compat)
   *
   * When ENABLE_ROUND_LEVEL_INGEST=true, defaults to 'ROUND' instead of 'CHUNK'.
   */
  async bulkTextImport(
    userId: string,
    dto: BulkTextImportDto,
  ): Promise<BulkTextResult> {
    const startedAt = Date.now();
    const envDefault =
      process.env.ENABLE_ROUND_LEVEL_INGEST === 'true' ? 'ROUND' : 'CHUNK';
    const granularity = dto.granularity ?? envDefault;
    const granularitySource = dto.granularity ? 'dto' : 'env_default';
    let chunks: string[];

    if (granularity === 'ROUND') {
      chunks = this.chunkByRound(dto.text);
    } else {
      const chunkSize = dto.chunkSize ?? 3500;
      chunks = this.chunkText(dto.text, chunkSize);
    }

    this.logger.log({
      event: 'bulk_text_import.start',
      userId,
      granularity,
      granularitySource,
      chunkCount: chunks.length,
      textLength: dto.text.length,
      sessionId: dto.context?.sessionId,
      projectId: dto.context?.projectId,
      embeddingModel:
        process.env.EMBEDDING_MODEL ??
        process.env.VECTOR_SEARCH_MODEL ??
        'unknown',
      ensembleEnabled: process.env.EMBEDDING_ENSEMBLE === 'true',
    });

    const isRound = granularity === 'ROUND';
    const bulkDto: BulkCreateMemoryDto = {
      memories: chunks.map((chunk, index) => ({
        raw: chunk,
        layer: dto.layer,
        ...(isRound ? { sessionPosition: index } : {}),
      })),
      context: dto.context,
    };

    try {
      const result = await this.bulkCreate(userId, bulkDto);
      this.logger.log({
        event: 'bulk_text_import.complete',
        userId,
        granularity,
        chunkCount: chunks.length,
        created: result.created,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        created: result.created,
        chunks: chunks.length,
        memoryIds: result.memoryIds,
      };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      const txClosed = /transaction already closed|tx.*closed/i.test(message);
      this.logger.error({
        event: 'bulk_text_import.failed',
        userId,
        granularity,
        chunkCount: chunks.length,
        elapsedMs: Date.now() - startedAt,
        transactionClosed: txClosed,
        error: message,
        stack: (err as Error)?.stack,
      });
      throw err;
    }
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
   * Split a conversation transcript into one chunk per exchange (round).
   *
   * A "round" is a user turn + its following assistant turn, kept together.
   * Splits on turn-prefix headers at line start (case-insensitive):
   *   Human: / User: / Assistant: / Agent:
   * and on Markdown/OpenClaw-style blank-line + "---" separators.
   *
   * Empty or whitespace-only segments are discarded. Adjacent lines from the
   * same speaker are kept together until the speaker changes.
   */
  chunkByRound(text: string): string[] {
    // Normalise line endings
    const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Split on "---" separators (blank line + dashes, used by OpenClaw/Mastra)
    // OR on turn-prefix headers at the start of a line.
    // We split *before* the delimiter so each segment starts with the speaker header.
    const segments = normalised.split(
      /(?=^(?:human|user|assistant|agent)\s*:)/im,
    );

    // Further split any segment that contains a "---" separator boundary
    const lines: string[] = [];
    for (const seg of segments) {
      const parts = seg.split(/\n---+\n/);
      lines.push(...parts);
    }

    // Group into exchange pairs: collect consecutive user/human turns with the
    // immediately following assistant/agent reply.
    const rounds: string[] = [];
    let currentRound = '';
    let lastRole: 'user' | 'assistant' | null = null;

    for (const segment of lines) {
      const trimmed = segment.trim();
      if (!trimmed) continue;

      const roleMatch = trimmed.match(/^(human|user|assistant|agent)\s*:/i);
      const role: 'user' | 'assistant' | null = roleMatch
        ? /^(human|user)$/i.test(roleMatch[1])
          ? 'user'
          : 'assistant'
        : null;

      if (role === 'user') {
        // New user turn starts a new round — flush any previous round first
        if (currentRound) {
          rounds.push(currentRound.trim());
        }
        currentRound = trimmed;
        lastRole = 'user';
      } else if (role === 'assistant') {
        // Append assistant reply to the current round
        currentRound = currentRound ? currentRound + '\n\n' + trimmed : trimmed;
        lastRole = 'assistant';
      } else {
        // No recognised prefix — append to current round (continuation)
        currentRound = currentRound ? currentRound + '\n\n' + trimmed : trimmed;
        if (lastRole === null) lastRole = 'user';
      }
    }

    if (currentRound.trim()) {
      rounds.push(currentRound.trim());
    }

    // Fallback: if no rounds were detected, treat the whole text as one chunk
    return rounds.length > 0 ? rounds : [text.trim()];
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
