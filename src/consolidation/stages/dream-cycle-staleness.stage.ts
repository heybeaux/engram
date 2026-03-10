import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { ImportanceScorerService } from '../../memory/intelligence/importance-scorer.service';

export interface StalenessStageResult {
  archived: number;
  scoresRefreshed: number;
  candidates: number;
}

@Injectable()
export class DreamCycleStalenessStage {
  private readonly stalenessScoreThreshold: number;
  private readonly stalenessAgeDays: number;
  private readonly maxArchivalsPerRun: number;

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly scorer: ImportanceScorerService,
    private readonly config: ConfigService,
  ) {
    this.stalenessScoreThreshold = parseFloat(
      this.config.get('DREAM_STALENESS_SCORE') ?? '0.35',
    );
    this.stalenessAgeDays = parseInt(
      this.config.get('DREAM_STALENESS_DAYS') ?? '21',
      10,
    );
    this.maxArchivalsPerRun = parseInt(
      this.config.get('DREAM_MAX_ARCHIVALS') ?? '100',
      10,
    );
  }

  async run(userId: string, dryRun: boolean): Promise<StalenessStageResult> {
    let archived = 0;
    let scoresRefreshed = 0;

    const activeMemories = await this.prisma.memory.findMany({
      where: { userId, deletedAt: null },
    });

    const now = new Date();
    const cutoffDate = new Date(
      now.getTime() - this.stalenessAgeDays * 24 * 60 * 60 * 1000,
    );

    // Refresh scores
    for (const memory of activeMemories) {
      const scoreComponents = this.scorer.computeScore(memory, now);
      if (
        Math.abs(scoreComponents.effectiveScore - memory.effectiveScore) > 0.01
      ) {
        if (!dryRun) {
          await this.prisma.memory.update({
            where: { id: memory.id },
            data: {
              effectiveScore: scoreComponents.effectiveScore,
              scoreComputedAt: now,
            },
          });
        }
        scoresRefreshed++;
      }
    }

    // Find stale memories
    const staleMemories = activeMemories.filter((m) => {
      if (m.userPinned || m.safetyCritical) return false;
      if (m.memoryType === 'CONSTRAINT' || m.memoryType === 'LESSON')
        return false;

      const score = this.scorer.computeScore(m, now);
      if (score.effectiveScore >= this.stalenessScoreThreshold) return false;

      if (m.createdAt > cutoffDate) return false;

      const lastAccess = m.lastRetrievedAt || m.lastUsedAt;
      if (lastAccess && lastAccess > cutoffDate) return false;

      const totalUsage = (m.retrievalCount ?? 0) + (m.usedCount ?? 0);
      if (totalUsage >= 3) return false;

      return true;
    });

    const candidates = staleMemories.length;

    const toArchive = staleMemories.slice(0, this.maxArchivalsPerRun);
    for (const memory of toArchive) {
      if (!dryRun) {
        await this.prisma.memory.update({
          where: { id: memory.id },
          data: {
            deletedAt: now,
            archivedReason: 'staleness_pruning',
            lastDreamCycleAt: now,
          },
        });
      }
      archived++;
    }

    return { archived, scoresRefreshed, candidates };
  }
}
