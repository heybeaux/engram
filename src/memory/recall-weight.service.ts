import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Memory } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class RecallWeightService {
  private readonly enabled: boolean;

  constructor(private config: ConfigService) {
    const raw = this.config.get<string>(
      'RECALL_TIER_WEIGHT_ENABLED',
      'true',
    );
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
}
