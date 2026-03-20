import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ChallengeStatus,
  ChallengeInput,
  ChallengeResolution,
  ChallengeResult,
} from './challenge.types';

/**
 * HEY-186: Challenge Protocol
 *
 * Allows agents to challenge each other's memories or claims.
 * Challenges are stored in a dedicated table and tracked through resolution.
 *
 * Uses the generic `metadata` JSON column on Memory to track disputed state,
 * and a dedicated `memory_challenges` table for challenge records.
 *
 * Since we can't run prisma migrate, this service uses raw SQL for the
 * memory_challenges table, which must be created via migration later.
 * For now, we store challenges as INSIGHT-layer memories with structured metadata.
 */
@Injectable()
export class ChallengeService {
  private readonly logger = new Logger(ChallengeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a challenge against a memory.
   */
  async createChallenge(
    userId: string,
    memoryId: string,
    input: ChallengeInput,
  ): Promise<ChallengeResult> {
    // Verify the memory exists and belongs to the user
    const memory = await this.prisma.memory.findFirst({
      where: { id: memoryId, userId, deletedAt: null },
    });

    if (!memory) {
      throw new NotFoundException(`Memory ${memoryId} not found`);
    }

    // Don't allow challenging already-deleted or superseded memories
    if (memory.supersededById) {
      throw new BadRequestException('Cannot challenge a superseded memory');
    }

    // Store challenge as an INSIGHT memory with structured metadata
    const challengeMemory = await this.prisma.memory.create({
      data: {
        userId,
        raw: `[Challenge] Memory "${memory.raw.slice(0, 100)}..." challenged by ${input.challengerId}: ${input.reason}`,
        layer: 'INSIGHT',
        memoryType: 'FACT',
        source: 'SYSTEM',
        subjectType: 'USER',
        importanceScore: 0.8,
        confidence: 0.5, // Low confidence since it's a dispute
        metadata: {
          challenge: true,
          challengerId: input.challengerId,
          targetMemoryId: memoryId,
          reason: input.reason,
          evidence: input.evidence ?? null,
          status: ChallengeStatus.OPEN,
          resolution: null,
          resolvedBy: null,
          resolvedAt: null,
        },
      },
    });

    // Mark the original memory as disputed in its metadata
    const existingMeta = (memory.metadata as any) ?? {};
    await this.prisma.memory.update({
      where: { id: memoryId },
      data: {
        metadata: {
          ...existingMeta,
          disputed: true,
          challengeIds: [
            ...((existingMeta.challengeIds as string[]) ?? []),
            challengeMemory.id,
          ],
        },
        confidence: Math.max(0.1, memory.confidence - 0.2), // Reduce confidence while disputed
      },
    });

    this.logger.log(
      `Challenge created: ${challengeMemory.id} against memory ${memoryId}`,
    );

    return this.toChallengeResult(challengeMemory);
  }

  /**
   * List all challenges, optionally filtered by status.
   */
  async listChallenges(
    userId: string,
    opts?: { status?: ChallengeStatus; limit?: number; offset?: number },
  ): Promise<ChallengeResult[]> {
    const memories = await this.prisma.memory.findMany({
      where: {
        userId,
        deletedAt: null,
        metadata: { path: ['challenge'], equals: true },
        ...(opts?.status
          ? { metadata: { path: ['challenge'], equals: true } } // Will filter in app layer
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts?.limit ?? 50,
      skip: opts?.offset ?? 0,
    });

    return memories
      .filter((m) => {
        if (!opts?.status) return true;
        const meta = m.metadata as any;
        return meta?.status === opts.status;
      })
      .map((m) => this.toChallengeResult(m));
  }

  /**
   * Get a specific challenge by its ID.
   */
  async getChallenge(
    userId: string,
    challengeId: string,
  ): Promise<ChallengeResult> {
    const memory = await this.prisma.memory.findFirst({
      where: {
        id: challengeId,
        userId,
        deletedAt: null,
        metadata: { path: ['challenge'], equals: true },
      },
    });

    if (!memory) {
      throw new NotFoundException(`Challenge ${challengeId} not found`);
    }

    return this.toChallengeResult(memory);
  }

  /**
   * Resolve a challenge.
   */
  async resolveChallenge(
    userId: string,
    challengeId: string,
    resolution: ChallengeResolution,
  ): Promise<ChallengeResult> {
    const memory = await this.prisma.memory.findFirst({
      where: {
        id: challengeId,
        userId,
        deletedAt: null,
        metadata: { path: ['challenge'], equals: true },
      },
    });

    if (!memory) {
      throw new NotFoundException(`Challenge ${challengeId} not found`);
    }

    const meta = memory.metadata as any;
    if (
      meta.status !== ChallengeStatus.OPEN &&
      meta.status !== ChallengeStatus.UNDER_REVIEW
    ) {
      throw new BadRequestException('Challenge is already resolved');
    }

    // Update challenge memory
    const updatedMemory = await this.prisma.memory.update({
      where: { id: challengeId },
      data: {
        raw: `${memory.raw} [Resolved: ${resolution.status} — ${resolution.resolution}]`,
        metadata: {
          ...meta,
          status: resolution.status,
          resolution: resolution.resolution,
          resolvedBy: resolution.resolvedBy,
          resolvedAt: new Date().toISOString(),
          method: resolution.method,
        },
      },
    });

    // If upheld, further reduce confidence of original memory
    // If dismissed, restore confidence
    const targetMemoryId = meta.targetMemoryId as string;
    if (targetMemoryId) {
      const targetMemory = await this.prisma.memory.findUnique({
        where: { id: targetMemoryId },
      });
      if (targetMemory) {
        const targetMeta = (targetMemory.metadata as any) ?? {};
        const challengeIds = (targetMeta.challengeIds as string[]) ?? [];

        if (resolution.status === ChallengeStatus.UPHELD) {
          await this.prisma.memory.update({
            where: { id: targetMemoryId },
            data: {
              confidence: Math.max(0.05, targetMemory.confidence - 0.3),
              metadata: { ...targetMeta, disputed: true },
            },
          });
        } else if (resolution.status === ChallengeStatus.DISMISSED) {
          // Check if there are other open challenges
          const remainingOpen = challengeIds.filter((id) => id !== challengeId);
          await this.prisma.memory.update({
            where: { id: targetMemoryId },
            data: {
              confidence: Math.min(1.0, targetMemory.confidence + 0.2),
              metadata: {
                ...targetMeta,
                disputed: remainingOpen.length > 0,
              },
            },
          });
        }
      }
    }

    this.logger.log(`Challenge ${challengeId} resolved: ${resolution.status}`);

    return this.toChallengeResult(updatedMemory);
  }

  private toChallengeResult(memory: any): ChallengeResult {
    const meta = memory.metadata;
    return {
      id: memory.id,
      challengerId: (meta.challengerId as string) ?? '',
      memoryId: (meta.targetMemoryId as string) ?? '',
      reason: (meta.reason as string) ?? '',
      evidence: (meta.evidence as string) ?? null,
      status: (meta.status as ChallengeStatus) ?? ChallengeStatus.OPEN,
      resolution: (meta.resolution as string) ?? null,
      resolvedBy: (meta.resolvedBy as string) ?? null,
      resolvedAt: meta.resolvedAt ? new Date(meta.resolvedAt as string) : null,
      createdAt: memory.createdAt,
    };
  }
}
