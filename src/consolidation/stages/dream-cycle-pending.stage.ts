import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { LLMService } from '../../llm/llm.service';

export interface PendingStageResult {
  processed: number;
  autoMerged: number;
  autoRejected: number;
  llmEvaluated: number;
  llmMerged: number;
  llmRejected: number;
  llmCalls: number;
  errors: number;
}

@Injectable()
export class DreamCyclePendingStage {
  private readonly logger = new Logger(DreamCyclePendingStage.name);
  private readonly batchSize: number;

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly llm: LLMService,
    private readonly config: ConfigService,
  ) {
    this.batchSize = parseInt(
      this.config.get('DREAM_PENDING_BATCH_SIZE') ?? '100',
      10,
    );
  }

  async run(
    userId: string,
    dryRun: boolean,
    maxLlmCalls?: number,
  ): Promise<PendingStageResult> {
    let processed = 0;
    let autoMerged = 0;
    let autoRejected = 0;
    let llmEvaluated = 0;
    let llmMerged = 0;
    let llmRejected = 0;
    let llmCalls = 0;
    let errors = 0;

    this.logger.log(
      `Starting PENDING merge resolution for user ${userId} (dryRun: ${dryRun})`,
    );

    // Get PENDING merge candidates
    const pendingCandidates = await this.prisma.mergeCandidate.findMany({
      where: {
        userId,
        status: 'PENDING',
      },
      take: this.batchSize,
      orderBy: { createdAt: 'asc' },
    });

    if (pendingCandidates.length === 0) {
      this.logger.log(`No PENDING merge candidates found for user ${userId}`);
      return {
        processed: 0,
        autoMerged: 0,
        autoRejected: 0,
        llmEvaluated: 0,
        llmMerged: 0,
        llmRejected: 0,
        llmCalls: 0,
        errors: 0,
      };
    }

    this.logger.log(
      `Found ${pendingCandidates.length} PENDING merge candidates to process`,
    );

    for (const candidate of pendingCandidates) {
      try {
        processed++;
        this.logger.debug(
          `Processing candidate ${candidate.id} with similarity ${candidate.similarity.toFixed(3)}`,
        );

        if (candidate.similarity >= 0.9) {
          // Auto-merge for high similarity
          this.logger.log(
            `Auto-merging candidate ${candidate.id} (similarity: ${candidate.similarity.toFixed(3)})`,
          );
          if (!dryRun) {
            await this.performMerge(candidate, 'auto_high_similarity');
            await this.updateCandidateStatus(
              candidate.id,
              'MERGED',
              'Auto-merged: similarity >= 0.90',
            );
            await this.updateMemoriesLastDreamedAt(candidate.memoryIds, userId);
          }
          autoMerged++;
        } else if (candidate.similarity < 0.82) {
          // Auto-reject for low similarity
          this.logger.log(
            `Auto-rejecting candidate ${candidate.id} (similarity: ${candidate.similarity.toFixed(3)})`,
          );
          if (!dryRun) {
            await this.updateCandidateStatus(
              candidate.id,
              'REJECTED',
              'Auto-rejected: similarity < 0.82',
            );
            await this.updateMemoriesLastDreamedAt(candidate.memoryIds, userId);
          }
          autoRejected++;
        } else if (maxLlmCalls && llmCalls < maxLlmCalls) {
          // LLM evaluation for medium similarity (0.82-0.90)
          this.logger.log(
            `Sending candidate ${candidate.id} for LLM evaluation (similarity: ${candidate.similarity.toFixed(3)})`,
          );
          llmEvaluated++;
          const shouldMerge = await this.llmMergeDecision(candidate);
          llmCalls++;

          if (shouldMerge) {
            this.logger.log(`LLM approved merge for candidate ${candidate.id}`);
            if (!dryRun) {
              await this.performMerge(candidate, 'llm_approved');
              await this.updateCandidateStatus(
                candidate.id,
                'MERGED',
                'LLM approved merge',
              );
              await this.updateMemoriesLastDreamedAt(
                candidate.memoryIds,
                userId,
              );
            }
            llmMerged++;
          } else {
            this.logger.log(`LLM declined merge for candidate ${candidate.id}`);
            if (!dryRun) {
              await this.updateCandidateStatus(
                candidate.id,
                'REJECTED',
                'LLM declined merge',
              );
              await this.updateMemoriesLastDreamedAt(
                candidate.memoryIds,
                userId,
              );
            }
            llmRejected++;
          }
        } else {
          // Skip if we've reached LLM call limit
          this.logger.log(
            `Skipping candidate ${candidate.id} - reached LLM call limit (${llmCalls}/${maxLlmCalls})`,
          );
          break;
        }
      } catch (err) {
        errors++;
        const errorMsg = `Error processing merge candidate ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.error(errorMsg);

        // Ensure lastDreamedAt is updated even on error (for tracking purposes)
        if (!dryRun) {
          try {
            await this.updateMemoriesLastDreamedAt(candidate.memoryIds, userId);
          } catch (updateErr) {
            this.logger.error(
              `Failed to update lastDreamedAt for candidate ${candidate.id}: ${updateErr}`,
            );
          }
        }
      }
    }

    const result = {
      processed,
      autoMerged,
      autoRejected,
      llmEvaluated,
      llmMerged,
      llmRejected,
      llmCalls,
      errors,
    };

    this.logger.log(`PENDING resolution complete: ${JSON.stringify(result)}`);

    return result;
  }

  private async performMerge(
    candidate: {
      id: string;
      userId: string;
      memoryIds: string[];
      suggestedSurvivorId: string;
    },
    strategy: string,
  ): Promise<void> {
    // Get memory details to determine survivor and absorbed memories
    const memories = await this.prisma.memory.findMany({
      where: {
        id: { in: candidate.memoryIds },
        userId: candidate.userId,
        deletedAt: null,
      },
      select: {
        id: true,
        raw: true,
        effectiveScore: true,
      },
    });

    if (memories.length !== candidate.memoryIds.length) {
      throw new Error('Some memories not found or already deleted');
    }

    // Use suggested survivor or fall back to highest score
    const survivorId =
      candidate.suggestedSurvivorId ||
      memories.reduce((prev, current) =>
        prev.effectiveScore > current.effectiveScore ? prev : current,
      ).id;

    const survivor = memories.find((m) => m.id === survivorId)!;
    const absorbed = memories.filter((m) => m.id !== survivorId);

    this.logger.debug(
      `Merging memories: survivor=${survivor.id}, absorbed=[${absorbed.map((a) => a.id).join(', ')}]`,
    );

    // Create merge event
    await this.prisma.memoryMergeEvent.create({
      data: {
        userId: candidate.userId,
        survivorMemoryId: survivor.id,
        absorbedMemoryIds: absorbed.map((m) => m.id),
        strategy: `pending_resolution_${strategy}`,
        similarity: 0, // Not applicable for pending resolution
        triggeredBy: 'dream_cycle',
        originalContents: JSON.stringify({
          survivor: survivor.raw,
          absorbed: absorbed.map((m) => ({ id: m.id, content: m.raw })),
        }),
        mergedContent: survivor.raw,
        canRollback: true,
      },
    });

    // Mark absorbed memories as consolidated
    for (const absorbedMemory of absorbed) {
      await this.prisma.memory.update({
        where: { id: absorbedMemory.id },
        data: {
          consolidatedInto: survivor.id,
          deletedAt: new Date(),
          lastDreamedAt: new Date(),
        },
      });
    }

    // Update survivor memory
    await this.prisma.memory.update({
      where: { id: survivor.id },
      data: { lastDreamedAt: new Date() },
    });
  }

  private async updateCandidateStatus(
    candidateId: string,
    status: string,
    reviewNotes: string,
  ): Promise<void> {
    await this.prisma.mergeCandidate.update({
      where: { id: candidateId },
      data: {
        status,
        reviewedAt: new Date(),
        reviewNotes,
        reviewedBy: 'dream_cycle',
      },
    });
  }

  private async updateMemoriesLastDreamedAt(
    memoryIds: string[],
    userId: string,
  ): Promise<void> {
    if (memoryIds.length === 0) return;

    const updatedCount = await this.prisma.memory.updateMany({
      where: {
        id: { in: memoryIds },
        userId,
        deletedAt: null,
      },
      data: {
        lastDreamedAt: new Date(),
      },
    });

    this.logger.debug(
      `Updated lastDreamedAt for ${updatedCount.count} memories`,
    );
  }

  private async llmMergeDecision(candidate: {
    userId: string;
    memoryIds: string[];
    similarity: number;
  }): Promise<boolean> {
    try {
      // Get memory contents
      const memories = await this.prisma.memory.findMany({
        where: {
          id: { in: candidate.memoryIds },
          userId: candidate.userId,
          deletedAt: null,
        },
        select: {
          id: true,
          raw: true,
          memoryType: true,
          safetyCritical: true,
        },
      });

      if (memories.length !== 2) {
        this.logger.warn(
          `Expected 2 memories for LLM evaluation, found ${memories.length}`,
        );
        return false; // Only handle pairs for now
      }

      const [memoryA, memoryB] = memories;

      // Safety check - don't merge critical memories
      if (memoryA.safetyCritical || memoryB.safetyCritical) {
        this.logger.log(`Declining merge for safety-critical memories`);
        return false;
      }

      const result = await this.llm.json<{
        shouldMerge: boolean;
        confidence: number;
        reason: string;
      }>(
        [
          {
            role: 'system',
            content: `You are evaluating whether two memories should be merged. This is a marginal case (similarity ${candidate.similarity.toFixed(3)}) that requires careful consideration.

Consider:
- Are they the same core fact with different wording?
- Would merging lose important information?
- Are there subtle but meaningful differences?

Respond with JSON: { "shouldMerge": boolean, "confidence": number (0-1), "reason": "brief explanation" }`,
          },
          {
            role: 'user',
            content: `Memory A (${memoryA.memoryType || 'FACT'}): ${memoryA.raw}

Memory B (${memoryB.memoryType || 'FACT'}): ${memoryB.raw}

Similarity score: ${candidate.similarity.toFixed(3)}

Should these be merged?`,
          },
        ],
        undefined,
        { temperature: 0.1, maxTokens: 200 },
      );

      const shouldMerge = result.shouldMerge && result.confidence >= 0.7;
      this.logger.debug(
        `LLM decision: shouldMerge=${shouldMerge}, confidence=${result.confidence}, reason="${result.reason}"`,
      );

      return shouldMerge;
    } catch (err) {
      const errorMsg = `LLM merge decision failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.error(errorMsg);
      return false; // Conservative fallback
    }
  }
}
