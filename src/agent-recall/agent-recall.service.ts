import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Response shape for a single entity recall.
 */
export interface RecallResult {
  profile: {
    id: string;
    name: string;
    type: string;
    description: string | null;
    attributes: Array<{
      key: string;
      value: string;
      verified: boolean;
      confidence: number;
      source: string | null;
    }>;
  };
  memories: Array<{
    id: string;
    content: string;
    importance: number;
    relevanceScore: number | null;
    createdAt: Date;
    source: string;
  }>;
  relationships: Array<{
    entity: string;
    type: string;
    strength: number;
  }>;
  unverifiedAttributes: Array<{
    key: string;
    value: string;
    confidence: number;
    source: string | null;
  }>;
}

@Injectable()
export class AgentRecallService {
  private readonly logger = new Logger(AgentRecallService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Recall a single entity by name.
   * Returns null if no match found.
   */
  async recallEntity(
    accountId: string,
    entityName: string,
    limit = 10,
  ): Promise<RecallResult | null> {
    const userIds = await this.resolveAccountUserIds(accountId);
    if (!userIds.length) return null;

    // Step 1: Match the entity profile
    const profile = await this.matchProfile(userIds, entityName);
    if (!profile) return null;

    // Step 2: Get memories
    const memories = await this.getMemories(profile.id, limit);

    // Step 3: Get relationships
    const relationships = await this.getRelationships(profile, userIds);

    // Step 4: Split verified / unverified attributes
    const verified = profile.attributes.filter((a) => a.verified);
    const unverified = profile.attributes.filter((a) => !a.verified);

    return {
      profile: {
        id: profile.id,
        name: profile.name,
        type: profile.type,
        description: profile.description,
        attributes: verified.map((a) => ({
          key: a.key,
          value: a.value,
          verified: a.verified,
          confidence: a.confidence,
          source: a.source,
        })),
      },
      memories,
      relationships,
      unverifiedAttributes: unverified.map((a) => ({
        key: a.key,
        value: a.value,
        confidence: a.confidence,
        source: a.source,
      })),
    };
  }

  /**
   * Batch recall for multiple entities.
   * Returns array with null for unmatched entities.
   */
  async recallBatch(
    accountId: string,
    entityNames: string[],
    limit = 10,
  ): Promise<(RecallResult | null)[]> {
    return Promise.all(
      entityNames.map((name) => this.recallEntity(accountId, name, limit)),
    );
  }

  // ── Matching Logic ───────────────────────────────────────────────────

  /**
   * Multi-strategy entity matching (exact → alias → fuzzy → semantic).
   */
  private async matchProfile(userIds: string[], entityName: string) {
    const normalized = entityName.toLowerCase().trim();

    // 1. Exact normalizedName match
    const exact = await this.prisma.entityProfile.findFirst({
      where: {
        userId: { in: userIds },
        normalizedName: normalized,
        deletedAt: null,
      },
      include: { attributes: true },
    });
    if (exact) {
      this.logger.debug(`Exact match for "${entityName}": ${exact.id}`);
      return exact;
    }

    // 2. Alias match (case-insensitive — try normalized, then original case)
    for (const aliasVariant of [normalized, entityName]) {
      const aliasMatch = await this.prisma.entityProfile.findFirst({
        where: {
          userId: { in: userIds },
          deletedAt: null,
          aliases: { has: aliasVariant },
        },
        include: { attributes: true },
      });
      if (aliasMatch) {
        this.logger.debug(`Alias match for "${entityName}": ${aliasMatch.id}`);
        return aliasMatch;
      }
    }

    // 3. Fuzzy match via pg_trgm similarity()
    const fuzzy = await this.fuzzyMatch(userIds, normalized);
    if (fuzzy) {
      this.logger.debug(`Fuzzy match for "${entityName}": ${fuzzy.id}`);
      return fuzzy;
    }

    // 4. Semantic embedding match (pgvector cosine distance)
    const semantic = await this.semanticMatch(userIds, entityName);
    if (semantic) {
      this.logger.debug(`Semantic match for "${entityName}": ${semantic.id}`);
      return semantic;
    }

    this.logger.debug(`No match for "${entityName}"`);
    return null;
  }

  /**
   * Fuzzy match using pg_trgm similarity().
   * Falls back to JS Levenshtein if pg_trgm is unavailable.
   */
  private async fuzzyMatch(userIds: string[], normalized: string) {
    try {
      const results = await this.prisma.$queryRawUnsafe<
        Array<{ id: string; sim: number }>
      >(
        `SELECT ep.id, similarity(ep.normalized_name, $1) AS sim
         FROM entity_profiles ep
         WHERE ep.user_id = ANY($2::text[])
           AND ep.deleted_at IS NULL
           AND similarity(ep.normalized_name, $1) > 0.4
         ORDER BY sim DESC
         LIMIT 1`,
        normalized,
        userIds,
      );
      if (results.length > 0) {
        return this.prisma.entityProfile.findUnique({
          where: { id: results[0].id },
          include: { attributes: true },
        });
      }
    } catch (err: any) {
      // pg_trgm not available — fall back to JS Levenshtein
      this.logger.warn(
        `pg_trgm unavailable, falling back to JS Levenshtein: ${err.message}`,
      );
      return this.levenshteinFallback(userIds, normalized);
    }
    return null;
  }

  /**
   * JS Levenshtein fallback when pg_trgm is unavailable.
   */
  private async levenshteinFallback(userIds: string[], normalized: string) {
    const candidates = await this.prisma.entityProfile.findMany({
      where: {
        userId: { in: userIds },
        deletedAt: null,
      },
      select: { id: true, normalizedName: true },
      take: 500, // cap to avoid scanning huge tables
    });

    let bestId: string | null = null;
    let bestRatio = 0;

    for (const c of candidates) {
      const ratio = this.levenshteinRatio(normalized, c.normalizedName);
      if (ratio > 0.75 && ratio > bestRatio) {
        bestRatio = ratio;
        bestId = c.id;
      }
    }

    if (bestId) {
      return this.prisma.entityProfile.findUnique({
        where: { id: bestId },
        include: { attributes: true },
      });
    }
    return null;
  }

  /**
   * Levenshtein distance ratio (0–1, higher is more similar).
   */
  private levenshteinRatio(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - this.levenshteinDistance(a, b) / maxLen;
  }

  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array(n + 1).fill(0),
    );
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  /**
   * Semantic embedding match using pgvector cosine distance.
   * Only works if profiles have embeddings.
   */
  private async semanticMatch(
    userIds: string[],
    entityName: string,
  ): Promise<any | null> {
    // We need an embedding for the query. Use existing embedding service
    // pattern: generate embedding for the entity name, then compare.
    // However, since we don't inject EmbeddingService here to keep the module
    // lightweight, we do a direct cosine search against profiles that have embeddings.
    // This requires generating an embedding first. For now, skip semantic match
    // if we can't generate embeddings — the first 3 strategies cover most cases.
    try {
      // Check if any profiles even have embeddings
      const hasEmbeddings = await this.prisma.$queryRawUnsafe<
        Array<{ count: string }>
      >(
        `SELECT COUNT(*)::text as count FROM entity_profiles
         WHERE user_id = ANY($1::text[])
           AND deleted_at IS NULL
           AND embedding IS NOT NULL`,
        userIds,
      );

      if (!hasEmbeddings.length || hasEmbeddings[0].count === '0') {
        return null;
      }

      // For semantic match, we'd need to generate an embedding for entityName.
      // Without EmbeddingService injected, we skip this step.
      // This is a placeholder for when EmbeddingService is wired in.
      this.logger.debug(
        `Semantic match skipped — embedding generation not wired in yet`,
      );
      return null;
    } catch {
      return null;
    }
  }

