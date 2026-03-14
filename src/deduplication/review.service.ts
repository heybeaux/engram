import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MergeService, MergeResult } from './merge.service';
import { LineageService } from './lineage.service';
import { SafetyService } from './safety.service';
import {
  MergeStrategy,
  CandidateStatus,
  MergeCandidateDto,
  ListCandidatesResponseDto,
  ApproveRequestDto,
  ApproveResponseDto,
  RejectRequestDto,
  RejectResponseDto,
  SafetyReasonDto,
  MemorySummaryDto,
} from './dto/deduplication.dto';
import { MemoryCluster } from './similarity.service';

/**
 * Review Service
 *
 * Manages the merge candidate review queue.
 * Handles approve/reject/skip workflows.
 */
@Injectable()
export class ReviewService {
  constructor(
    private prisma: PrismaService,
    private mergeService: MergeService,
    private lineageService: LineageService,
    private safetyService: SafetyService,
  ) {}

  /**
   * Resolve a userId to an internal CUID.
   * If the value is already a CUID (starts with 'cm'), return as-is.
   * Otherwise look it up as an externalId.
   */
  private async resolveUserId(userId: string): Promise<string> {
    if (!userId) return userId;
    if (userId.startsWith('cm')) return userId;
    const user = await this.prisma.user.findFirst({
      where: { externalId: userId, deletedAt: null },
      select: { id: true },
    });
    return user?.id ?? userId;
  }

