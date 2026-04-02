import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { ContextRegeneratedEvent } from '../events/event-types';
import * as fs from 'fs';
import * as path from 'path';

export interface GenerateContextOptions {
  /**
   * Account ID resolved from the API key. When provided, all users under
   * the account are included — no userId required. This is the primary
   * scope: API key alone is sufficient to access all account memories.
   */
  accountId?: string;
  /**
   * Optional narrowing filter. When provided alongside accountId, restricts
   * to memories for this specific user only. Omit to get all account memories.
   */
  userId?: string;
  /**
   * @deprecated Use accountId instead. Kept for backward compat with
   * dream-cycle callers that still pass agentId.
   */
  agentId?: string;
  maxTokens?: number;
  writePath?: string;
  dryRun?: boolean;
  includeStale?: boolean;
  tokenBudget?: number;
}

export interface GenerateContextResult {
  markdown: string;
  tokenCount: number;
  memoriesIncluded: number;
  memoriesTotal: number;
  memoriesFiltered: number;
  memoriesStale: number;
  memoriesDeduped: number;
  categories: {
    userIdentity: number;
    currentProject: number;
    activeProjects: number;
    keyLessons: number;
    recentContext: number;
  };
  budgetAllocation: {
    critical: number;
    relevant: number;
    background: number;
  };
  writtenTo: string | null;
  latencyMs: number;
}

type CategoryKey =
  | 'userIdentity'
  | 'currentProject'
  | 'activeProjects'
  | 'keyLessons'
  | 'recentContext';

type PriorityTier = 'critical' | 'relevant' | 'background';

interface CategorizedMemory {
  id: string;
  raw: string;
  effectiveScore: number;
  confidence: number;
  createdAt: Date;
  layer: string | null;
  memoryType: string | null;
  category: CategoryKey;
  tier: PriorityTier;
  clusterId: string | null;
}

const STALENESS_DAYS = 14;

@Injectable()
export class GenerateContextService {
  private readonly logger = new Logger(GenerateContextService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() private eventEmitter?: EventEmitter2,
  ) {}

