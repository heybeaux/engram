import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServicePrismaService } from '../../prisma/service-prisma.service';

export interface ImportanceRescoreResult {
  rescored: number;
  unchanged: number;
  avgChange: number;
}

const LAYER_WEIGHTS: Record<string, number> = {
  IDENTITY: 1.5,
  PROJECT: 1.3,
  INSIGHT: 1.2,
  TASK: 1.0,
  SESSION: 0.8,
};

@Injectable()
export class DreamCycleImportanceRescoreStage {
  private readonly logger = new Logger(DreamCycleImportanceRescoreStage.name);
  private readonly batchSize: number;

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly config: ConfigService,
  ) {
    this.batchSize = parseInt(
      this.config.get('DREAM_RESCORE_BATCH_SIZE') ?? '100',
      10,
    );
  }

  async run(userId: string, dryRun: boolean): Promise<ImportanceRescoreResult> {
    this.logger.log(
      `Starting importance re-scoring for user ${userId} (dryRun: ${dryRun})`,
    );

    let rescored = 0;
    let unchanged = 0;
    let totalChange = 0;
    let cursor: string | undefined;

    // Process in batches using cursor-based pagination
    while (true) {
      const memories = await this.prisma.memory.findMany({
        where: {
          userId,
          deletedAt: null,
        },
        select: {
          id: true,
          importanceScore: true,
          lastRetrievedAt: true,
          usedCount: true,
          createdAt: true,
          layer: true,
          searchable: true,
        },
        take: this.batchSize,
        orderBy: { id: 'asc' },
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (memories.length === 0) break;

      cursor = memories[memories.length - 1].id;

      for (const memory of memories) {
        const baseImportance = memory.importanceScore ?? 0.5;
        const newScore = this.calculateScore(
          baseImportance,
          memory.lastRetrievedAt,
          memory.usedCount ?? 0,
          memory.createdAt,
          memory.layer,
        );

        // Clamp to [0, 1]; searchable memories get a 0.35 floor to prevent
        // decay from triggering both the archival stage threshold (0.15) AND
        // the importance multiplier penalty in ranking (< 0.35 → 0.4× penalty).
        const floor = memory.searchable !== false ? 0.35 : 0;
        const clamped = Math.max(floor, Math.min(1, newScore));
        const change = Math.abs(clamped - (memory.importanceScore ?? 0.5));

        if (change < 0.001) {
          unchanged++;
          continue;
        }

        rescored++;
        totalChange += change;

        if (!dryRun) {
          await this.prisma.memory.update({
            where: { id: memory.id },
            data: { importanceScore: clamped },
          });
        }
      }
    }

    const avgChange = rescored > 0 ? totalChange / rescored : 0;
    const result = {
      rescored,
      unchanged,
      avgChange: Math.round(avgChange * 1000) / 1000,
    };

    this.logger.log(
      `Importance re-scoring complete: ${JSON.stringify(result)}`,
    );
    return result;
  }

  calculateScore(
    baseImportance: number,
    lastRetrievedAt: Date | null,
    usedCount: number,
    createdAt: Date,
    layer: string | null,
  ): number {
    return (
      baseImportance *
      this.recencyBoost(lastRetrievedAt) *
      this.usageBoost(usedCount) *
      this.decayFactor(createdAt, lastRetrievedAt) *
      this.layerWeight(layer)
    );
  }

  recencyBoost(lastRetrievedAt: Date | null): number {
    if (!lastRetrievedAt) return 0.5;
    const daysSince =
      (Date.now() - lastRetrievedAt.getTime()) / (1000 * 60 * 60 * 24);
    return Math.max(0.3, Math.exp(-0.05 * daysSince));
  }

  usageBoost(usedCount: number): number {
    return 1 + Math.log10(Math.max(1, usedCount)) * 0.3;
  }

  decayFactor(createdAt: Date, lastRetrievedAt: Date | null): number {
    if (lastRetrievedAt) return 1.0;
    const ageInDays =
      (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    return Math.max(0.2, Math.exp(-0.02 * ageInDays));
  }

  layerWeight(layer: string | null): number {
    return LAYER_WEIGHTS[layer ?? ''] ?? 1.0;
  }
}
