import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

export interface TieringStageResult {
  promoted: number;
  demoted: number;
  unchanged: number;
}

const TIER_ORDER = { HOT: 0, WARM: 1, COLD: 2 } as const;

@Injectable()
export class DreamCycleTieringStage {
  private readonly logger = new Logger(DreamCycleTieringStage.name);
  private readonly batchSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.batchSize = parseInt(
      this.config.get('DREAM_TIER_BATCH_SIZE') ?? '500',
      10,
    );
  }

  async run(userId: string, dryRun: boolean): Promise<TieringStageResult> {
    let promoted = 0;
    let demoted = 0;
    let unchanged = 0;

    this.logger.log(
      `Starting memory tiering for user ${userId} (dryRun: ${dryRun})`,
    );

    const memories = await this.prisma.memory.findMany({
      where: {
        userId,
        deletedAt: null,
      },
      select: {
        id: true,
        tier: true,
        userPinned: true,
        createdAt: true,
        lastRetrievedAt: true,
        retrievalCount: true,
      },
      take: this.batchSize,
      orderBy: { createdAt: 'asc' },
    });

    if (memories.length === 0) {
      this.logger.log(`No memories found for user ${userId}`);
      return { promoted: 0, demoted: 0, unchanged: 0 };
    }

    this.logger.log(`Processing ${memories.length} memories for tiering`);

    const now = new Date();

    for (const memory of memories) {
      const newTier = this.calculateTier(memory, now);
      const currentTier = memory.tier ?? 'WARM';

      if (newTier === currentTier) {
        unchanged++;
        continue;
      }

      const currentOrder = TIER_ORDER[currentTier as keyof typeof TIER_ORDER] ?? 1;
      const newOrder = TIER_ORDER[newTier as keyof typeof TIER_ORDER];

      if (newOrder < currentOrder) {
        promoted++;
      } else {
        demoted++;
      }

      if (!dryRun) {
        await this.prisma.memory.update({
          where: { id: memory.id },
          data: { tier: newTier },
        });
      }
    }

    const result = { promoted, demoted, unchanged };
    this.logger.log(`Tiering complete: ${JSON.stringify(result)}`);
    return result;
  }

  private calculateTier(
    memory: {
      userPinned: boolean;
      createdAt: Date;
      lastRetrievedAt: Date | null;
      retrievalCount: number;
    },
    now: Date,
  ): string {
    const msPerDay = 86_400_000;
    const daysSinceCreated = (now.getTime() - memory.createdAt.getTime()) / msPerDay;
    const daysSinceAccessed = memory.lastRetrievedAt
      ? (now.getTime() - memory.lastRetrievedAt.getTime()) / msPerDay
      : Infinity;

    // HOT: pinned, accessed within 7 days, or created within 48h
    if (
      memory.userPinned ||
      daysSinceAccessed <= 7 ||
      daysSinceCreated <= 2
    ) {
      return 'HOT';
    }

    // WARM: accessed within 30 days or retrievalCount >= 3
    if (daysSinceAccessed <= 30 || memory.retrievalCount >= 3) {
      return 'WARM';
    }

    // COLD: accessed > 30 days ago AND retrievalCount < 3 AND created > 90 days ago
    if (
      daysSinceAccessed > 30 &&
      memory.retrievalCount < 3 &&
      daysSinceCreated > 90
    ) {
      return 'COLD';
    }

    // Default to WARM if none of the above match
    return 'WARM';
  }
}