  // ── Memory Retrieval ─────────────────────────────────────────────────

  /**
   * Get memories associated with a profile:
   * 1. Explicitly attached via EntityProfileMemory
   * 2. (Future: semantic search against memory embeddings)
   * Deduplicates and sorts by importance DESC.
   */
  private async getMemories(profileId: string, limit: number) {
    // 1. Explicitly attached memories via join table
    const attached = await this.prisma.entityProfileMemory.findMany({
      where: { profileId },
      include: {
        memory: {
          select: {
            id: true,
            raw: true,
            importanceScore: true,
            source: true,
            ingestedAt: true,
          },
        },
      },
      orderBy: { relevanceScore: 'desc' },
      take: limit,
    });

    // 2. Also get memories linked via the Entity → MemoryEntity path
    const profile = await this.prisma.entityProfile.findUnique({
      where: { id: profileId },
      select: { entityId: true },
    });

    const entityMemories: typeof attached = [];
    if (profile?.entityId) {
      const memoryEntities = await this.prisma.memoryEntity.findMany({
        where: { entityId: profile.entityId },
        include: {
          memory: {
            select: {
              id: true,
              raw: true,
              importanceScore: true,
              source: true,
              ingestedAt: true,
            },
          },
        },
        take: limit,
      });

      // Convert to same shape
      for (const me of memoryEntities) {
        entityMemories.push({
          id: me.id,
          profileId,
          memoryId: me.memoryId,
          relevanceScore: 0.7, // default for entity-linked memories
          attachMethod: 'ENTITY_LINK' as any,
          createdAt: me.memory.ingestedAt,
          memory: me.memory,
        } as any);
      }
    }

    // Deduplicate by memoryId
    const seen = new Set<string>();
    const combined: Array<{
      memory: {
        id: string;
        raw: string;
        importanceScore: number;
        source: string;
        ingestedAt: Date;
      };
      relevanceScore: number;
    }> = [];

    for (const item of [...attached, ...entityMemories]) {
      if (!seen.has(item.memoryId)) {
        seen.add(item.memoryId);
        combined.push({
          memory: item.memory,
          relevanceScore: item.relevanceScore,
        });
      }
    }

    // Sort by importance DESC, then take limit
    combined.sort(
      (a, b) => b.memory.importanceScore - a.memory.importanceScore,
    );

    return combined.slice(0, limit).map((item) => ({
      id: item.memory.id,
      content: item.memory.raw,
      importance: item.memory.importanceScore,
      relevanceScore: item.relevanceScore,
      createdAt: item.memory.ingestedAt,
      source: item.memory.source,
    }));
  }

