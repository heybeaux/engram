import { Injectable, Logger } from '@nestjs/common';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { SafetyService } from '../safety.service';
import {
  AUTO_MERGE_CONFIDENCE,
  AUTO_CONSOLIDATE_CONFIDENCE_HIGH,
  AUTO_CONSOLIDATE_CONFIDENCE_LOW,
} from './dedup-candidate.model';

export interface ResolutionStats {
  processed: number;
  autoMerged: number;
  autoConsolidated: number;
  queued: number;
  skipped: number;
  errors: number;
}

type MemorySlim = {
  id: string;
  raw: string;
  importanceScore: number;
  userId: string;
  createdAt: Date;
  safetyCritical: boolean;
  memoryType: string | null;
};

/**
 * Dedup Resolution Service — Phase 3 of the Automated Dedup Pipeline
 *
 * Processes CLASSIFIED DedupCandidates and applies the following rules:
 *
 *   DUPLICATE / SUPPORTING
 *     confidence >= 0.7  → auto-merge  (keep higher importance, append unique content, soft-delete loser)
 *     confidence <  0.7  → queue for human review
 *
 *   OVERLAPPING
 *     confidence >= 0.9  → auto-consolidate
 *     confidence 0.7-0.9 → queue
 *     confidence <  0.7  → queue
 *
 *   CONFLICTING          → always queue — never auto-resolve conflicts
 *   RELATED              → no action (resolve immediately)
 *
 * Safety rules:
 *   - CONSTRAINT-type memories are never auto-merged
 *   - Memories with safetyCritical = true are never auto-merged
 *   - All merges create a MemoryMergeEvent with canRollback: true
 */
@Injectable()
export class DedupResolutionService {
  private readonly logger = new Logger(DedupResolutionService.name);
  private readonly BATCH_SIZE = 20;

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly safety: SafetyService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async processClassifiedCandidates(userId?: string): Promise<ResolutionStats> {
    // ENG-34: scope to a specific user when provided to prevent cross-account processing
    const candidates = await this.prisma.dedupCandidate.findMany({
      where: {
        status: 'CLASSIFIED',
        classification: { not: null },
        ...(userId ? { memory1: { userId } } : {}),
      },
      include: {
        memory1: {
          select: {
            id: true,
            raw: true,
            importanceScore: true,
            userId: true,
            createdAt: true,
            safetyCritical: true,
            memoryType: true,
          },
        },
        memory2: {
          select: {
            id: true,
            raw: true,
            importanceScore: true,
            userId: true,
            createdAt: true,
            safetyCritical: true,
            memoryType: true,
          },
        },
      },
      take: this.BATCH_SIZE,
      orderBy: { classifiedAt: 'asc' },
    });

    this.logger.log(
      `[DedupResolution] Processing ${candidates.length} classified candidates`,
    );

    const stats: ResolutionStats = {
      processed: 0,
      autoMerged: 0,
      autoConsolidated: 0,
      queued: 0,
      skipped: 0,
      errors: 0,
    };

    for (const candidate of candidates) {
      try {
        const { classification, memory1, memory2, mergedContent } = candidate;
        const confidence = candidate.confidence ?? 0;

        // Safety gate: never auto-merge safety-critical or CONSTRAINT memories
        if (
          classification !== 'RELATED' &&
          (this.isSafetyCritical(memory1) || this.isSafetyCritical(memory2))
        ) {
          this.logger.log(
            `[DedupResolution] Skipping safety-critical pair: ${candidate.id}`,
          );
          await this.markQueued(candidate.id, 'safety-critical');
          stats.queued++;
          stats.processed++;
          continue;
        }

        switch (classification) {
          case 'DUPLICATE':
          case 'SUPPORTING':
            if (confidence >= AUTO_MERGE_CONFIDENCE) {
              await this.autoMerge(
                candidate.id,
                memory1,
                memory2,
                mergedContent,
                candidate.similarityScore,
              );
              stats.autoMerged++;
            } else {
              await this.markQueued(candidate.id, 'low-confidence');
              stats.queued++;
            }
            break;

          case 'OVERLAPPING':
            if (confidence >= AUTO_CONSOLIDATE_CONFIDENCE_HIGH) {
              await this.autoConsolidate(
                candidate.id,
                memory1,
                memory2,
                mergedContent,
                candidate.similarityScore,
              );
              stats.autoConsolidated++;
            } else if (confidence >= AUTO_CONSOLIDATE_CONFIDENCE_LOW) {
              await this.markQueued(candidate.id, 'overlapping-needs-review');
              stats.queued++;
            } else {
              await this.markQueued(candidate.id, 'low-confidence');
              stats.queued++;
            }
            break;

          case 'CONFLICTING':
            // Always queue — never auto-resolve conflicts
            await this.markQueued(candidate.id, 'conflicting');
            stats.queued++;
            break;

          case 'RELATED':
            // No action needed — mark resolved
            await this.markResolved(candidate.id, 'related-no-action');
            stats.skipped++;
            break;

          default:
            this.logger.warn(
              `[DedupResolution] Unknown classification '${classification}' on candidate ${candidate.id}`,
            );
            stats.skipped++;
        }

        stats.processed++;
      } catch (err) {
        this.logger.error(
          `[DedupResolution] Error resolving candidate ${candidate.id}: ${String(err)}`,
        );
        stats.errors++;
      }
    }

    this.logger.log(
      `[DedupResolution] Done — merged: ${stats.autoMerged}, consolidated: ${stats.autoConsolidated}, queued: ${stats.queued}, skipped: ${stats.skipped}, errors: ${stats.errors}`,
    );

    return stats;
  }

