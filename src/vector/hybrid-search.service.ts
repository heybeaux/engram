import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { VectorSearchResult, VectorSearchOptions } from './vector.interface';

export interface HybridSearchConfig {
  /** Weight for vector similarity scores (default 0.6) */
  vectorWeight: number;
  /** Weight for text search scores (default 0.4) */
  textWeight: number;
  /** RRF k parameter — higher = more conservative fusion (default 60) */
  rrfK: number;
  /** Minimum text score to include in fusion (default 0.01) */
  minTextScore: number;
  /** Enable trigram fuzzy matching (default true) */
  enableFuzzy: boolean;
}

export interface HybridSearchResult extends VectorSearchResult {
  vectorRank?: number;
  textRank?: number;
  textScore?: number;
  fusionMethod: 'rrf' | 'vector_only';
}

@Injectable()
export class HybridSearchService {
  private readonly logger = new Logger(HybridSearchService.name);
  private readonly config: HybridSearchConfig;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.config = {
      vectorWeight: parseFloat(
        this.configService.get('HYBRID_VECTOR_WEIGHT', '0.6'),
      ),
      textWeight: parseFloat(
        this.configService.get('HYBRID_TEXT_WEIGHT', '0.4'),
      ),
      rrfK: parseInt(this.configService.get('HYBRID_RRF_K', '60'), 10),
      minTextScore: parseFloat(
        this.configService.get('HYBRID_MIN_TEXT_SCORE', '0.01'),
      ),
      enableFuzzy: this.configService.get('HYBRID_FUZZY_ENABLED', 'true') !== 'false',
    };

