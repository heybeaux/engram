import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { EMBEDDING_QUEUE, EmbedMemoryJobData } from './embedding.queue';
import { MemoryPipelineService } from './memory-pipeline.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import {
  MemoryDedupService,
  INSIGHT_DEDUP_THRESHOLD,
} from './memory-dedup.service';
import { MemoryLayer, MemorySource } from '@prisma/client';

@Processor(EMBEDDING_QUEUE)
export class EmbeddingQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(EmbeddingQueueProcessor.name);

  constructor(
    private readonly pipeline: MemoryPipelineService,
    private readonly prisma: ServicePrismaService,
    private readonly dedupService: MemoryDedupService,
  ) {
    super();
  }

  async process(job: Job<EmbedMemoryJobData>): Promise<void> {
    const { memoryId, userId, raw, runDedup } = job.data;
    this.logger.log(`Processing embedding: memoryId=${memoryId}`);
    try {
      const memory = await this.prisma.memory.findUnique({
        where: { id: memoryId },
        select: {
          id: true,
          embeddingStatus: true,
          deletedAt: true,
          layer: true,
          source: true,
          sessionId: true,
        },
      });
      if (!memory || memory.deletedAt) {
        this.logger.warn(`Memory ${memoryId} not found or deleted — skipping`);
        return;
      }
      if (
        memory.embeddingStatus === 'COMPLETE' ||
        (memory.embeddingStatus as string) === 'DUPLICATE'
      ) {
        this.logger.debug(
          `Memory ${memoryId} already processed (${memory.embeddingStatus}) — skipping`,
        );
        return;
      }

      // Run embed + extraction pipeline (sets embeddingStatus → COMPLETE internally)
      await this.pipeline.extractAndEmbed(memoryId, raw, userId);

      // [HEY-462] Run dedup off the hot path now that the embedding exists
      if (runDedup) {
        await this.runDedup(
          memoryId,
          userId,
          raw,
          memory.layer,
          memory.source,
          memory.sessionId,
        );
      }

      this.logger.log(`Embedding complete: memoryId=${memoryId}`);
    } catch (err) {
      this.logger.error(
        `Embedding failed for ${memoryId}: ${(err as Error).message}`,
      );
      await this.prisma.memory
        .update({
          where: { id: memoryId },
          data: { embeddingStatus: 'FAILED' },
        })
        .catch(() => {});
      throw err;
    }
  }

  /**
   * Three-tier dedup check run asynchronously after embedding is complete.
   * If a duplicate is found, marks the new memory as DUPLICATE and links it
   * to the surviving memory via isDuplicateOf.
   */
  private async runDedup(
    memoryId: string,
    userId: string,
    raw: string,
    layer: MemoryLayer | string | null,
    source: MemorySource | string | null,
    sessionId: string | null | undefined,
  ): Promise<void> {
    try {
      const dedupThreshold =
        layer === MemoryLayer.INSIGHT ? INSIGHT_DEDUP_THRESHOLD : undefined;

      const dedupResult = await this.dedupService.findDuplicateV2(
        userId,
        raw,
        dedupThreshold,
      );

      if (dedupResult.action === 'create' || !dedupResult.existingMemory) {
        // No duplicate — embedding pipeline already set COMPLETE
        return;
      }

      const existingId = dedupResult.existingMemory.id;

      if (dedupResult.action === 'merged') {
        this.logger.log(
          `[Dedup] Auto-merge: new=${memoryId} → existing=${existingId} (score=${dedupResult.similarityScore?.toFixed(3)})`,
        );
        await this.dedupService.autoMergeMemory(
          existingId,
          raw,
          (source as MemorySource) ?? MemorySource.EXPLICIT_STATEMENT,
        );
      } else if (dedupResult.action === 'reinforced') {
        this.logger.log(
          `[Dedup] Reinforce: new=${memoryId} → existing=${existingId} (score=${dedupResult.similarityScore?.toFixed(3)})`,
        );
        await this.dedupService.reinforceMemory(
          existingId,
          sessionId ?? undefined,
        );
      }

      // Mark the new memory as DUPLICATE and point to the surviving memory

      await (this.prisma.memory.update as any)({
        where: { id: memoryId },
        data: {
          embeddingStatus: 'DUPLICATE',
          isDuplicateOf: existingId,
        },
      });

      this.logger.log(
        `[Dedup] Marked memory ${memoryId} as DUPLICATE of ${existingId}`,
      );
    } catch (err) {
      // Dedup failure must not fail the job — embedding already succeeded
      this.logger.error(
        `[Dedup] Post-embed dedup failed for ${memoryId}: ${(err as Error).message}`,
      );
    }
  }
}
