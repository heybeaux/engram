import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Memory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RankedMemory {
  memory: Memory;
  score: number;
  metadata?: Record<string, any>;
}

@Injectable()
export class RecallWeightService {
  private readonly enabled: boolean;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    const raw = this.config.get<string>('RECALL_TIER_WEIGHT_ENABLED', 'true');
    this.enabled = raw !== 'false';
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
    if (!this.enabled) return 1.0;

    if (memory.userPinned) return 1.0;

    const now = Date.now();
    const lastAccessed = memory.lastRetrievedAt
      ? memory.lastRetrievedAt.getTime()
      : 0;
    const daysSinceAccess = lastAccessed
      ? (now - lastAccessed) / DAY_MS
      : Infinity;

    if (daysSinceAccess <= 7) return 1.0;
    if (daysSinceAccess <= 30) return 0.9;
    if (daysSinceAccess <= 90) return 0.75;

    // Frequency boost
    const ageInDays = Math.max(1, (now - memory.createdAt.getTime()) / DAY_MS);
    if (memory.retrievalCount / ageInDays > 0.1) return 0.8;

    return 0.6;
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
