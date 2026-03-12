import * as crypto from 'crypto';
import { Injectable, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractionService } from './extraction.service';
import { ImportanceService } from './importance.service';
import {
  BulkCreateMemoryDto,
  BulkCreateResult,
  BulkTextImportDto,
  BulkTextResult,
} from './dto/bulk.dto';
import { MemoryLayer, MemorySource } from '@prisma/client';
import { generateContentHash } from '../common/content-hash.util';
import { EmbeddingQueueProducer } from './embedding-queue.producer';

@Injectable()
export class MemoryBulkService {
  private readonly logger = new Logger(MemoryBulkService.name);

  constructor(
    private prisma: PrismaService,
    private extraction: ExtractionService,
    private importance: ImportanceService,
    @Optional() private readonly embeddingQueue?: EmbeddingQueueProducer,
  ) {}

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

    await this.prisma.memory.createMany({ data });

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

      if (current.length + trimmed.length + 2 <= targetSize) {
        current = current ? current + '\n\n' + trimmed : trimmed;
        continue;
      }

      if (current) {
        chunks.push(current);
        current = '';
      }

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
}
