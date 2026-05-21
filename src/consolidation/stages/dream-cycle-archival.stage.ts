import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServicePrismaService } from '../../prisma/service-prisma.service';

export interface ArchivalStageResult {
  archived: number;
  skippedProtectedLayer: number;
  skippedRecentlyRetrieved: number;
  skippedFrequentlyUsed: number;
  byLayer: Record<string, number>;
  byType: Record<string, number>;
}

/** Layers that must never be auto-archived. */
const PROTECTED_LAYERS = ['IDENTITY', 'PROJECT'];

@Injectable()
export class DreamCycleArchivalStage {
  private readonly logger = new Logger(DreamCycleArchivalStage.name);
  private readonly importanceThreshold: number;
  private readonly retrievalWindowDays: number;
  private readonly maxUsedCount: number;
  private readonly batchSize: number;

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly config: ConfigService,
  ) {
    this.importanceThreshold = parseFloat(
      this.config.get('DREAM_ARCHIVAL_IMPORTANCE_THRESHOLD') ?? '0.15',
    );
    this.retrievalWindowDays = parseInt(
      this.config.get('DREAM_ARCHIVAL_RETRIEVAL_WINDOW_DAYS') ?? '30',
      10,
    );
    this.maxUsedCount = parseInt(
      this.config.get('DREAM_ARCHIVAL_MAX_USED_COUNT') ?? '5',
      10,
    );
    this.batchSize = parseInt(
      this.config.get('DREAM_ARCHIVAL_BATCH_SIZE') ?? '500',
      10,
    );
  }

  async run(userId: string, dryRun: boolean): Promise<ArchivalStageResult> {
    this.logger.log(
      `Starting archival stage for user ${userId} (dryRun: ${dryRun}, threshold: ${this.importanceThreshold})`,
    );

    const retrievalCutoff = new Date();
    retrievalCutoff.setDate(
      retrievalCutoff.getDate() - this.retrievalWindowDays,
    );

    // Fetch candidate memories: low importance, active, not already archived
    const candidates = await this.prisma.memory.findMany({
      where: {
        userId,
        deletedAt: null,
        searchable: true,
        importanceScore: { lt: this.importanceThreshold },
      },
      select: {
        id: true,
        layer: true,
        memoryType: true,
        lastRetrievedAt: true,
        usedCount: true,
      },
      take: this.batchSize,
      orderBy: { importanceScore: 'asc' },
    });

    if (candidates.length === 0) {
      this.logger.log(`No archival candidates found for user ${userId}`);
      return {
        archived: 0,
        skippedProtectedLayer: 0,
        skippedRecentlyRetrieved: 0,
        skippedFrequentlyUsed: 0,
        byLayer: {},
        byType: {},
      };
    }

    this.logger.log(
      `Found ${candidates.length} low-importance candidates for archival`,
    );

    const toArchive: string[] = [];
    let skippedProtectedLayer = 0;
    let skippedRecentlyRetrieved = 0;
    let skippedFrequentlyUsed = 0;
    const byLayer: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const memory of candidates) {
      // Safety rail: never archive IDENTITY or PROJECT layer
      if (PROTECTED_LAYERS.includes(memory.layer)) {
        skippedProtectedLayer++;
        continue;
      }

      // Safety rail: never archive recently retrieved memories
      if (
        memory.lastRetrievedAt &&
        memory.lastRetrievedAt.getTime() > retrievalCutoff.getTime()
      ) {
        skippedRecentlyRetrieved++;
        continue;
      }

      // Safety rail: never archive frequently used memories
      if (memory.usedCount > this.maxUsedCount) {
        skippedFrequentlyUsed++;
        continue;
      }

      toArchive.push(memory.id);
      const layer = memory.layer ?? 'UNKNOWN';
      byLayer[layer] = (byLayer[layer] ?? 0) + 1;
      const type = memory.memoryType ?? 'UNKNOWN';
      byType[type] = (byType[type] ?? 0) + 1;
    }

    if (toArchive.length > 0 && !dryRun) {
      await this.prisma.memory.updateMany({
        where: { id: { in: toArchive }, userId },
        data: {
          archivedReason: 'low_importance',
          searchable: false,
          lastDreamCycleAt: new Date(),
        },
      });

      this.logger.log(
        `Archived ${toArchive.length} memories for user ${userId}: ${JSON.stringify({ byLayer, byType })}`,
      );
    }

    const result: ArchivalStageResult = {
      archived: toArchive.length,
      skippedProtectedLayer,
      skippedRecentlyRetrieved,
      skippedFrequentlyUsed,
      byLayer,
      byType,
    };

    this.logger.log(`Archival stage complete: ${JSON.stringify(result)}`);
    return result;
  }
}
