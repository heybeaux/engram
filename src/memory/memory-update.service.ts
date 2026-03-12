import { Injectable, Optional, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MemoryUpdatedEvent } from '../events/event-types';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractionService, ExtractionContext } from './extraction.service';
import { EmbeddingService } from './embedding.service';
import { ImportanceService } from './importance.service';
import { UpdateMemoryDto, CorrectMemoryDto } from './dto/update-memory.dto';
import { MemorySource } from '@prisma/client';
import { parseFlexibleDate } from '../utils/date-parser';
import { MemoryPipelineService } from './memory-pipeline.service';
import { rlsContext } from '../prisma/rls-context';
import { MemoryWithExtraction } from './memory.types';

@Injectable()
export class MemoryUpdateService {
  private readonly logger = new Logger(MemoryUpdateService.name);

  constructor(
    private prisma: PrismaService,
    private extraction: ExtractionService,
    private embedding: EmbeddingService,
    private importance: ImportanceService,
    private pipelineService: MemoryPipelineService,
    @Optional() private eventEmitter?: EventEmitter2,
  ) {}

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

  private async incrementMemoriesUsed(
    userId: string,
    delta: number,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { agent: { select: { accountId: true } } },
    });
    const accountId = user?.agent?.accountId;
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

  private emitEvent(eventName: string, payload: any): void {
    try {
      this.eventEmitter?.emit(eventName, payload);
    } catch (err) {
      this.logger.error(`[Memory] Failed to emit ${eventName}:`, err);
    }
  }

  async update(
    userId: string,
    memoryId: string,
    dto: UpdateMemoryDto,
  ): Promise<MemoryWithExtraction> {
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

    const contentChanged = dto.raw && dto.raw !== memory.raw;

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

    return this.prisma.memory.findUnique({
      where: { id: memoryId },
      include: { extraction: true },
    }) as Promise<MemoryWithExtraction>;
  }

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
            agent: { select: { accountId: true } },
          },
        },
      },
    });
    const correctionAccountId =
      (original?.user as any)?.agent?.accountId ?? undefined;

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
      data: { supersededById: correction.id, supersededAt: new Date() },
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

    this.runWithRls(correctionAccountId, () =>
      this.incrementMemoriesUsed(userId, 1),
    );

    this.logger.log(
      `[Memory] Created correction: ${correction.id} supersedes ${memoryId}`,
    );

    return correction as MemoryWithExtraction;
  }
}