  // ---------------------------------------------------------------------------
  // Private resolution helpers
  // ---------------------------------------------------------------------------

  /**
   * Auto-merge: keep higher-importance memory, append unique content from loser,
   * soft-delete the loser, create MemoryMergeEvent with canRollback: true.
   */
  private async autoMerge(
    candidateId: string,
    memory1: MemorySlim,
    memory2: MemorySlim,
    mergedContent: string | null,
    similarityScore: number,
  ): Promise<void> {
    const [winner, loser] = this.pickWinnerLoser(memory1, memory2);
    const finalContent =
      mergedContent ?? this.appendUniqueContent(winner.raw, loser.raw);

    await this.prisma.$transaction([
      // Update winner with merged content
      this.prisma.memory.update({
        where: { id: winner.id },
        data: { raw: finalContent },
      }),
      // Soft-delete loser
      this.prisma.memory.update({
        where: { id: loser.id },
        data: { deletedAt: new Date() },
      }),
      // Create rollback-capable merge event
      this.prisma.memoryMergeEvent.create({
        data: {
          userId: winner.userId,
          survivorMemoryId: winner.id,
          absorbedMemoryIds: [loser.id],
          strategy: 'KEEP_IMPORTANCE',
          similarity: similarityScore,
          triggeredBy: 'auto',
          originalContents: JSON.stringify([
            {
              memoryId: loser.id,
              content: loser.raw,
              createdAt: loser.createdAt,
            },
          ]),
          mergedContent: finalContent,
          contentChanged: finalContent !== winner.raw,
          canRollback: true,
        },
      }),
      // Mark candidate resolved
      this.prisma.dedupCandidate.update({
        where: { id: candidateId },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          reasoning: `Auto-merged ${loser.id} into ${winner.id}`,
        },
      }),
    ]);

    this.logger.log(`[DedupResolution] Auto-merged ${loser.id} → ${winner.id}`);
  }

  /**
   * Auto-consolidate: combine overlapping memories into a richer single memory.
   */
  private async autoConsolidate(
    candidateId: string,
    memory1: MemorySlim,
    memory2: MemorySlim,
    mergedContent: string | null,
    similarityScore: number,
  ): Promise<void> {
    const [winner, loser] = this.pickWinnerLoser(memory1, memory2);
    const consolidated =
      mergedContent ?? `${winner.raw}\n\n[Consolidated from: ${loser.raw}]`;

    await this.prisma.$transaction([
      this.prisma.memory.update({
        where: { id: winner.id },
        data: { raw: consolidated },
      }),
      this.prisma.memory.update({
        where: { id: loser.id },
        data: { deletedAt: new Date() },
      }),
      // Create rollback-capable merge event
      this.prisma.memoryMergeEvent.create({
        data: {
          userId: winner.userId,
          survivorMemoryId: winner.id,
          absorbedMemoryIds: [loser.id],
          strategy: 'COMBINE_METADATA',
          similarity: similarityScore,
          triggeredBy: 'auto',
          originalContents: JSON.stringify([
            {
              memoryId: loser.id,
              content: loser.raw,
              createdAt: loser.createdAt,
            },
          ]),
          mergedContent: consolidated,
          contentChanged: consolidated !== winner.raw,
          canRollback: true,
        },
      }),
      this.prisma.dedupCandidate.update({
        where: { id: candidateId },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          reasoning: `Auto-consolidated ${loser.id} → ${winner.id}`,
        },
      }),
    ]);

    this.logger.log(
      `[DedupResolution] Auto-consolidated ${loser.id} → ${winner.id}`,
    );
  }

  private async markResolved(
    candidateId: string,
    reasoning: string,
  ): Promise<void> {
    await this.prisma.dedupCandidate.update({
      where: { id: candidateId },
      data: { status: 'RESOLVED', resolvedAt: new Date(), reasoning },
    });
  }

  private async markQueued(
    candidateId: string,
    reasoning: string,
  ): Promise<void> {
    await this.prisma.dedupCandidate.update({
      where: { id: candidateId },
      data: { status: 'QUEUED', reasoning },
    });
  }

  // ---------------------------------------------------------------------------
  // Safety utilities
  // ---------------------------------------------------------------------------

  /**
   * Returns true if this memory must never be auto-merged.
   * CONSTRAINT-type and safetyCritical memories are always protected.
   */
  private isSafetyCritical(memory: MemorySlim): boolean {
    if (memory.safetyCritical) return true;
    if (memory.memoryType === 'CONSTRAINT') return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Merge utilities
  // ---------------------------------------------------------------------------

  /**
   * Pick winner (higher importanceScore; tie-break: newer createdAt).
   */
  private pickWinnerLoser(
    a: MemorySlim,
    b: MemorySlim,
  ): [winner: MemorySlim, loser: MemorySlim] {
    if (a.importanceScore > b.importanceScore) return [a, b];
    if (b.importanceScore > a.importanceScore) return [b, a];
    return a.createdAt >= b.createdAt ? [a, b] : [b, a];
  }

  /**
   * Append content from loser that doesn't already appear in winner.
   */
  private appendUniqueContent(winnerRaw: string, loserRaw: string): string {
    if (winnerRaw.includes(loserRaw.trim())) return winnerRaw;
    return `${winnerRaw}\n\n${loserRaw}`;
  }
}
