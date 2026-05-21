import {
  Injectable,
  Optional,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MemoryUpdatedEvent, MemoryDeletedEvent } from '../events/event-types';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractionService, ExtractionContext } from './extraction.service';
import { EmbeddingService } from './embedding.service';
import { ImportanceService } from './importance.service';
import { ExportedMemory } from './dto/export-import.dto';
import { UpdateMemoryDto, CorrectMemoryDto } from './dto/update-memory.dto';
import { MemorySource } from '@prisma/client';
import { parseFlexibleDate } from '../utils/date-parser';
import { MemoryPipelineService } from './memory-pipeline.service';
import { rlsContext } from '../prisma/rls-context';
import { MemoryWithExtraction } from './memory.types';
import { ElasticsearchService } from '../search/elasticsearch.service';

@Injectable()
export class MemoryLifecycleService {
  private readonly logger = new Logger(MemoryLifecycleService.name);

  constructor(
    private prisma: PrismaService,
    private extraction: ExtractionService,
    private embedding: EmbeddingService,
    private importance: ImportanceService,
    private pipelineService: MemoryPipelineService,
    private elasticsearchService: ElasticsearchService,
    @Optional() private eventEmitter?: EventEmitter2,
  ) {}

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
    if (accountId) {
      return memory;
    }
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

    // Remove from Elasticsearch (fire-and-forget)
    this.elasticsearchService
      .deleteMemory(memoryId)
      .catch((err) =>
        this.logger.warn(
          `[Memory] ES delete failed for ${memoryId}: ${(err as Error).message}`,
        ),
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

      const embeddingVec = await this.embedding.generate(dto.raw);
      await this.embedding.store(memoryId, embeddingVec, {
        userId,
        layer: updated.layer,
        importance: updated.importanceScore,
      });

      await this.pipelineService.linkRelatedMemories(
        memoryId,
        embeddingVec,
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

    const result = await this.getById(memoryId);

    // Update Elasticsearch index (fire-and-forget)
    if (result) {
      setImmediate(() => {
        this.elasticsearchService
          .indexMemory({
            id: result.id,
            content: result.raw,
            userId: result.userId,
            agentId: (result as any).agentId ?? undefined,
            layer: result.layer,
            source: result.source,
            tags: (result as any).tags ?? [],
            createdAt: result.createdAt,
            updatedAt: result.updatedAt,
          })
          .catch((err) =>
            this.logger.warn(
              `[Memory] ES index update failed for ${memoryId}: ${(err as Error).message}`,
            ),
          );
      });
    }

    return result as MemoryWithExtraction;
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
    const correctionAccountId = (original?.user as any)?.accountId ?? undefined;

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
   * Export memories with filters, supporting JSON/CSV/NDJSON format.
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
