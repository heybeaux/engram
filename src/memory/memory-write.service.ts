import {
  Injectable,
  Optional,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MemoryCreatedEvent } from '../events/event-types';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractionService, ExtractionContext } from './extraction.service';
import { ImportanceService } from './importance.service';
import { CreateMemoryDto, CreateMemoryBatchDto } from './dto/create-memory.dto';
import { MemorySource, SubjectType } from '@prisma/client';
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

@Injectable()
export class MemoryWriteService {
  private readonly logger = new Logger(MemoryWriteService.name);

  constructor(
    private prisma: PrismaService,
    private extraction: ExtractionService,
    private importance: ImportanceService,
    private pipelineService: MemoryPipelineService,
    @Optional() private durabilityClassifier?: DurabilityClassifierService,
    @Optional() private correctionService?: CorrectionService,
    @Optional() private memoryPoolService?: MemoryPoolService,
    @Optional() private memoryAccessLogService?: MemoryAccessLogService,
    @Optional() private eventEmitter?: EventEmitter2,
    @Optional() private readonly embeddingQueue?: EmbeddingQueueProducer,
    @Optional() private readonly hypeService?: HypeService,
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
      where: { userId, externalId: sessionId },
      select: { id: true },
    });
    if (existingByExternalId) return existingByExternalId.id;

    const newSession = await this.prisma.session.create({
      data: { userId, externalId: sessionId },
    });
    return newSession.id;
  }

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
          data: { memoryId, poolId: globalPool.id, addedBy: agentSessionKey },
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

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        externalId: true,
        displayName: true,
        agent: { select: { accountId: true } },
      },
    });
    const accountId = user?.agent?.accountId ?? undefined;

    const source = dto.source ?? MemorySource.EXPLICIT_STATEMENT;

    const importanceScore = this.importance.calculate({
      hint: dto.importanceHint,
      layer: dto.layer as any,
    });

    const confidence = SOURCE_CONFIDENCE[source] ?? 1.0;

    const sessionId = await this.resolveSessionId(
      userId,
      dto.context?.sessionId,
    );

    let layer = dto.layer;
    if (!layer) {
      layer = this.extraction.classifyLayer(rawContent);
      this.logger.log('[Memory] Smart layer classification:', {
        rawPreview: rawContent.substring(0, 50),
        layer,
      });
    }

    const subjectType = dto.subjectType ?? SubjectType.USER;
    const subjectId =
      dto.subjectId ??
      (subjectType === SubjectType.USER ? userId : dto.agentId);

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

    const extractionContext: ExtractionContext = {
      userId,
      userName: user?.displayName || user?.externalId,
      timestamp: dto.sourceTimestamp ?? new Date(),
      turnIndex: dto.sourceTurnIndex,
      conversationId: dto.context?.sessionId,
    };

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

    // Increment account memoriesUsed
    this.runWithRls(accountId, () => this.incrementMemoriesUsed(userId, 1));

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

    // ENG-31: Classify durability (fire-and-forget, non-blocking)
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

    // Check for contradictions
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
}