    this.logger.log(
      `[HybridSearch] Initialized: vectorWeight=${this.config.vectorWeight}, textWeight=${this.config.textWeight}, rrfK=${this.config.rrfK}`,
    );
  }

  /**
   * Perform full-text search against the memories table.
   * Uses PostgreSQL's tsvector + plainto_tsquery for ranked text matching.
   * Falls back to trigram similarity for fuzzy matches when enabled.
   */
  async textSearch(
    query: string,
    options: VectorSearchOptions,
  ): Promise<Array<{ id: string; score: number }>> {
    const userIds = Array.isArray(options.userId)
      ? options.userId
      : [options.userId];
    const limit = options.limit || 50;

    const params: any[] = [query];
    let paramIndex = 2;

    // User ID filter
    let whereClause: string;
    if (userIds.length === 1) {
      whereClause = `m.user_id = $${paramIndex} AND m.deleted_at IS NULL`;
      params.push(userIds[0]);
      paramIndex++;
    } else {
      const placeholders = userIds.map((_, i) => `$${paramIndex + i}`).join(', ');
      whereClause = `m.user_id IN (${placeholders}) AND m.deleted_at IS NULL`;
      params.push(...userIds);
      paramIndex += userIds.length;
    }

    // Layer filter
    if (options.filter?.layers && options.filter.layers.length > 0) {
      const layerPlaceholders = options.filter.layers
        .map((_, i) => `$${paramIndex + i}::"MemoryLayer"`)
        .join(', ');
      whereClause += ` AND m.layer IN (${layerPlaceholders})`;
      params.push(...options.filter.layers);
      paramIndex += options.filter.layers.length;
    }

    // Project filter
    if (options.filter?.projectId) {
      whereClause += ` AND m.project_id = $${paramIndex}`;
      params.push(options.filter.projectId);
      paramIndex++;
    }

    // Pool filter
    let poolJoin = '';
    if (options.filter?.poolIds && options.filter.poolIds.length > 0) {
      const poolPlaceholders = options.filter.poolIds
        .map((_, i) => `$${paramIndex + i}`)
        .join(', ');
      poolJoin = `JOIN memory_pool_memberships mpm ON mpm.memory_id = m.id AND mpm.pool_id IN (${poolPlaceholders})`;
      params.push(...options.filter.poolIds);
      paramIndex += options.filter.poolIds.length;
    }

    // Full-text search query with optional trigram fallback
    // Strategy: try tsvector match first, then trigram similarity as fallback
    const sql = this.config.enableFuzzy
      ? `
        SELECT id, score FROM (
          -- Full-text matches (highest quality)
          SELECT m.id, ts_rank_cd(m.search_vector, plainto_tsquery('english', $1)) AS score
          FROM memories m
          ${poolJoin}
          WHERE ${whereClause}
            AND m.search_vector @@ plainto_tsquery('english', $1)

          UNION ALL

          -- Trigram fuzzy matches (fallback for misspellings, partial matches)
          SELECT m.id, similarity(m.raw, $1) * 0.5 AS score
          FROM memories m
          ${poolJoin}
          WHERE ${whereClause}
            AND m.search_vector IS NOT NULL
            AND similarity(m.raw, $1) > 0.15
            AND NOT (m.search_vector @@ plainto_tsquery('english', $1))
        ) combined
        ORDER BY score DESC
        LIMIT ${limit}
      `
      : `
        SELECT m.id, ts_rank_cd(m.search_vector, plainto_tsquery('english', $1)) AS score
        FROM memories m
        ${poolJoin}
        WHERE ${whereClause}
          AND m.search_vector @@ plainto_tsquery('english', $1)
        ORDER BY score DESC
        LIMIT ${limit}
      `;

    try {
      const results = await this.prisma.$queryRawUnsafe<
        Array<{ id: string; score: number }>
      >(sql, ...params);

      this.logger.log(`[HybridSearch] text search: ${results.length} results for "${query.substring(0, 50)}"`);
      return results.map((r) => ({ id: r.id, score: Number(r.score) }));
    } catch (error) {
      this.logger.warn(
        `[HybridSearch] text search failed, returning empty: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Fuse vector search results with text search results using Reciprocal Rank Fusion (RRF).
   *
   * RRF score = sum( 1 / (k + rank_i) ) for each result list where the document appears.
   * This is rank-based, not score-based, so it's robust to different score distributions.
   *
   * Reference: Cormack et al., "Reciprocal Rank Fusion outperforms Condorcet and individual
   * Rank Learning Methods" (SIGIR 2009)
   */
  fuseResults(
    vectorResults: VectorSearchResult[],
    textResults: Array<{ id: string; score: number }>,
    limit: number,
  ): HybridSearchResult[] {
    const k = this.config.rrfK;
    const vectorWeight = this.config.vectorWeight;
    const textWeight = this.config.textWeight;

    // Build rank maps
    const vectorRankMap = new Map<string, number>();
    vectorResults.forEach((r, i) => vectorRankMap.set(r.id, i + 1));

    const textRankMap = new Map<string, number>();
    const textScoreMap = new Map<string, number>();
    textResults.forEach((r, i) => {
      textRankMap.set(r.id, i + 1);
      textScoreMap.set(r.id, r.score);
    });

    // Collect all unique IDs
    const allIds = new Set([
      ...vectorResults.map((r) => r.id),
      ...textResults.map((r) => r.id),
    ]);

    // Calculate RRF scores
    const fused: HybridSearchResult[] = [];
    for (const id of allIds) {
      const vectorRank = vectorRankMap.get(id);
      const textRank = textRankMap.get(id);

      let rrfScore = 0;
      if (vectorRank !== undefined) {
        rrfScore += vectorWeight * (1 / (k + vectorRank));
      }
      if (textRank !== undefined) {
        rrfScore += textWeight * (1 / (k + textRank));
      }

      // Use the vector score as the base (for downstream compatibility)
      const vectorResult = vectorResults.find((r) => r.id === id);
      const baseScore = vectorResult?.score ?? 0;

      fused.push({
        id,
        score: rrfScore,
        vectorRank,
        textRank,
        textScore: textScoreMap.get(id),
        fusionMethod: textRank !== undefined ? 'rrf' : 'vector_only',
        metadata: vectorResult?.metadata,
      });
    }

    // Sort by RRF score descending
    fused.sort((a, b) => b.score - a.score);

    return fused.slice(0, limit);
  }

  /**
   * Detect if a query is keyword-heavy (names, acronyms, IDs) vs semantic.
   * Keyword-heavy queries get higher text weight.
   */
  classifyQuery(query: string): { vectorWeight: number; textWeight: number } {
    const words = query.split(/\s+/);
    const totalWords = words.length;
    if (totalWords === 0) return { vectorWeight: this.config.vectorWeight, textWeight: this.config.textWeight };

    // Indicators of keyword-heavy queries
    let keywordSignals = 0;

    // Short queries (1-3 words) are more likely keyword searches
    if (totalWords <= 3) keywordSignals += 2;

    // ALL CAPS words (acronyms like MAP, OB, IV)
    const capsWords = words.filter((w) => w.length >= 2 && w === w.toUpperCase() && /^[A-Z]+$/.test(w));
    keywordSignals += capsWords.length * 2;

    // Proper nouns (capitalized, not sentence start)
    const properNouns = words
      .slice(1)
      .filter((w) => w.length >= 2 && /^[A-Z][a-z]/.test(w));
    keywordSignals += properNouns.length;

    // IDs, ticket numbers, codes (HEY-480, SOL123, etc.)
    const idPatterns = words.filter((w) => /^[A-Z]+-\d+$|^\w+\d+\w*$/.test(w));
    keywordSignals += idPatterns.length * 3;

    // Quoted phrases
    const hasQuotes = /["']/.test(query);
    if (hasQuotes) keywordSignals += 3;

    // Score: 0 = pure semantic, 10+ = very keyword-heavy
    const keywordness = Math.min(keywordSignals / (totalWords + 1), 1);

    // Shift weights toward text when keyword-heavy
    const adjustedTextWeight = this.config.textWeight + keywordness * 0.3;
    const adjustedVectorWeight = 1 - adjustedTextWeight;

    return {
      vectorWeight: Math.max(0.2, adjustedVectorWeight),
      textWeight: Math.min(0.8, adjustedTextWeight),
    };
  }

  getConfig(): HybridSearchConfig {
    return { ...this.config };
  }
}
