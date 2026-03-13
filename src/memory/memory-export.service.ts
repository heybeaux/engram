import { Injectable, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractionService, ExtractionContext } from './extraction.service';
import { ImportanceService } from './importance.service';
import { MemoryDedupService } from './memory-dedup.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import {
  ExportedMemory,
  ExportedGraphEntity,
  ExportedGraphRelationship,
  ImportMemoryItemDto,
  ImportResult,
} from './dto/export-import.dto';
import { MemoryLayer, MemorySource } from '@prisma/client';
import { generateContentHash } from '../common/content-hash.util';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MemoryCreatedEvent } from '../events/event-types';
import { rlsContext } from '../prisma/rls-context';

@Injectable()
export class MemoryExportService {
  private readonly logger = new Logger(MemoryExportService.name);

  constructor(
    private prisma: PrismaService,
    private extraction: ExtractionService,
    private importance: ImportanceService,
    private dedupService: MemoryDedupService,
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

  async exportMemories(userId: string): Promise<ExportedMemory[]> {
    const memories = await this.prisma.memory.findMany({
      where: { userId, deletedAt: null },
      include: { extraction: true },
      orderBy: { createdAt: 'asc' },
    });

    const memoryIds = memories.map((m) => m.id);
    const [ensembleMap, graphMap] = await Promise.all([
      this.buildEnsembleMap(memoryIds),
      this.buildGraphMap(memoryIds),
    ]);
    return memories.map((m) => this.mapToExported(m, ensembleMap, graphMap));
  }

  async exportMemoriesBatch(
    userId: string,
    take: number,
    cursor?: string,
  ): Promise<ExportedMemory[]> {
    const memories = await this.prisma.memory.findMany({
      where: { userId, deletedAt: null },
      include: { extraction: true },
      orderBy: { createdAt: 'asc' },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const memoryIds = memories.map((m) => m.id);
    const [ensembleMap, graphMap] = await Promise.all([
      this.buildEnsembleMap(memoryIds),
      this.buildGraphMap(memoryIds),
    ]);
    return memories.map((m) => this.mapToExported(m, ensembleMap, graphMap));
  }

  async importMemories(
    userId: string,
    items: ImportMemoryItemDto[],
  ): Promise<ImportResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        externalId: true,
        displayName: true,
        accountId: true,
        account: true,
      },
    });

    const account = user?.account as any;
    const memoriesUsed = account?.memoriesUsed ?? 0;
    let memoryLimit = Infinity;

    if (account) {
      const { PLAN_LIMITS } = await import('../account/plan-limits.js');
      const limits = PLAN_LIMITS[account.plan as keyof typeof PLAN_LIMITS];
      if (limits && limits.memories !== -1) {
        memoryLimit = limits.memories;
      }
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const item of items) {
      try {
        if (memoriesUsed + imported >= memoryLimit) {
          errors += items.length - imported - skipped - errors;
          break;
        }

        const dedupResult = await this.dedupService.findDuplicateV2(
          userId,
          item.raw,
        );

        if (dedupResult.action !== 'create') {
          skipped++;
          continue;
        }

        const layer =
          item.layer &&
          Object.values(MemoryLayer).includes(item.layer as MemoryLayer)
            ? (item.layer as MemoryLayer)
            : this.extraction.classifyLayer(item.raw);

        const importanceScore =
          item.importance != null
            ? Math.max(0, Math.min(1, item.importance))
            : this.importance.calculate({ layer });

        const memory = await this.prisma.memory.create({
          data: {
            userId,
            raw: item.raw,
            layer,
            source: MemorySource.EXPLICIT_STATEMENT,
            importanceScore,
            confidence: 1.0,
            contentHash: generateContentHash(item.raw),
          },
        });

        const extractionContext: ExtractionContext = {
          userId,
          userName: user?.displayName || user?.externalId,
          timestamp: item.createdAt ? new Date(item.createdAt) : new Date(),
        };

        this.runWithRls(user?.accountId ?? undefined, () =>
          this.pipelineService.extractAndEmbed(
            memory.id,
            item.raw,
            userId,
            extractionContext,
          ),
        );

        this.emitEvent(
          'memory.created',
          new MemoryCreatedEvent(
            memory.id,
            memory.layer,
            importanceScore,
            [],
            userId,
            item.raw.substring(0, 200),
          ),
        );

        imported++;
      } catch (err) {
        this.logger.error('[Import] Failed to import memory:', err);
        errors++;
      }
    }

    if (imported > 0) {
      this.incrementMemoriesUsed(userId, imported).catch((err) => {
        this.logger.error('[Import] Failed to increment memoriesUsed:', err);
      });
    }