  // ── Relationships ────────────────────────────────────────────────────

  /**
   * Get relationships for a profile by querying:
   * 1. GraphEntity linked via EntityProfile.entityId → Entity → GraphEntity (by name/type)
   * 2. Direct GraphRelationship edges
   */
  private async getRelationships(
    profile: {
      id: string;
      name: string;
      type: string;
      entityId?: string | null;
    },
    userIds: string[],
  ) {
    try {
      // Find matching GraphEntity by name for any user in account
      const graphEntity = await this.prisma.graphEntity.findFirst({
        where: {
          userId: { in: userIds },
          name: { equals: profile.name, mode: 'insensitive' },
        },
        select: { id: true },
      });

      if (!graphEntity) return [];

      // Get all relationships (both directions)
      const relationships = await this.prisma.graphRelationship.findMany({
        where: {
          OR: [
            { sourceEntityId: graphEntity.id },
            { targetEntityId: graphEntity.id },
          ],
        },
        include: {
          sourceEntity: { select: { id: true, name: true } },
          targetEntity: { select: { id: true, name: true } },
        },
        take: 50,
        orderBy: { weight: 'desc' },
      });

      return relationships.map((r) => {
        // Determine the "other" entity
        const isSource = r.sourceEntityId === graphEntity.id;
        const otherEntity = isSource ? r.targetEntity : r.sourceEntity;
        return {
          entity: otherEntity.name,
          type: r.type,
          strength: r.weight,
        };
      });
    } catch (err: any) {
      this.logger.warn(`Failed to get relationships: ${err.message}`);
      return [];
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async resolveAccountUserIds(accountId: string): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: { accountId, deletedAt: null },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
}
