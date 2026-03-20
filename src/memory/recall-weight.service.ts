import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Memory, MemoryDurability } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RankedMemory {
  memory: Memory;
  score: number;
  metadata?: Record<string, any>;
}

export interface UsageWeightConfig {
  /** Overall weight for usage signal in final score (default 0.15) */
  usageWeight: number;
  /** Half-life for recency decay in days (default 14) */
  recencyHalfLifeDays: number;
  /** Multiplier for usedCount vs retrievalCount (default 2) */
  usedCountMultiplier: number;
  /** Boost factor for positive feedback (default 1.5) */
  feedbackBoost: number;
  /** Penalty factor for negative feedback (default 0.5) */
  feedbackPenalty: number;
  /** Minimum retrievals before usage weighting kicks in (default 3) */
  minRetrievals: number;
}

@Injectable()
export class RecallWeightService {
  private readonly logger = new Logger(RecallWeightService.name);
  private readonly enabled: boolean;
  private readonly usageConfig: UsageWeightConfig;

  // ENG-31: Durability boost configuration
  private readonly durabilityBoostEnabled: boolean;
  private readonly durableBoost: number;
  private readonly ephemeralPenalty: number;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    const raw = this.config.get<string>('RECALL_TIER_WEIGHT_ENABLED', 'true');
    this.enabled = raw !== 'false';

    // ENG-31: Durability boost configuration
    this.durabilityBoostEnabled =
      this.config.get<string>('DURABILITY_BOOST_ENABLED', 'false') === 'true';
    this.durableBoost = parseFloat(
      this.config.get('DURABLE_BOOST_MULTIPLIER', '1.5'),
    );
    this.ephemeralPenalty = parseFloat(
      this.config.get('EPHEMERAL_PENALTY_MULTIPLIER', '0.6'),
    );

