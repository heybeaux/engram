import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServicePrismaService } from '../prisma/service-prisma.service';

export interface TemporalSampleOptions {
  userId: string;
  sampleSize?: number;
  includeFields?: string[];
}

export interface SampledMemory {
  id: string;
  raw: string;
  memoryType?: string;
  importanceScore: number;
  effectiveScore: number;
  createdAt: Date;
  lastDreamedAt?: Date | null;
  retrievalCount: number;
  layer: string;
  tier: 'recent' | 'mid-range' | 'deep' | 'random';
}

interface TierStats {
  recent: number;
  midRange: number;
  deep: number;
  random: number;
}

@Injectable()
export class TemporalSamplingService {
  private readonly defaultSampleSize: number;

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly config: ConfigService,
  ) {
    this.defaultSampleSize = parseInt(
      this.config.get('DREAM_SAMPLE_SIZE') ?? '2000',
      10,
    );
  }

  async sampleMemories(options: TemporalSampleOptions): Promise<{
    memories: SampledMemory[];
    tierStats: TierStats;
    totalAvailable: number;
  }> {
    const {
      userId,
      sampleSize = this.defaultSampleSize,
      includeFields = [],
    } = options;

    // Get total count and temporal boundaries
    const totalCount = await this.prisma.memory.count({
      where: {
        userId,
        deletedAt: null,
        consolidatedInto: null,
      },
    });

    if (totalCount === 0) {
      return {
        memories: [],
        tierStats: { recent: 0, midRange: 0, deep: 0, random: 0 },
        totalAvailable: 0,
      };
    }

    // Calculate actual sample size (don't exceed available memories)
    const actualSampleSize = Math.min(sampleSize, totalCount);

    // Calculate tier sizes (40% recent, 30% mid-range, 20% deep, 10% random)
    const tierSizes = {
      recent: Math.floor(actualSampleSize * 0.4),
      midRange: Math.floor(actualSampleSize * 0.3),
      deep: Math.floor(actualSampleSize * 0.2),
      random: Math.floor(actualSampleSize * 0.1),
    };

    // Adjust for rounding errors
    const totalAllocated =
      tierSizes.recent + tierSizes.midRange + tierSizes.deep + tierSizes.random;
    const remaining = actualSampleSize - totalAllocated;
    tierSizes.recent += remaining; // Add any remainder to recent tier

    // Define temporal boundaries
    const now = new Date();
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const baseSelect = {
      id: true,
      raw: true,
      memoryType: true,
      importanceScore: true,
      effectiveScore: true,
      createdAt: true,
      lastDreamedAt: true,
      retrievalCount: true,
      layer: true,
      ...includeFields.reduce((acc, field) => ({ ...acc, [field]: true }), {}),
    };

    const baseWhere = {
      userId,
      deletedAt: null,
      consolidatedInto: null,
    };

    // Sample from each tier
    const [recentMemories, midRangeMemories, deepMemories, randomMemories] =
      await Promise.all([
        // Recent tier (last 30 days)
        this.sampleFromTier(
          {
            ...baseWhere,
            createdAt: { gte: oneMonthAgo },
          },
          tierSizes.recent,
          baseSelect,
        ),

        // Mid-range tier (30 days to 6 months)
        this.sampleFromTier(
          {
            ...baseWhere,
            createdAt: { gte: sixMonthsAgo, lt: oneMonthAgo },
          },
          tierSizes.midRange,
          baseSelect,
        ),

        // Deep tier (6 months to 1 year)
        this.sampleFromTier(
          {
            ...baseWhere,
            createdAt: { gte: oneYearAgo, lt: sixMonthsAgo },
          },
          tierSizes.deep,
          baseSelect,
        ),

        // Random tier (older than 1 year)
        this.sampleFromTier(
          {
            ...baseWhere,
            createdAt: { lt: oneYearAgo },
          },
          tierSizes.random,
          baseSelect,
        ),
      ]);

    // Combine and tag with tier information
    const allMemories = [
      ...recentMemories.map((m) => ({ ...m, tier: 'recent' as const })),
      ...midRangeMemories.map((m) => ({ ...m, tier: 'mid-range' as const })),
      ...deepMemories.map((m) => ({ ...m, tier: 'deep' as const })),
      ...randomMemories.map((m) => ({ ...m, tier: 'random' as const })),
    ];

    // Shuffle for cross-temporal comparison
    const shuffledMemories = this.shuffleArray(allMemories);

    const actualTierStats = {
      recent: recentMemories.length,
      midRange: midRangeMemories.length,
      deep: deepMemories.length,
      random: randomMemories.length,
    };

    return {
      memories: shuffledMemories,
      tierStats: actualTierStats,
      totalAvailable: totalCount,
    };
  }

  private async sampleFromTier(
    where: any,
    requestedSize: number,
    select: any,
  ): Promise<any[]> {
    if (requestedSize === 0) {
      return [];
    }

    // Get total count for this tier
    const tierCount = await this.prisma.memory.count({ where });

    if (tierCount === 0) {
      return [];
    }

    const actualSize = Math.min(requestedSize, tierCount);

    // Priority weighting: never-dreamed first, then low access count
    // We'll fetch more than needed and sort by priority
    const fetchSize = Math.min(tierCount, actualSize * 3); // Fetch up to 3x for better priority selection

    const memories = await this.prisma.memory.findMany({
      where,
      select,
      take: fetchSize,
      orderBy: [
        // Never dreamed memories first (null values first)
        { lastDreamedAt: 'asc' },
        // Then low access count
        { retrievalCount: 'asc' },
        // Then by creation date (newest first within priority groups)
        { createdAt: 'desc' },
      ],
    });

    // Take only the requested amount from the prioritized list
    return memories.slice(0, actualSize);
  }

  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Get sampling statistics for debugging/monitoring
   */
  async getSamplingStats(userId: string): Promise<{
    totalMemories: number;
    neverDreamed: number;
    dreamedOnce: number;
    dreamedMultiple: number;
    tierCounts: {
      recent: number;
      midRange: number;
      deep: number;
      random: number;
    };
  }> {
    const now = new Date();
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const baseWhere = {
      userId,
      deletedAt: null,
      consolidatedInto: null,
    };

    const [
      totalMemories,
      neverDreamed,
      dreamedOnce,
      dreamedMultiple,
      recentCount,
      midRangeCount,
      deepCount,
      randomCount,
    ] = await Promise.all([
      this.prisma.memory.count({ where: baseWhere }),
      this.prisma.memory.count({
        where: { ...baseWhere, lastDreamedAt: null },
      }),
      this.prisma.memory.count({
        where: {
          ...baseWhere,
          lastDreamedAt: { not: null },
          // This is a simplification - in real implementation, you might track dream count
        },
      }),
      Promise.resolve(0), // Placeholder for multiple dreams - would need additional tracking
      this.prisma.memory.count({
        where: { ...baseWhere, createdAt: { gte: oneMonthAgo } },
      }),
      this.prisma.memory.count({
        where: {
          ...baseWhere,
          createdAt: { gte: sixMonthsAgo, lt: oneMonthAgo },
        },
      }),
      this.prisma.memory.count({
        where: {
          ...baseWhere,
          createdAt: { gte: oneYearAgo, lt: sixMonthsAgo },
        },
      }),
      this.prisma.memory.count({
        where: { ...baseWhere, createdAt: { lt: oneYearAgo } },
      }),
    ]);

    return {
      totalMemories,
      neverDreamed,
      dreamedOnce,
      dreamedMultiple,
      tierCounts: {
        recent: recentCount,
        midRange: midRangeCount,
        deep: deepCount,
        random: randomCount,
      },
    };
  }
}