    return { imported, skipped, errors };
  }

  private async buildGraphMap(memoryIds: string[]): Promise<
    Map<
      string,
      {
        entities: ExportedGraphEntity[];
        relationships: ExportedGraphRelationship[];
      }
    >
  > {
    const graphMap = new Map<
      string,
      {
        entities: ExportedGraphEntity[];
        relationships: ExportedGraphRelationship[];
      }
    >();

    if (!memoryIds.length) return graphMap;

    // Batch fetch all entity mentions for these memories, including entity data
    let mentions: any[] = [];
    try {
      mentions = await this.prisma.graphEntityMention.findMany({
        where: { memoryId: { in: memoryIds } },
        select: {
          memoryId: true,
          entityId: true,
          entity: {
            select: {
              id: true,
              name: true,
              type: true,
              aliases: true,
              description: true,
              metadata: true,
            },
          },
        },
      });
    } catch {
      // Graph tables may not exist in test or older schemas
    }

    // Build per-memory entity map and collect all entity IDs
    const memoryEntityMap = new Map<string, Map<string, ExportedGraphEntity>>();
    const allEntityIds = new Set<string>();

    for (const mention of mentions) {
      allEntityIds.add(mention.entityId);
      if (!memoryEntityMap.has(mention.memoryId)) {
        memoryEntityMap.set(mention.memoryId, new Map());
      }
      const entityMap = memoryEntityMap.get(mention.memoryId)!;
      if (!entityMap.has(mention.entityId)) {
        entityMap.set(mention.entityId, {
          id: mention.entity.id,
          name: mention.entity.name,
          type: mention.entity.type,
          aliases: mention.entity.aliases,
          description: mention.entity.description,
          metadata: mention.entity.metadata as Record<string, any>,
        });
      }
    }

    // Batch fetch relationships where sourceMemoryIds overlap with our memoryIds
    let relationships: any[] = [];
    if (allEntityIds.size) {
      try {
        relationships = await this.prisma.graphRelationship.findMany({
          where: {
            OR: [
              { sourceEntityId: { in: [...allEntityIds] } },
              { targetEntityId: { in: [...allEntityIds] } },
            ],
            sourceMemoryIds: { hasSome: memoryIds },
          },
          select: {
            id: true,
            sourceEntityId: true,
            targetEntityId: true,
            type: true,
            label: true,
            weight: true,
            properties: true,
            isInferred: true,
            sourceMemoryIds: true,
          },
        });
      } catch {
        // Graph tables may not exist in test or older schemas
      }
    }

    // Map relationships to memories via sourceMemoryIds
    const memoryRelMap = new Map<
      string,
      Map<string, ExportedGraphRelationship>
    >();
    for (const rel of relationships) {
      for (const memId of rel.sourceMemoryIds) {
        if (!memoryIds.includes(memId)) continue;
        if (!memoryRelMap.has(memId)) {
          memoryRelMap.set(memId, new Map());
        }
        const relMap = memoryRelMap.get(memId)!;
        if (!relMap.has(rel.id)) {
          relMap.set(rel.id, {
            id: rel.id,
            sourceEntityId: rel.sourceEntityId,
            targetEntityId: rel.targetEntityId,
            type: rel.type,
            label: rel.label,
            weight: rel.weight,
            properties: rel.properties as Record<string, any>,
            isInferred: rel.isInferred,
          });
        }
      }
    }

    // Combine into graphMap
    const allMemoryIds = new Set([
      ...memoryEntityMap.keys(),
      ...memoryRelMap.keys(),
    ]);
    for (const memId of allMemoryIds) {
      graphMap.set(memId, {
        entities: memoryEntityMap.has(memId)
          ? [...memoryEntityMap.get(memId)!.values()]
          : [],
        relationships: memoryRelMap.has(memId)
          ? [...memoryRelMap.get(memId)!.values()]
          : [],
      });
    }

    return graphMap;
  }

  private async buildEnsembleMap(
    memoryIds: string[],
  ): Promise<Map<string, Record<string, any>>> {
    const ensembleRows = memoryIds.length
      ? await this.prisma.memoryEmbedding
          .findMany({
            where: { memoryId: { in: memoryIds } },
            select: { memoryId: true, modelId: true },
          })
          .catch(() => [] as any[])
      : [];

    const ensembleMap = new Map<string, Record<string, any>>();
    for (const row of ensembleRows) {
      if (!ensembleMap.has(row.memoryId)) {
        ensembleMap.set(row.memoryId, {});
      }
      ensembleMap.get(row.memoryId)![row.modelId] = true;
    }
    return ensembleMap;
  }

  private mapToExported(
    m: any,
    ensembleMap: Map<string, Record<string, any>>,
    graphMap: Map<
      string,
      {
        entities: ExportedGraphEntity[];
        relationships: ExportedGraphRelationship[];
      }
    >,
  ): ExportedMemory {
    return {
      id: m.id,
      raw: m.raw,
      layer: m.layer,
      importance: m.importanceScore,
      tags: m.extraction?.topics ?? [],
      metadata: {
        source: m.source,
        confidence: m.confidence,
        subjectType: m.subjectType,
        subjectId: m.subjectId,
        projectId: m.projectId,
        sessionId: m.sessionId,
        extraction: m.extraction
          ? {
              who: m.extraction.who,
              what: m.extraction.what,
              when: m.extraction.when,
              where: m.extraction.whereCtx,
              why: m.extraction.why,
              how: m.extraction.how,
              topics: m.extraction.topics,
            }
          : null,
      },
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      ...(ensembleMap.has(m.id)
        ? { ensembleEmbeddings: ensembleMap.get(m.id) }
        : {}),
      graph: graphMap.get(m.id) ?? { entities: [], relationships: [] },
    };
  }

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

  private emitEvent(eventName: string, payload: any): void {
    try {
      this.eventEmitter?.emit(eventName, payload);
    } catch (err) {
      this.logger.error(`[Memory] Failed to emit ${eventName}:`, err);
    }
  }
}
