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
import { MemoryLayer, MemorySource, MemoryType } from '@prisma/client';
import { generateContentHash } from '../common/content-hash.util';

@Processor(EMBEDDING_QUEUE, { concurrency: 2 })
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

      // [HEY-574] Create FACT_KEY child rows from extraction if feature flag is on
      if (process.env.ENABLE_FACT_KEY_EXPANSION === 'true') {
        await this.createFactKeyChildren(memoryId, userId);
      }

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
   * HEY-574: For each factKey in the parent memory's extraction, create a
   * FACT_KEY child memory row with searchable=true and parentMemoryId set.
   * Gated on contentHash to prevent duplicates on re-ingestion.
   */
  private async createFactKeyChildren(
    parentMemoryId: string,
    userId: string,
  ): Promise<void> {
    try {
      const extraction = await this.prisma.memoryExtraction.findUnique({
        where: { memoryId: parentMemoryId },
        select: { factKeys: true },
      });

      if (!extraction || !extraction.factKeys.length) {
        return;
      }

      const parent = await this.prisma.memory.findUnique({
        where: { id: parentMemoryId },
        select: { layer: true, sessionId: true },
      });
      if (!parent) return;

      for (const factKey of extraction.factKeys) {
        await this.upsertFactKeyChild(
          factKey,
          parentMemoryId,
          userId,
          parent.layer,
          parent.sessionId,
        );
      }
    } catch (err) {
      // Fact key expansion failure must not fail the job
      this.logger.error(
        `[HEY-574] Fact key expansion failed for ${parentMemoryId}: ${(err as Error).message}`,
      );
    }
  }

  private async upsertFactKeyChild(
    factKey: string,
    parentMemoryId: string,
    userId: string,
    layer: MemoryLayer | string | null,
    sessionId: string | null | undefined,
  ): Promise<void> {
    const contentHash = generateContentHash(factKey);

    // Dedup: skip if a FACT_KEY row with this contentHash already exists for this parent
    const existing = await this.prisma.memory.findFirst({
      where: {
        userId,
        parentMemoryId,
        memoryType: MemoryType.FACT_KEY,
        contentHash,
      },
      select: { id: true },
    });

    if (existing) {
      this.logger.debug(
        `[HEY-574] Skipping duplicate FACT_KEY contentHash=${contentHash} parent=${parentMemoryId}`,
      );
      return;
    }

    const child = await this.prisma.memory.create({
      data: {
        userId,
        raw: factKey,
        layer: (layer ?? 'SESSION') as MemoryLayer,
        source: MemorySource.AGENT_OBSERVATION,
        memoryType: MemoryType.FACT_KEY,
        searchable: true,
        parentMemoryId,
        sessionId: sessionId ?? undefined,
        contentHash,
        embeddingStatus: 'PENDING',
      } as any,
    });

    this.logger.debug(
      `[HEY-574] Created FACT_KEY child ${child.id} for parent ${parentMemoryId}`,
    );

    // Embed the child row immediately (fire-and-forget; failure is non-fatal)
    await this.pipeline.generateAndStoreEmbedding(child.id, factKey, userId);
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
        memoryId,
      );

      if (dedupResult.action === 'create' || !dedupResult.existingMemory) {
        // No duplicate — embedding pipeline already set COMPLETE
        return;
      }

      const existingId = dedupResult.existingMemory.id;

      if (existingId === memoryId) {
        this.logger.warn(
          `[Dedup] Ignoring self-duplicate result for memory ${memoryId}`,
        );
        return;
      }

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