  async generate(
    options: GenerateContextOptions,
  ): Promise<GenerateContextResult> {
    const startTime = Date.now();
    const maxTokens = options.tokenBudget ?? options.maxTokens ?? 4000;
    const dryRun = options.dryRun ?? false;
    const includeStale = options.includeStale ?? false;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stalenessThreshold = new Date(
      Date.now() - STALENESS_DAYS * 24 * 60 * 60 * 1000,
    );

    // Resolve effective user ID scope:
    // - accountId (from API key) → fetch all user IDs for this account
    // - userId (optional narrowing) → restrict to one user
    // - agentId (legacy fallback) → filter by agent
    // API key alone is sufficient — userId is never required.
    let effectiveUserIds: string[] | string | null = null;

    if (options.accountId) {
      if (options.userId) {
        // Narrowed to specific user
        effectiveUserIds = options.userId;
      } else {
        // All users under this account
        const accountUsers = await this.prisma.user.findMany({
          where: { accountId: options.accountId, deletedAt: null },
          select: { id: true },
        });
        effectiveUserIds =
          accountUsers.length > 0 ? accountUsers.map((u) => u.id) : null;
      }
    } else if (options.userId) {
      // Legacy: userId without accountId (e.g. dream-cycle internal calls)
      effectiveUserIds = options.userId;
    }

    const memoryWhere: Record<string, unknown> = {
      deletedAt: null,
      archivedReason: null,
    };
    if (effectiveUserIds) {
      memoryWhere['userId'] = Array.isArray(effectiveUserIds)
        ? { in: effectiveUserIds }
        : effectiveUserIds;
    } else if (options.agentId) {
      // Legacy agentId fallback
      memoryWhere['agentId'] = options.agentId;
    }

    // Query all active memories
    const memories = await this.prisma.memory.findMany({
      where: memoryWhere as any,
      orderBy: [{ effectiveScore: 'desc' }, { confidence: 'desc' }],
      select: {
        id: true,
        raw: true,
        effectiveScore: true,
        confidence: true,
        layer: true,
        memoryType: true,
        subjectType: true,
        usedCount: true,
        createdAt: true,
        safetyCritical: true,
        archivedReason: true,
        supersededById: true,
        consolidatedInto: true,
      },
    });

    // Fetch cluster assignments via raw SQL
    const memoryClusterMap = new Map<string, string>();
    const clusterLabelMap = new Map<string, string>();
    try {
      // Use same scope as the main query
      let clusterAssignments: Array<{ id: string; cluster_id: string }> = [];
      if (effectiveUserIds) {
        if (Array.isArray(effectiveUserIds)) {
          clusterAssignments = await this.prisma.$queryRawUnsafe<
            Array<{ id: string; cluster_id: string }>
          >(
            `SELECT id, cluster_id FROM memories WHERE user_id = ANY($1::text[]) AND deleted_at IS NULL AND cluster_id IS NOT NULL`,
            effectiveUserIds,
          );
        } else {
          clusterAssignments = await this.prisma.$queryRawUnsafe<
            Array<{ id: string; cluster_id: string }>
          >(
            `SELECT id, cluster_id FROM memories WHERE user_id = $1 AND deleted_at IS NULL AND cluster_id IS NOT NULL`,
            effectiveUserIds,
          );
        }
      } else if (options.agentId) {
        clusterAssignments = await this.prisma.$queryRawUnsafe<
          Array<{ id: string; cluster_id: string }>
        >(
          `SELECT id, cluster_id FROM memories WHERE agent_id = $1 AND deleted_at IS NULL AND cluster_id IS NOT NULL`,
          options.agentId,
        );
      }
      for (const row of clusterAssignments) {
        memoryClusterMap.set(row.id, row.cluster_id);
      }

      const clusterIds = [
        ...new Set(clusterAssignments.map((r) => r.cluster_id)),
      ];
      if (clusterIds.length > 0) {
        const clusters = await this.prisma.$queryRawUnsafe<
          Array<{ id: string; label: string }>
        >(
          `SELECT id, label FROM memory_clusters WHERE id = ANY($1::text[])`,
          clusterIds,
        );
        for (const c of clusters) {
          clusterLabelMap.set(c.id, c.label);
        }
      }
    } catch {
      // Cluster table may not exist yet — gracefully degrade
    }

    const totalMemories = memories.length;

    // === Pre-filter stale/superseded memories ===
    const filtered = memories.filter((m) => {
      if (m.effectiveScore < 0.3) return false;
      if (m.supersededById != null) return false;
      if (m.consolidatedInto != null) return false;
      if (m.archivedReason != null) return false;
      return true;
    });
    const memoriesFiltered = totalMemories - filtered.length;

    // === 4.1 Staleness Detection ===
    // Find memories older than STALENESS_DAYS with no access in memory_access_logs
    const staleMemoryIds = new Set<string>();
    let memoriesStale = 0;
    if (!includeStale) {
      const oldMemoryIds = filtered
        .filter((m) => m.createdAt < stalenessThreshold)
        .map((m) => m.id);

      if (oldMemoryIds.length > 0) {
        try {
          // Find which of these old memories have been accessed in the last STALENESS_DAYS
          const accessedRows = await this.prisma.$queryRawUnsafe<
            Array<{ memory_id: string }>
          >(
            `SELECT DISTINCT memory_id FROM memory_access_logs
             WHERE memory_id = ANY($1::text[])
             AND created_at >= $2`,
            oldMemoryIds,
            stalenessThreshold,
          );
          const accessedIds = new Set(accessedRows.map((r) => r.memory_id));

          // Stale = old AND not accessed recently
          for (const id of oldMemoryIds) {
            if (!accessedIds.has(id)) {
              staleMemoryIds.add(id);
            }
          }
          memoriesStale = staleMemoryIds.size;
          this.logger.log(
            `Staleness: ${memoriesStale} memories marked stale (>${STALENESS_DAYS} days, no access)`,
          );
        } catch {
          // memory_access_logs may not exist — skip staleness detection
          this.logger.warn(
            'Could not query memory_access_logs for staleness detection',
          );
        }
      }
    }

    // Apply staleness filter
    const nonStale = includeStale
      ? filtered
      : filtered.filter((m) => !staleMemoryIds.has(m.id));

    this.logger.log(
      `Pre-filter: excluded ${memoriesFiltered} low-score/superseded, ${memoriesStale} stale`,
    );

    // === Detect current project from last 24h high-score PROJECT memories ===
    const recentProjectMemories = nonStale.filter(
      (m) =>
        m.layer === 'PROJECT' &&
        m.createdAt >= oneDayAgo &&
        m.effectiveScore >= 0.5,
    );
    const projectCounts = new Map<string, number>();
    for (const m of recentProjectMemories) {
      const text = m.raw.toLowerCase();
      const projectPatterns = text.match(
        /(?:working on|building|project[:\s]+|developing)\s+([a-z][\w\s-]+)/i,
      );
      const projectName = projectPatterns
        ? projectPatterns[1].trim()
        : text.slice(0, 50);
      projectCounts.set(projectName, (projectCounts.get(projectName) || 0) + 1);
    }
    let currentProjectName: string | null = null;
    if (projectCounts.size > 0) {
      currentProjectName = Array.from(projectCounts.entries()).sort(
        (a, b) => b[1] - a[1],
      )[0][0];
    }

    // === 4.2 Section Prioritization with Token Budgets ===
    // Critical (40%): User identity, active project facts, key lessons
    // Relevant (40%): Recent context, current project-specific
    // Background (20%): Cross-project, older memories
    const criticalBudget = Math.floor(maxTokens * 0.4);
    const relevantBudget = Math.floor(maxTokens * 0.4);
    const backgroundBudget = Math.floor(maxTokens * 0.2);

    // Categorize memories with tier assignment
    const recentMemories: typeof nonStale = [];
    const remainingMemories: typeof nonStale = [];

    for (const m of nonStale) {
      if (m.createdAt >= sevenDaysAgo) {
        recentMemories.push(m);
      } else {
        remainingMemories.push(m);
      }
    }

    const categorized: CategorizedMemory[] = [];

    for (const m of recentMemories) {
      categorized.push({
        id: m.id,
        raw: m.raw,
        effectiveScore: m.effectiveScore,
        confidence: m.confidence,
        createdAt: m.createdAt,
        layer: m.layer,
        memoryType: m.memoryType,
        category: 'recentContext',
        tier: 'relevant',
        clusterId: memoryClusterMap.get(m.id) ?? null,
      });
    }

    for (const m of remainingMemories) {
      let category: CategoryKey;
      let tier: PriorityTier;

      if (
        m.memoryType === 'LESSON' ||
        m.memoryType === 'CONSTRAINT' ||
        m.safetyCritical
      ) {
        category = 'keyLessons';
        tier = 'critical'; // Key lessons are critical
      } else if (m.layer === 'PROJECT' || m.memoryType === 'TASK') {
        category = 'activeProjects';
        tier = 'background'; // cross-project older memories are background
      } else if (
        m.subjectType === 'USER' ||
        m.memoryType === 'PREFERENCE' ||
        m.memoryType === 'FACT' ||
        m.layer === 'IDENTITY'
      ) {
        category = 'userIdentity';
        tier = 'critical'; // user identity is critical
      } else {
        category = 'userIdentity';
        tier = 'critical';
      }

      categorized.push({
        id: m.id,
        raw: m.raw,
        effectiveScore: m.effectiveScore,
        confidence: m.confidence,
        createdAt: m.createdAt,
        layer: m.layer,
        memoryType: m.memoryType,
        category,
        tier,
        clusterId: memoryClusterMap.get(m.id) ?? null,
      });
    }

    // === 4.3 Dedup via Embedding Similarity ===
    // Get embeddings for all candidate memories and remove near-duplicates (cosine > 0.92)
    let memoriesDeduped = 0;
    const memoryIds = categorized.map((m) => m.id);
    const dedupExcludeIds = new Set<string>();

    if (memoryIds.length > 1) {
      try {
        // Find pairs with cosine similarity > 0.92
        const similarPairs = await this.prisma.$queryRawUnsafe<
          Array<{
            id1: string;
            id2: string;
            similarity: number;
            score1: number;
            score2: number;
          }>
        >(
          `SELECT
            m1.id as id1, m2.id as id2,
            1 - (m1.embedding <=> m2.embedding) as similarity,
            m1.effective_score as score1,
            m2.effective_score as score2
           FROM memories m1
           JOIN memories m2 ON m1.id < m2.id
           WHERE m1.id = ANY($1::text[])
             AND m2.id = ANY($1::text[])
             AND m1.embedding IS NOT NULL
             AND m2.embedding IS NOT NULL
             AND 1 - (m1.embedding <=> m2.embedding) > 0.92`,
          memoryIds,
        );

        // For each similar pair, exclude the one with lower effectiveScore
        for (const pair of similarPairs) {
          if (dedupExcludeIds.has(pair.id1) || dedupExcludeIds.has(pair.id2))
            continue;
          const loserId =
            Number(pair.score1) >= Number(pair.score2) ? pair.id2 : pair.id1;
          dedupExcludeIds.add(loserId);
        }
        memoriesDeduped = dedupExcludeIds.size;
        this.logger.log(
          `Embedding dedup: removed ${memoriesDeduped} near-duplicate memories (cosine > 0.92)`,
        );
      } catch (e) {
        // Embedding column may not be populated — fall back to text dedup
        this.logger.warn(
          `Embedding dedup failed, falling back to text dedup: ${e}`,
        );
      }
    }

    // Remove deduped memories
    const dedupedCategorized = categorized.filter(
      (m) => !dedupExcludeIds.has(m.id),
    );

    // Group by category
    const groups: Record<CategoryKey, CategorizedMemory[]> = {
      userIdentity: [],
      currentProject: [],
      activeProjects: [],
      keyLessons: [],
      recentContext: [],
    };

    for (const m of dedupedCategorized) {
      if (
        m.category === 'activeProjects' &&
        currentProjectName &&
        m.raw.toLowerCase().includes(currentProjectName)
      ) {
        groups.currentProject.push({ ...m, tier: 'critical' });
      } else {
        groups[m.category].push(m);
      }
    }

    // Also pull current project memories from recentContext
    if (currentProjectName) {
      const moved: CategorizedMemory[] = [];
      groups.recentContext = groups.recentContext.filter((m) => {
        if (
          (m.layer === 'PROJECT' || m.memoryType === 'TASK') &&
          m.raw.toLowerCase().includes(currentProjectName)
        ) {
          moved.push({ ...m, tier: 'relevant' });
          return false;
        }
        return true;
      });
      groups.currentProject.push(...moved);
    }

    // === Select memories per tier within budget ===
    // Tier mapping: critical = userIdentity + keyLessons + currentProject
    //               relevant = recentContext + currentProject overflow
    //               background = activeProjects
    const tierBudgets: Record<PriorityTier, number> = {
      critical: criticalBudget,
      relevant: relevantBudget,
      background: backgroundBudget,
    };

    const selected: Record<CategoryKey, string[]> = {
      userIdentity: [],
      currentProject: [],
      activeProjects: [],
      keyLessons: [],
      recentContext: [],
    };
    const allSelectedTexts: string[] = [];
    const counts: Record<CategoryKey, number> = {
      userIdentity: 0,
      currentProject: 0,
      activeProjects: 0,
      keyLessons: 0,
      recentContext: 0,
    };

    // Process in priority order: critical categories first, then relevant, then background
    const processingOrder: { cat: CategoryKey; tier: PriorityTier }[] = [
      { cat: 'keyLessons', tier: 'critical' },
      { cat: 'userIdentity', tier: 'critical' },
      { cat: 'currentProject', tier: 'critical' },
      { cat: 'recentContext', tier: 'relevant' },
      { cat: 'activeProjects', tier: 'background' },
    ];

    for (const { cat, tier } of processingOrder) {
      for (const m of groups[cat]) {
        if (tierBudgets[tier] <= 0) break;
        const tokens = this.estimateTokens(m.raw);
        if (tokens > tierBudgets[tier]) continue;

        // Text-based dedup check (fallback for memories without embeddings)
        if (this.isDuplicate(m.raw, allSelectedTexts)) continue;

        selected[cat].push(m.raw);
        allSelectedTexts.push(m.raw);
        tierBudgets[tier] -= tokens;
        counts[cat]++;
      }
    }

    // Build markdown
    const totalIncluded = Object.values(counts).reduce((a, b) => a + b, 0);
    const allText = Object.values(selected).flat().join('\n');
    const totalTokens = this.estimateTokens(allText);

    const sections: string[] = [];
    sections.push(`# Memory Context (via Engram)`);
    sections.push('');
    sections.push(
      `*${totalIncluded} memories loaded, ${Math.round(totalTokens)} tokens*`,
    );
    sections.push('');
    sections.push(
      '> **Note:** Focus on memories relevant to the current project.',
    );
    sections.push(
      '> Cross-project memories are included for reference but should not',
    );
    sections.push('> influence actions on the current project.');

    const sectionDefs: { key: CategoryKey; title: string }[] = [
      { key: 'userIdentity', title: 'User Identity' },
    ];

    if (currentProjectName && selected.currentProject.length > 0) {
      sectionDefs.push({
        key: 'currentProject',
        title: `Current Project`,
      });
    }

    sectionDefs.push(
      { key: 'activeProjects', title: 'Active Projects' },
      { key: 'keyLessons', title: 'Key Lessons' },
      { key: 'recentContext', title: 'Recent Context' },
    );

    const textToCluster = new Map<string, string | null>();
    for (const m of dedupedCategorized) {
      textToCluster.set(m.raw, m.clusterId);
    }

    for (const { key, title } of sectionDefs) {
      if (selected[key].length > 0) {
        sections.push('');
        sections.push(`## ${title}`);

        const clustered = new Map<string, string[]>();
        const unclustered: string[] = [];

        for (const text of selected[key]) {
          const clusterId = textToCluster.get(text);
          const label = clusterId ? clusterLabelMap.get(clusterId) : null;
          if (label) {
            if (!clustered.has(label)) clustered.set(label, []);
            clustered.get(label)!.push(text);
          } else {
            unclustered.push(text);
          }
        }

        for (const [label, texts] of clustered) {
          sections.push(`### ${label}`);
          for (const text of texts) {
            sections.push(`- ${text}`);
          }
        }

        for (const text of unclustered) {
          sections.push(`- ${text}`);
        }
      }
    }

    const markdown = sections.join('\n') + '\n';

    // File writing
    let writtenTo: string | null = null;
    if (options.writePath && !dryRun) {
      try {
        const dir = path.dirname(options.writePath);
        fs.mkdirSync(dir, { recursive: true });

        if (fs.existsSync(options.writePath)) {
          fs.copyFileSync(options.writePath, options.writePath + '.bak');
        }

        fs.writeFileSync(options.writePath, markdown, 'utf-8');
        writtenTo = options.writePath;
        this.logger.log(`Wrote context to ${options.writePath}`);
      } catch (err) {
        this.logger.error(`Failed to write context file: ${err}`);
      }
    }

    // Emit context.regenerated event
    try {
      this.eventEmitter?.emit(
        'context.regenerated',
        new ContextRegeneratedEvent(writtenTo, Math.round(totalTokens)),
      );
    } catch {
      // fire-and-forget
    }

    return {
      markdown,
      tokenCount: Math.round(totalTokens),
      memoriesIncluded: totalIncluded,
      memoriesTotal: totalMemories,
      memoriesFiltered,
      memoriesStale,
      memoriesDeduped,
      categories: counts,
      budgetAllocation: {
        critical: criticalBudget,
        relevant: relevantBudget,
        background: backgroundBudget,
      },
      writtenTo,
      latencyMs: Date.now() - startTime,
    };
  }

  estimateTokens(text: string): number {
    return text.split(/\s+/).filter(Boolean).length * 1.3;
  }

  // Text-based dedup with Jaccard similarity + substring containment
  isDuplicate(text: string, existing: string[]): boolean {
    const normalizedText = text.toLowerCase();
    const words = new Set(normalizedText.split(/\s+/).filter(Boolean));
    if (words.size === 0) return true;

    for (const other of existing) {
      const normalizedOther = other.toLowerCase();
      const otherWords = new Set(normalizedOther.split(/\s+/).filter(Boolean));

      const intersection = Array.from(words).filter((w) => otherWords.has(w));
      const unionSet = new Set(
        Array.from(words).concat(Array.from(otherWords)),
      );
      const similarity = intersection.length / unionSet.size;
      if (similarity > 0.7) return true;

      const smallerWords = words.size <= otherWords.size ? words : otherWords;
      const largerWords = words.size <= otherWords.size ? otherWords : words;
      const contained = Array.from(smallerWords).filter((w) =>
        largerWords.has(w),
      );
      if (smallerWords.size > 0 && contained.length / smallerWords.size >= 0.8)
        return true;
    }
    return false;
  }
}