    // ENG-27: Usage-weighted retrieval configuration
    this.usageConfig = {
      usageWeight: parseFloat(this.config.get('USAGE_WEIGHT', '0.15')),
      recencyHalfLifeDays: parseFloat(
        this.config.get('USAGE_RECENCY_HALFLIFE_DAYS', '14'),
      ),
      usedCountMultiplier: parseFloat(
        this.config.get('USAGE_USED_COUNT_MULTIPLIER', '2'),
      ),
      feedbackBoost: parseFloat(this.config.get('USAGE_FEEDBACK_BOOST', '1.5')),
      feedbackPenalty: parseFloat(
        this.config.get('USAGE_FEEDBACK_PENALTY', '0.5'),
      ),
      minRetrievals: parseInt(this.config.get('USAGE_MIN_RETRIEVALS', '3'), 10),
    };
  }

  /**
   * Calculate a recall weight multiplier (0.0–1.0) based on memory tier.
   *
   * Tiers (evaluated in order):
   *  - Pinned:   1.0
   *  - HOT:      1.0  (lastRetrievedAt ≤ 7 days)
   *  - WARM:     0.9  (lastRetrievedAt ≤ 30 days)
   *  - COOLING:  0.75 (lastRetrievedAt ≤ 90 days)
   *  - FREQUENT: 0.8  (retrievalCount / ageInDays > 0.1)
   *  - COLD:     0.6
   */
  recallWeight(memory: Memory): number {
    if (!this.enabled) return 1.0 * this.durabilityMultiplier(memory);

    let weight: number;

    if (memory.userPinned) {
      weight = 1.0;
    } else {
      const now = Date.now();
      const lastAccessed = memory.lastRetrievedAt
        ? memory.lastRetrievedAt.getTime()
        : 0;
      const daysSinceAccess = lastAccessed
        ? (now - lastAccessed) / DAY_MS
        : Infinity;

      if (daysSinceAccess <= 7) weight = 1.0;
      else if (daysSinceAccess <= 30) weight = 0.9;
      else if (daysSinceAccess <= 90) weight = 0.75;
      else {
        // Frequency boost
        const ageInDays = Math.max(
          1,
          (now - memory.createdAt.getTime()) / DAY_MS,
        );
        weight = memory.retrievalCount / ageInDays > 0.1 ? 0.8 : 0.6;
      }
    }

    return weight * this.durabilityMultiplier(memory);
  }

  /**
   * ENG-31: Return a score multiplier based on memory durability classification.
   * DURABLE → boost, EPHEMERAL → penalty, UNCLASSIFIED → neutral.
   * Gated by DURABILITY_BOOST_ENABLED env var (default false).
   */
  durabilityMultiplier(memory: Memory): number {
    if (!this.durabilityBoostEnabled) return 1.0;

    const durability = (memory as any).durability as
      | MemoryDurability
      | undefined;
    if (durability === MemoryDurability.DURABLE) return this.durableBoost;
    if (durability === MemoryDurability.EPHEMERAL) return this.ephemeralPenalty;
    return 1.0;
  }

  /**
   * ENG-27: Calculate a usage-based signal for a memory.
   *
   * Combines:
   * - usedCount (weighted higher — actual usage > mere retrieval)
   * - retrievalCount
   * - recency decay (recent usage matters more)
   *
   * Returns a value in [0, 1] representing usage strength.
   */
  usageSignal(memory: Memory): number {
    // Don't boost memories without enough retrieval data (cold-start protection)
    if (memory.retrievalCount < this.usageConfig.minRetrievals) return 0;

    const now = Date.now();
    const { usedCountMultiplier, recencyHalfLifeDays } = this.usageConfig;

    // Raw usage score: usedCount is weighted higher than retrievalCount
    const rawUsage =
      memory.usedCount * usedCountMultiplier + memory.retrievalCount;

    // Recency decay: exp(-lambda * days) where lambda = ln(2) / halfLife
    const lambda = Math.LN2 / recencyHalfLifeDays;
    const lastUsedTime =
      memory.lastUsedAt?.getTime() ??
      memory.lastRetrievedAt?.getTime() ??
      memory.createdAt.getTime();
    const daysSinceUse = (now - lastUsedTime) / DAY_MS;
    const recencyDecay = Math.exp(-lambda * daysSinceUse);

    // Apply recency to raw usage
    const decayedUsage = rawUsage * recencyDecay;

    // Normalize: use a sigmoid-like function to cap at 1.0
    // At 20 weighted interactions with no decay, this hits ~0.87
    // At 50, ~0.96. This prevents any single memory from dominating.
    const normalized = decayedUsage / (decayedUsage + 10);

    return normalized;
  }

  /**
   * ENG-27: Apply usage-weighted re-ranking to scored memories.
   *
   * Blends the original score with the usage signal:
   *   final = original * (1 - usageWeight) + usageSignal * usageWeight
   *
   * Also applies feedback adjustments: positive feedback boosts,
   * negative feedback suppresses.
   */
  async applyUsageWeighting(
    memories: Array<{ id: string; score: number; [key: string]: any }>,
  ): Promise<
    Array<{
      id: string;
      score: number;
      usageBoost?: number;
      [key: string]: any;
    }>
  > {
    if (this.usageConfig.usageWeight === 0) return memories;
    if (memories.length === 0) return memories;

    // Batch-fetch feedback for all memories
    const memoryIds = memories.map((m) => m.id);
    const feedbackMap = await this.batchFetchFeedback(memoryIds);

    const weighted = memories.map((memory) => {
      const usage = this.usageSignal(memory as any);
      const feedback = feedbackMap.get(memory.id);

      // Apply feedback modifier
      let feedbackModifier = 1.0;
      if (feedback) {
        if (feedback.netPositive > 0) {
          feedbackModifier = this.usageConfig.feedbackBoost;
        } else if (feedback.netPositive < 0) {
          feedbackModifier = this.usageConfig.feedbackPenalty;
        }
      }

      const adjustedUsage = Math.min(1.0, usage * feedbackModifier);
      const usageWeight = this.usageConfig.usageWeight;

      // Blend: original score + usage signal
      const originalScore = memory.score;
      const finalScore =
        originalScore * (1 - usageWeight) + adjustedUsage * usageWeight;

      return {
        ...memory,
        score: finalScore,
        usageBoost: finalScore - originalScore,
      };
    });

    // Re-sort by new scores
    weighted.sort((a, b) => b.score - a.score);

    return weighted;
  }

  /**
   * Batch-fetch feedback summary for a set of memory IDs.
   * Returns net positive/negative count per memory.
   */
  private async batchFetchFeedback(
    memoryIds: string[],
  ): Promise<Map<string, { netPositive: number }>> {
    const result = new Map<string, { netPositive: number }>();
    if (memoryIds.length === 0) return result;

    try {
      const feedbacks = await this.prisma.feedback.groupBy({
        by: ['memoryId', 'wasHelpful'],
        where: { memoryId: { in: memoryIds }, wasHelpful: { not: null } },
        _count: { wasHelpful: true },
      });

      // Aggregate: helpful (+1 each) vs not-helpful (-1 each)
      for (const fb of feedbacks) {
        const prev = result.get(fb.memoryId)?.netPositive ?? 0;
        const delta =
          fb.wasHelpful === true ? fb._count.wasHelpful : -fb._count.wasHelpful;
        result.set(fb.memoryId, { netPositive: prev + delta });
      }
    } catch (error) {
      this.logger.warn(
        `[RecallWeight] Failed to fetch feedback: ${(error as Error).message}`,
      );
    }

    return result;
  }

  /**
   * Resolve dream/consolidation memories to their source facts via derivativeOf links.
   * When a dream-generated memory scores high in recall results, replace it with its
   * source facts instead of returning the verbose dream summary.
   */
  async resolveDerivatives(results: RankedMemory[]): Promise<RankedMemory[]> {
    const resolved: RankedMemory[] = [];
    const seenIds = new Set<string>();

    for (const result of results) {
      // Check if this is a dream/consolidation memory
      if (
        (result.memory.source as any) === 'DREAM_CYCLE' ||
        (result.memory.source as any) === 'CONSOLIDATION'
      ) {
        // Get derivativeOf IDs from metadata
        const sourceIds: string[] =
          (result.memory.metadata as any)?.derivativeOf ?? [];

        if (sourceIds.length > 0) {
          // Fetch source memories
          const sources = await this.prisma.memory.findMany({
            where: { id: { in: sourceIds } },
            take: 3, // Cap at 3 source facts per dream memory
          });

          // Replace dream memory with its sources, inheriting rank score
          for (const source of sources) {
            if (!seenIds.has(source.id)) {
              seenIds.add(source.id);
              resolved.push({
                ...result,
                memory: source,
                metadata: {
                  ...result.metadata,
                  resolved: true,
                  resolvedFrom: result.memory.id,
                },
              });
            }
          }
        } else {
          // No derivativeOf links — keep the dream memory as-is
          if (!seenIds.has(result.memory.id)) {
            seenIds.add(result.memory.id);
            resolved.push(result);
          }
        }
      } else {
        // Not a derivative — pass through
        if (!seenIds.has(result.memory.id)) {
          seenIds.add(result.memory.id);
          resolved.push(result);
        }
      }
    }
    return resolved;
  }
}