  /**
   * Resolve all internal CUIDs for a given userId, including deleted users
   * with the same externalId. This ensures we find candidates created under
   * previous user records (e.g., after agent migration or user recreation).
   */
  private async resolveAllUserIds(userId: string): Promise<string[]> {
    // If it's already a CUID, look up its externalId first
    let externalId: string | null;
    if (userId.startsWith('cm')) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { externalId: true },
      });
      externalId = user?.externalId ?? null;
    } else {
      externalId = userId;
    }

    if (!externalId) return [userId];

    // Find all user records (active and deleted) with this externalId
    const users = await this.prisma.user.findMany({
      where: { externalId },
      select: { id: true },
    });

    if (users.length === 0) return [userId];
    return users.map((u) => u.id);
  }

  /**
   * Queue a pair of memories for review
   */
  async queuePairForReview(
    userId: string,
    memoryIdA: string,
    memoryIdB: string,
    similarity: number,
  ): Promise<MergeCandidateDto> {
    // Check safety for both memories
    const [safetyA, safetyB] = await Promise.all([
      this.safetyService.checkMemorySafety(memoryIdA),
      this.safetyService.checkMemorySafety(memoryIdB),
    ]);

    const safetyFlags = [...safetyA.reasons, ...safetyB.reasons];

    // Fetch memory details
    const memories = await this.prisma.memory.findMany({
      where: { id: { in: [memoryIdA, memoryIdB] } },
      select: {
        id: true,
        raw: true,
        memoryType: true,
        createdAt: true,
        importanceScore: true,
      },
    });

    // Determine suggested strategy and survivor
    const memoryType = memories[0]?.memoryType ?? null;
    const suggestedStrategy = this.mergeService.getDefaultStrategy(memoryType);
    const suggestedSurvivorId = this.selectSuggestedSurvivor(
      memories,
      suggestedStrategy,
    );

    // Check if candidate already exists
    const existing = await this.prisma.mergeCandidate.findFirst({
      where: {
        userId,
        memoryIds: { hasEvery: [memoryIdA, memoryIdB] },
        status: CandidateStatus.PENDING,
      },
    });

    if (existing) {
      return this.toDto(existing, memories);
    }

    // Create candidate
    const candidate = await this.prisma.mergeCandidate.create({
      data: {
        userId,
        memoryIds: [memoryIdA, memoryIdB],
        similarity,
        suggestedStrategy,
        suggestedSurvivorId,
        safetyFlags: JSON.stringify(safetyFlags),
        status: CandidateStatus.PENDING,
      },
    });

    return this.toDto(candidate, memories);
  }

  /**
   * Queue a cluster of memories for review
   */
  async queueClusterForReview(
    userId: string,
    cluster: MemoryCluster,
  ): Promise<MergeCandidateDto> {
    // Check safety for all memories
    const safetyResults = await this.safetyService.checkMultipleSafety(
      cluster.memoryIds,
    );
    const safetyFlags = safetyResults.flatMap((r) => r.reasons);

    // Fetch memory details
    const memories = await this.prisma.memory.findMany({
      where: { id: { in: cluster.memoryIds } },
      select: {
        id: true,
        raw: true,
        memoryType: true,
        createdAt: true,
        importanceScore: true,
      },
    });

    // Determine suggested strategy
    const memoryType = memories[0]?.memoryType ?? null;
    const suggestedStrategy = this.mergeService.getDefaultStrategy(memoryType);

    // Check if candidate already exists
    const existing = await this.prisma.mergeCandidate.findFirst({
      where: {
        userId,
        memoryIds: { hasEvery: cluster.memoryIds },
        status: CandidateStatus.PENDING,
      },
    });

    if (existing) {
      return this.toDto(existing, memories);
    }

    // Create candidate
    const candidate = await this.prisma.mergeCandidate.create({
      data: {
        userId,
        memoryIds: cluster.memoryIds,
        similarity: cluster.avgSimilarity,
        suggestedStrategy,
        suggestedSurvivorId: cluster.centroidMemoryId,
        safetyFlags: JSON.stringify(safetyFlags),
        status: CandidateStatus.PENDING,
      },
    });

    return this.toDto(candidate, memories);
  }

  /**
   * Get list of merge candidates
   */
  async getCandidates(
    userId: string,
    options: {
      status?: CandidateStatus;
      minSimilarity?: number;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<ListCandidatesResponseDto> {
    const { status, minSimilarity, limit = 50, offset = 0 } = options;
    const allUserIds = await this.resolveAllUserIds(userId);

    const where: any = {
      userId: { in: allUserIds },
      ...(status ? { status } : {}),
      ...(minSimilarity ? { similarity: { gte: minSimilarity } } : {}),
      // Exclude skipped candidates whose skip time hasn't passed
      OR: [
        { skipUntil: null },
        { skipUntil: { lte: new Date() } },
        { status: { not: CandidateStatus.SKIPPED } },
      ],
    };

    const [candidates, total, pendingCount] = await Promise.all([
      this.prisma.mergeCandidate.findMany({
        where,
        orderBy: [{ similarity: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.mergeCandidate.count({ where }),
      this.prisma.mergeCandidate.count({
        where: { userId: { in: allUserIds }, status: CandidateStatus.PENDING },
      }),
    ]);

    // Fetch memory details for all candidates
    const allMemoryIds = [...new Set(candidates.flatMap((c) => c.memoryIds))];
    const memories = await this.prisma.memory.findMany({
      where: { id: { in: allMemoryIds } },
      select: {
        id: true,
        raw: true,
        memoryType: true,
        createdAt: true,
        importanceScore: true,
      },
    });

    return {
      candidates: candidates.map((c) => this.toDto(c, memories)),
      total,
      pendingCount,
    };
  }

  /**
   * Get a single candidate by ID
   */
  async getCandidate(candidateId: string): Promise<MergeCandidateDto | null> {
    const candidate = await this.prisma.mergeCandidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate) return null;

    const memories = await this.prisma.memory.findMany({
      where: { id: { in: candidate.memoryIds } },
      select: {
        id: true,
        raw: true,
        memoryType: true,
        createdAt: true,
        importanceScore: true,
      },
    });

    return this.toDto(candidate, memories);
  }

  /**
   * Approve a merge candidate
   */
  async approve(
    candidateId: string,
    request: ApproveRequestDto,
    approvedBy?: string,
  ): Promise<ApproveResponseDto> {
    const candidate = await this.prisma.mergeCandidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate) {
      throw new Error(`Candidate not found: ${candidateId}`);
    }

    if (candidate.status !== CandidateStatus.PENDING) {
      throw new Error(`Candidate is not pending: ${candidate.status}`);
    }

    // Execute the merge
    const strategy =
      request.strategy ?? (candidate.suggestedStrategy as MergeStrategy);
    const survivorId = request.survivorId ?? candidate.suggestedSurvivorId;

    const mergeResult = await this.mergeService.merge(
      candidate.memoryIds,
      strategy as any,
      {
        survivorId,
        customContent: request.customContent,
      },
    );

    // Record merge event
    const mergeEvent = await this.lineageService.recordMerge(
      candidate.userId,
      mergeResult,
      'manual',
      candidate.similarity,
      approvedBy,
    );

    // Update candidate status
    await this.prisma.mergeCandidate.update({
      where: { id: candidateId },
      data: {
        status: CandidateStatus.APPROVED,
        reviewedAt: new Date(),
        reviewedBy: approvedBy ?? null,
      },
    });

    return {
      success: true,
      mergeEventId: mergeEvent.id,
      survivorId: mergeResult.survivorId,
      absorbedIds: mergeResult.absorbedIds,
    };
  }

  /**
   * Reject a merge candidate
   */
  async reject(
    candidateId: string,
    request: RejectRequestDto,
    rejectedBy?: string,
  ): Promise<RejectResponseDto> {
    const candidate = await this.prisma.mergeCandidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate) {
      throw new Error(`Candidate not found: ${candidateId}`);
    }

    if (candidate.status !== CandidateStatus.PENDING) {
      throw new Error(`Candidate is not pending: ${candidate.status}`);
    }

    // Update candidate status
    await this.prisma.mergeCandidate.update({
      where: { id: candidateId },
      data: {
        status: CandidateStatus.REJECTED,
        reviewedAt: new Date(),
        reviewedBy: rejectedBy ?? null,
        reviewNotes: request.reason,
      },
    });

    // If neverMerge, add to never-merge list on both memories
    let addedToNeverMerge = false;
    if (request.neverMerge && candidate.memoryIds.length === 2) {
      const [idA, idB] = candidate.memoryIds;

      // Add each to the other's never-merge list
      // Note: This would require a schema field; for now we'll track via rejected candidates
      addedToNeverMerge = true;
    }

    return {
      success: true,
      addedToNeverMerge,
    };
  }

  /**
   * Skip a candidate (will resurface later)
   */
  async skip(
    candidateId: string,
    skipDays: number = 7,
  ): Promise<{ success: boolean; nextReviewAt: Date }> {
    const candidate = await this.prisma.mergeCandidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate) {
      throw new Error(`Candidate not found: ${candidateId}`);
    }

    const nextReviewAt = new Date(Date.now() + skipDays * 24 * 60 * 60 * 1000);

    await this.prisma.mergeCandidate.update({
      where: { id: candidateId },
      data: {
        status: CandidateStatus.SKIPPED,
        skipUntil: nextReviewAt,
      },
    });

    return { success: true, nextReviewAt };
  }

  /**
   * HEY-347: Auto-resolve PENDING candidates older than TTL (default 14 days).
   * Candidates past their TTL are auto-approved using their suggested strategy.
   * Returns count of resolved candidates.
   */
  async expireStale(
    userId: string,
    ttlDays: number = 14,
  ): Promise<{ resolved: number; errors: number }> {
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
    const allUserIds = await this.resolveAllUserIds(userId);

    const staleCandidates = await this.prisma.mergeCandidate.findMany({
      where: {
        userId: { in: allUserIds },
        status: CandidateStatus.PENDING,
        createdAt: { lt: cutoff },
      },
      orderBy: { similarity: 'desc' },
      take: 500, // process in batches to avoid OOM
    });

    let resolved = 0;
    let errors = 0;

    for (const candidate of staleCandidates) {
      try {
        await this.approve(
          candidate.id,
          { strategy: candidate.suggestedStrategy as MergeStrategy },
          'ttl-auto-resolve',
        );
        resolved++;
      } catch {
        // If approve fails (e.g. memory deleted), just mark as resolved
        try {
          await this.prisma.mergeCandidate.update({
            where: { id: candidate.id },
            data: {
              status: CandidateStatus.APPROVED,
              reviewedAt: new Date(),
              reviewedBy: 'ttl-auto-resolve',
              reviewNotes: 'Auto-resolved: TTL expired, merge failed',
            },
          });
          resolved++;
        } catch {
          errors++;
        }
      }
    }

    return { resolved, errors };
  }

  /**
   * HEY-347: Bulk resolve PENDING candidates by IDs or by filter.
   * Action can be 'approve' or 'reject'.
   */
  async bulkResolve(
    candidateIds: string[],
    action: 'approve' | 'reject',
    resolvedBy: string = 'bulk-resolve',
  ): Promise<{ resolved: number; errors: number }> {
    let resolved = 0;
    let errors = 0;

    for (const id of candidateIds) {
      try {
        if (action === 'approve') {
          await this.approve(id, {}, resolvedBy);
        } else {
          await this.reject(id, { reason: 'Bulk rejected' }, resolvedBy);
        }
        resolved++;
      } catch {
        errors++;
      }
    }

    return { resolved, errors };
  }

  /**
   * ENG-17: Auto-approve high-confidence pending candidates.
   * Finds PENDING MergeCandidates older than minAgeHours with similarity >= minSimilarity,
   * runs safety checks, and auto-approves safe ones.
   */
  async processBacklog(
    minSimilarity: number = 0.93,
    minAgeHours: number = 24,
  ): Promise<{ approved: number; skippedSafety: number; errors: number }> {
    const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000);

    const candidates = await this.prisma.mergeCandidate.findMany({
      where: {
        status: CandidateStatus.PENDING,
        similarity: { gte: minSimilarity },
        createdAt: { lt: cutoff },
      },
      orderBy: { similarity: 'desc' },
      take: 200,
    });

    let approved = 0;
    let skippedSafety = 0;
    let errors = 0;

    for (const candidate of candidates) {
      try {
        // Safety check — never auto-merge protected memories
        const safetyResults = await this.safetyService.checkMultipleSafety(
          candidate.memoryIds,
        );
        const hasProtected = safetyResults.some((r) => r.isProtected);
        const canAutoMerge = safetyResults.every((r) => r.canAutoMerge);

        if (hasProtected || !canAutoMerge) {
          skippedSafety++;
          continue;
        }

        await this.approve(
          candidate.id,
          { strategy: candidate.suggestedStrategy as MergeStrategy },
          'backlog-auto-approve',
        );
        approved++;
      } catch {
        // If merge fails (e.g. memory already deleted), mark as resolved
        try {
          await this.prisma.mergeCandidate.update({
            where: { id: candidate.id },
            data: {
              status: CandidateStatus.APPROVED,
              reviewedAt: new Date(),
              reviewedBy: 'backlog-auto-approve',
              reviewNotes: 'Auto-approved: merge execution failed',
            },
          });
          approved++;
        } catch {
          errors++;
        }
      }
    }

    return { approved, skippedSafety, errors };
  }

  /**
   * Check if a pair has been previously rejected
   */
  async wasRejected(memoryIdA: string, memoryIdB: string): Promise<boolean> {
    const rejected = await this.prisma.mergeCandidate.findFirst({
      where: {
        memoryIds: { hasEvery: [memoryIdA, memoryIdB] },
        status: CandidateStatus.REJECTED,
      },
    });

    return !!rejected;
  }

  /**
   * Select suggested survivor based on strategy
   */
  private selectSuggestedSurvivor(
    memories: Array<{
      id: string;
      raw: string;
      createdAt: Date;
      importanceScore: number;
    }>,
    strategy: MergeStrategy,
  ): string {
    switch (strategy) {
      case MergeStrategy.KEEP_NEWEST:
        return memories.sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        )[0].id;
      case MergeStrategy.KEEP_OLDEST:
        return memories.sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        )[0].id;
      case MergeStrategy.KEEP_IMPORTANCE:
        return memories.sort((a, b) => b.importanceScore - a.importanceScore)[0]
          .id;
      case MergeStrategy.KEEP_DETAILED:
      case MergeStrategy.COMBINE_METADATA:
      default:
        return memories.sort(
          (a, b) =>
            this.mergeService.computeDetailScore(b.raw) -
            this.mergeService.computeDetailScore(a.raw),
        )[0].id;
    }
  }

  /**
   * Convert database model to DTO
   */
  private toDto(
    candidate: any,
    memories: Array<{
      id: string;
      raw: string;
      memoryType: any;
      createdAt: Date;
      importanceScore: number;
    }>,
  ): MergeCandidateDto {
    const memoryMap = new Map(memories.map((m) => [m.id, m]));

    const memorySummaries: MemorySummaryDto[] = candidate.memoryIds
      .map((id: string) => memoryMap.get(id))
      .filter((m: any) => m)
      .map((m: any) => ({
        id: m.id,
        content: m.raw,
        memoryType: m.memoryType ?? undefined,
        createdAt: m.createdAt,
        importanceScore: m.importanceScore,
      }));

    const safetyFlags: SafetyReasonDto[] =
      typeof candidate.safetyFlags === 'string'
        ? JSON.parse(candidate.safetyFlags)
        : (candidate.safetyFlags ?? []);

    return {
      id: candidate.id,
      memories: memorySummaries,
      similarity: candidate.similarity,
      suggestedStrategy: candidate.suggestedStrategy as MergeStrategy,
      suggestedSurvivorId: candidate.suggestedSurvivorId,
      safetyFlags,
      status: candidate.status as CandidateStatus,
      createdAt: candidate.createdAt,
    };
  }
}
