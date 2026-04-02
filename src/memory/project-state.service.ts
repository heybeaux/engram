import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { MemoryLayer } from '@prisma/client';
import { ProjectStateDto, ProjectStateResponse } from './dto/project-state.dto';

const GOAL_PATTERNS =
  /\b(goal|objective|target|aim|milestone|deliverable|accomplish)\b/i;
const DECISION_PATTERNS =
  /\b(decid\w*|decision|chose|chosen|agreed|resolved|went with|picked|settled on)\b/i;
const ISSUE_PATTERNS =
  /\b(bug|issue|problem|blocker|broken|fail|error|regression|crash|stuck)\b/i;
const OUTCOME_PATTERNS =
  /\b(result|outcome|success|completed|shipped|launched|deployed|achieved|finished|done)\b/i;

@Injectable()
export class ProjectStateService {
  private readonly logger = new Logger(ProjectStateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
  ) {}

  async synthesize(
    userId: string | string[],
    dto: ProjectStateDto,
  ): Promise<ProjectStateResponse> {
    const { projectName, includeRelated = true, lookbackDays = 30 } = dto;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);

    const userIdFilter = Array.isArray(userId) ? { in: userId } : userId;

    // Step 1: Find PROJECT layer memories matching project name (ILIKE)
    const projectMemories = await this.prisma.memory.findMany({
      where: {
        userId: userIdFilter,
        layer: MemoryLayer.PROJECT,
        deletedAt: null,
        supersededById: null,
        searchable: { not: false },
        createdAt: { gte: cutoffDate },
        OR: [
          { raw: { contains: projectName, mode: 'insensitive' } },
          { projectId: projectName },
        ],
      },
      include: { extraction: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    // Step 2: If includeRelated, find semantically related memories from other layers
    let relatedMemories: typeof projectMemories = [];
    if (includeRelated) {
      try {
        const queryEmbedding = await this.embedding.generateForRecall(
          `project ${projectName}`,
        );
        const vectorResults = await this.embedding.search(
          userId,
          queryEmbedding,
          100,
          [MemoryLayer.TASK, MemoryLayer.SESSION, MemoryLayer.INSIGHT],
        );

        const relatedIds = vectorResults
          .filter((r) => r.score >= 0.3)
          .map((r) => r.id);

        if (relatedIds.length > 0) {
          relatedMemories = await this.prisma.memory.findMany({
            where: {
              id: { in: relatedIds },
              userId: userIdFilter,
              deletedAt: null,
              supersededById: null,
              searchable: { not: false },
              createdAt: { gte: cutoffDate },
            },
            include: { extraction: true },
            orderBy: { createdAt: 'desc' },
          });
        }
      } catch (err) {
        this.logger.warn(
          `[ProjectState] Embedding search failed, proceeding with project memories only: ${(err as Error).message}`,
        );
      }
    }

    // Combine and deduplicate
    const allMemoriesMap = new Map<string, (typeof projectMemories)[0]>();
    for (const m of [...projectMemories, ...relatedMemories]) {
      if (!allMemoriesMap.has(m.id)) {
        allMemoriesMap.set(m.id, m);
      }
    }
    const allMemories = Array.from(allMemoriesMap.values());

    // Step 3: Categorize
    const goals: Array<{ id: string; raw: string; status?: string }> = [];
    const decisions: Array<{ id: string; raw: string; date: string }> = [];
    const issues: Array<{ id: string; raw: string; severity?: string }> = [];
    const outcomes: Array<{ id: string; raw: string; date: string }> = [];
    const insights: Array<{ id: string; raw: string }> = [];

    for (const memory of allMemories) {
      const raw = memory.raw;
      const date = memory.createdAt.toISOString();

      if (memory.layer === MemoryLayer.INSIGHT) {
        insights.push({ id: memory.id, raw });
        continue;
      }

      if (GOAL_PATTERNS.test(raw)) {
        goals.push({ id: memory.id, raw });
      }
      if (DECISION_PATTERNS.test(raw)) {
        decisions.push({ id: memory.id, raw, date });
      }
      if (ISSUE_PATTERNS.test(raw)) {
        const severity = this.classifySeverity(raw);
        issues.push({ id: memory.id, raw, severity });
      }
      if (OUTCOME_PATTERNS.test(raw)) {
        outcomes.push({ id: memory.id, raw, date });
      }
    }

    // Step 4: Recent activity (last 7 days)
    const recentCutoff = new Date();
    recentCutoff.setDate(recentCutoff.getDate() - 7);
    const recentActivity = allMemories
      .filter((m) => m.createdAt >= recentCutoff)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 20)
      .map((m) => ({
        id: m.id,
        raw: m.raw,
        date: m.createdAt.toISOString(),
        layer: m.layer,
      }));

    // Step 5: Compute confidence
    const lastActivity =
      allMemories.length > 0
        ? allMemories
            .reduce((latest, m) =>
              m.createdAt > latest.createdAt ? m : latest,
            )
            .createdAt.toISOString()
        : null;

    const confidence = this.calculateConfidence(
      allMemories.length,
      lastActivity,
      { goals, decisions, issues, outcomes, insights },
    );

    return {
      projectName,
      lastActivity,
      totalMemories: allMemories.length,
      confidence,
      summary: { goals, decisions, issues, outcomes, insights },
      recentActivity,
    };
  }

  private classifySeverity(raw: string): string {
    const lower = raw.toLowerCase();
    if (/\b(critical|crash|data.?loss|security|blocker)\b/.test(lower))
      return 'critical';
    if (/\b(broken|fail|regression|major)\b/.test(lower)) return 'high';
    if (/\b(bug|error|issue|problem)\b/.test(lower)) return 'medium';
    return 'low';
  }

  calculateConfidence(
    memoryCount: number,
    lastActivity: string | null,
    categories: {
      goals: any[];
      decisions: any[];
      issues: any[];
      outcomes: any[];
      insights: any[];
    },
  ): number {
    if (memoryCount === 0) return 0;

    // Memory count factor (0-0.4): more memories = higher confidence, caps at 50
    const countScore = Math.min(memoryCount / 50, 1) * 0.4;

    // Recency factor (0-0.3): more recent = higher confidence
    let recencyScore = 0;
    if (lastActivity) {
      const daysSince =
        (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24);
      recencyScore = Math.max(0, 1 - daysSince / 30) * 0.3;
    }

    // Category diversity factor (0-0.3): more diverse categories = higher confidence
    const filledCategories = [
      categories.goals,
      categories.decisions,
      categories.issues,
      categories.outcomes,
      categories.insights,
    ].filter((c) => c.length > 0).length;
    const diversityScore = (filledCategories / 5) * 0.3;

    return Math.round((countScore + recencyScore + diversityScore) * 100) / 100;
  }
}
