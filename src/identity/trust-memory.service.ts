import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TrustSignalService } from './trust-signal.service';
import { TrustScoreResult } from './identity.types';
import { MemoryLayer, MemorySource, SubjectType } from '@prisma/client';

/**
 * HEY-184: Trust Scores as Living Memory
 *
 * Makes trust scores persistent IDENTITY-layer memories that evolve over time.
 * Instead of just a computed number, trust becomes a living narrative.
 *
 * When trust is recomputed, a memory is created like:
 * "Agent X completed 5 tasks with 100% success rate this week, trust increased from 0.72 to 0.81"
 *
 * These memories feed back into recall and identity profiles.
 */
@Injectable()
export class TrustMemoryService {
  private readonly logger = new Logger(TrustMemoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trustSignal: TrustSignalService,
  ) {}

  /**
   * Recompute trust score and store the delta as an IDENTITY memory.
   * Returns the new score and the created memory (if any).
   */
  async recomputeAndRemember(
    userId: string,
    opts?: { agentId?: string; category?: string },
  ): Promise<{
    score: TrustScoreResult;
    memoryId: string | null;
    narrative: string | null;
  }> {
    // Get previous score
    const previousScore = await this.trustSignal.getLatestScore(userId, opts);

    // Compute new score
    const newScore = await this.trustSignal.computeScore(userId, opts);

    // Build narrative
    const narrative = this.buildNarrative(previousScore, newScore, opts);
    if (!narrative) {
      return { score: newScore, memoryId: null, narrative: null };
    }

    // Store as IDENTITY memory
    const memory = await this.prisma.memory.create({
      data: {
        userId,
        raw: narrative,
        layer: MemoryLayer.IDENTITY,
        memoryType: 'FACT',
        subjectType: opts?.agentId ? SubjectType.AGENT : SubjectType.USER,
        agentId: opts?.agentId ?? null,
        source: MemorySource.AGENT_REFLECTION,
        importanceScore: this.computeImportance(
          previousScore?.score,
          newScore.score,
        ),
        confidence:
          newScore.score > 0 ? Math.min(newScore.signalCount / 10, 1.0) : 0.5,
        metadata: {
          trustScore: true,
          category: opts?.category ?? 'overall',
          previousScore: previousScore?.score ?? null,
          newScore: newScore.score,
          delta: previousScore ? newScore.score - previousScore.score : null,
          signalCount: newScore.signalCount,
          successCount: newScore.successCount,
          failureCount: newScore.failureCount,
          correctionCount: newScore.correctionCount,
        },
      },
    });

    this.logger.log(
      `Trust memory created for ${opts?.agentId ?? 'user'}: ${narrative.slice(0, 100)}...`,
    );

    return { score: newScore, memoryId: memory.id, narrative };
  }

  /**
   * Get the trust narrative history for a user/agent — the living story of trust.
   */
  async getTrustNarrative(
    userId: string,
    opts?: { agentId?: string; category?: string; limit?: number },
  ): Promise<
    Array<{
      id: string;
      narrative: string;
      score: number;
      delta: number | null;
      createdAt: Date;
    }>
  > {
    const where: Record<string, unknown> = {
      userId,
      layer: MemoryLayer.IDENTITY,
      deletedAt: null,
      userHidden: false,
    };

    // Filter by trustScore metadata
    const memories = await this.prisma.memory.findMany({
      where: {
        ...where,
        metadata: { path: ['trustScore'], equals: true },
        ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts?.limit ?? 20,
    });

    // Further filter by category in application layer (JSON path filtering)
    return memories
      .filter((m) => {
        if (!opts?.category) return true;
        const meta = m.metadata as any;
        return meta?.category === opts.category;
      })
      .map((m) => {
        const meta = m.metadata as any;
        return {
          id: m.id,
          narrative: m.raw,
          score: meta?.newScore ?? 0,
          delta: meta?.delta ?? null,
          createdAt: m.createdAt,
        };
      });
  }

  /**
   * Build a human-readable narrative describing the trust score change.
   */
  private buildNarrative(
    previous: TrustScoreResult | null,
    current: TrustScoreResult,
    opts?: { agentId?: string; category?: string },
  ): string | null {
    const subject = opts?.agentId ? `Agent ${opts.agentId}` : 'User';
    const scope = opts?.category ? ` for ${opts.category}` : '';

    if (!previous) {
      // First score computation
      return (
        `${subject} trust score initialized${scope} at ${current.score.toFixed(2)} ` +
        `based on ${current.signalCount} signals ` +
        `(${current.successCount} successes, ${current.failureCount} failures, ` +
        `${current.correctionCount} corrections).`
      );
    }

    const delta = current.score - previous.score;
    if (Math.abs(delta) < 0.005) {
      // No meaningful change — skip memory creation to avoid noise
      return null;
    }

    const direction = delta > 0 ? 'increased' : 'decreased';
    const magnitude =
      Math.abs(delta) > 0.15
        ? 'significantly '
        : Math.abs(delta) > 0.05
          ? ''
          : 'slightly ';

    const newSignals = current.signalCount - previous.signalCount;
    const newSuccesses = current.successCount - previous.successCount;
    const newFailures = current.failureCount - previous.failureCount;

    let detail = '';
    if (newSignals > 0) {
      const parts: string[] = [];
      if (newSuccesses > 0)
        parts.push(`${newSuccesses} success${newSuccesses > 1 ? 'es' : ''}`);
      if (newFailures > 0)
        parts.push(`${newFailures} failure${newFailures > 1 ? 's' : ''}`);
      if (parts.length > 0) {
        detail = ` after ${parts.join(' and ')}`;
      }
    }

    return (
      `${subject} trust${scope} ${magnitude}${direction} from ` +
      `${previous.score.toFixed(2)} to ${current.score.toFixed(2)}${detail}. ` +
      `Total: ${current.signalCount} signals ` +
      `(${current.successCount} successes, ${current.failureCount} failures).`
    );
  }

  /**
   * Higher importance for larger trust changes.
   */
  private computeImportance(
    previousScore: number | undefined,
    newScore: number,
  ): number {
    if (previousScore === undefined) return 0.6;
    const delta = Math.abs(newScore - previousScore);
    if (delta > 0.2) return 0.9;
    if (delta > 0.1) return 0.7;
    if (delta > 0.05) return 0.6;
    return 0.5;
  }
}
