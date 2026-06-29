import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  VectorProvider,
  VectorRecord,
  VectorSearchResult,
  VectorSearchOptions,
} from '../vector.interface';
import { HybridSearchService } from '../hybrid-search.service';
import {
  resolveEmbeddingModelId,
  resolveExpectedDimensions,
} from '../embedding-model.util';

/**
 * pgvector Provider
 *
 * Uses PostgreSQL's pgvector extension for vector storage.
 * Default provider - no external dependencies, runs locally.
 *
 * ENG-26: Now supports hybrid search (BM25 + vector fusion) via HybridSearchService.
 */
@Injectable()
export class PgVectorProvider implements VectorProvider {
  private readonly logger = new Logger(PgVectorProvider.name);
  readonly name = 'pgvector';
  private readonly searchModel: string;
  private readonly disableLegacyFallback: boolean;
  private readonly hybridEnabled: boolean;
  private legacyCheckCache: boolean | null = null;

  constructor(
    private prisma: PrismaService,
    @Optional() private hybridSearch?: HybridSearchService,
  ) {
    // Audit C1: write and search MUST resolve the model ID identically.
    this.searchModel = resolveEmbeddingModelId();
    this.disableLegacyFallback =
      process.env.DISABLE_LEGACY_EMBEDDING_FALLBACK === 'true';
    this.hybridEnabled =
      process.env.HYBRID_SEARCH_ENABLED !== 'false' && !!this.hybridSearch;

    if (this.hybridEnabled) {
      this.logger.log('[PgVector] Hybrid search enabled (ENG-26)');
    }
  }

  /**
   * Model ID used for both memory_embeddings writes and the search JOIN.
   * Exposed so tests can assert write/search agreement (audit C1).
   */
  getSearchModelId(): string {
    return this.searchModel;
  }

  async upsert(record: VectorRecord): Promise<void> {
    // Dimension guard: fail loudly if incoming vector doesn't match the
    // expected dims for the configured model.  A silent mismatch would write
    // a wrong-sized vector under model_id=searchModel, making every write
    // invisible to the search JOIN (or triggering a pgvector type error).
    const expectedDims = resolveExpectedDimensions();
    if (expectedDims !== undefined && record.embedding.length !== expectedDims) {
      throw new Error(
        `[PgVector] Dimension mismatch for model '${this.searchModel}': ` +
          `expected ${expectedDims} dims but got ${record.embedding.length}. ` +
          `Check EMBEDDING_PROVIDER / LOCAL_EMBED_MODEL / EMBEDDING_MODEL alignment.`,
      );
    }

    const embeddingStr = this.serializeEmbedding(record.embedding, 'upsert');

    // Legacy inline column is vector(768) — only write when dims match to avoid
    // Postgres error 22000 with newer models (e.g. openai-small at 1536 dims).
    const LEGACY_INLINE_DIMS = 768;
    let updated: number;
    if (record.embedding.length === LEGACY_INLINE_DIMS) {
      updated = await this.prisma.$executeRawUnsafe(
        `
        UPDATE memories
        SET embedding = $1::vector
        WHERE id = $2
      `,
        embeddingStr,
        record.id,
      );
    } else {
      // Skip the inline UPDATE; confirm memory existence with a cheap SELECT so
      // the memory_embeddings insert below is still gated on a real memory ID.
      const rows = await this.prisma.$queryRawUnsafe<Array<{ exists: number }>>(
        `SELECT 1 AS exists FROM memories WHERE id = $1`,
        record.id,
      );
      updated = rows.length;
    }

    // Only write to memory_embeddings if this ID is a real memory
    // (HierarchyService passes pinecone-style IDs like "hierarchy_l0_xxx" which aren't memory IDs)
    if (updated > 0) {
      await this.prisma.$executeRawUnsafe(
        `
        INSERT INTO memory_embeddings (id, memory_id, model_id, dimensions, embedding, created_at, updated_at)
        VALUES (
          concat('cl', substr(md5(random()::text), 1, 23)),
          $2,
          $3,
          $4,
          $1::vector,
          NOW(),
          NOW()
        )
        ON CONFLICT (memory_id, model_id)
        DO UPDATE SET embedding = $1::vector, updated_at = NOW()
      `,
        embeddingStr,
        record.id,
        this.searchModel,
        record.embedding.length,
      );
    }
  }

  async upsertMany(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      await this.upsert(record);
    }
  }

  async search(
    embedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    const embeddingStr = this.serializeEmbedding(embedding, 'search');
    const limit = options.limit || 10;

    // Build WHERE clause for the memories table filters
    const userIds = Array.isArray(options.userId)
      ? options.userId
      : [options.userId];
    // params[0] = embedding string ($1)
    // params[1] = search model ($2)
    const params: any[] = [embeddingStr, this.searchModel];
    let paramIndex = 3;

    // User ID filter — skip when pool membership JOIN is the auth boundary
    let memoryWhereClause: string;
    if (options.filter?.poolIds && options.filter.poolIds.length > 0) {
      memoryWhereClause = `m.deleted_at IS NULL`;
    } else if (userIds.length === 1) {
      memoryWhereClause = `m.user_id = $${paramIndex} AND m.deleted_at IS NULL`;
      params.push(userIds[0]);
      paramIndex++;
    } else {
      const userPlaceholders = userIds
        .map((_, i) => `$${paramIndex + i}`)
        .join(', ');
      memoryWhereClause = `m.user_id IN (${userPlaceholders}) AND m.deleted_at IS NULL`;
      params.push(...userIds);
      paramIndex += userIds.length;
    }

    // Audit H5: exclude superseded and non-searchable memories at the SQL
    // level so they never enter the candidate scoreMap.
    memoryWhereClause += ` AND m.superseded_by_id IS NULL AND m.searchable IS NOT FALSE`;

    if (options.filter?.layers && options.filter.layers.length > 0) {
      const layerPlaceholders = options.filter.layers
        .map((_, i) => `$${paramIndex + i}::"MemoryLayer"`)
        .join(', ');
      memoryWhereClause += ` AND m.layer IN (${layerPlaceholders})`;
      params.push(...options.filter.layers);
      paramIndex += options.filter.layers.length;
    }

    if (options.filter?.projectId) {
      memoryWhereClause += ` AND m.project_id = $${paramIndex}`;
      params.push(options.filter.projectId);
      paramIndex++;
    }

    // Exclude non-survivor memories at the SQL level so stale duplicates do
    // not pollute vector candidates or bury freshly-written memories.
    memoryWhereClause +=
      ` AND m.superseded_by_id IS NULL AND m.searchable IS NOT FALSE AND m.embedding_status != 'DUPLICATE'`;

    // Pool filtering: JOIN on memory_pool_memberships to restrict results
    let poolJoinClause = '';
    if (options.filter?.poolIds && options.filter.poolIds.length > 0) {
      const poolPlaceholders = options.filter.poolIds
        .map((_, i) => `$${paramIndex + i}`)
        .join(', ');
      poolJoinClause = `JOIN memory_pool_memberships mpm ON mpm.memory_id = m.id AND mpm.pool_id IN (${poolPlaceholders})`;
      params.push(...options.filter.poolIds);
      paramIndex += options.filter.poolIds.length;
    }

    // ENG-42: Tag containment filter (AND logic — memory must have ALL listed tags)
    if (options.filter?.tags && options.filter.tags.length > 0) {
      const tagPlaceholders = options.filter.tags
        .map((_, i) => `$${paramIndex + i}`)
        .join(', ');
      memoryWhereClause += ` AND m.tags @> ARRAY[${tagPlaceholders}]::text[]`;
      params.push(...options.filter.tags);
      paramIndex += options.filter.tags.length;
    }

    // ENG-42: Metadata JSONB containment filter
    if (
      options.filter?.metadata &&
      Object.keys(options.filter.metadata).length > 0
    ) {
      memoryWhereClause += ` AND m.metadata @> $${paramIndex}::jsonb`;
      params.push(JSON.stringify(options.filter.metadata));
      paramIndex++;
    }

    // DEBUG: log search params
    this.logger.log(
      `[PgVector] search: model=${this.searchModel}, userId=${Array.isArray(options.userId) ? options.userId.join(',') : options.userId}, embDim=${embedding.length}, limit=${limit}, params=${params.length}, poolFilter=${!!options.filter?.poolIds}`,
    );

    // Determine whether to include legacy fallback (UNION ALL on memories.embedding)
    const skipFallback = await this.shouldSkipLegacyFallback();

    // Clamp limit to a safe positive integer before interpolation into SQL.
    // LIMIT cannot be a bound parameter in this dynamic query construction;
    // Math.trunc guarantees it is a plain integer with no injection potential.
    const safeLimit = Math.max(1, Math.trunc(limit));

    const primaryQuery = `
        SELECT
          m.id,
          1 - (me.embedding <=> $1::vector) as score
        FROM memories m
        JOIN memory_embeddings me ON me.memory_id = m.id
        ${poolJoinClause}
        WHERE me.model_id = $2
          AND ${memoryWhereClause}
          AND me.embedding IS NOT NULL
        ORDER BY me.embedding <=> $1::vector
        LIMIT ${safeLimit}`;

    const fallbackQuery = `
      UNION ALL
      (
        SELECT
          m.id,
          1 - (m.embedding <=> $1::vector) as score
        FROM memories m
        ${poolJoinClause}
        WHERE ${memoryWhereClause}
          AND m.embedding IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM memory_embeddings me
            WHERE me.memory_id = m.id AND me.model_id = $2
          )
        ORDER BY m.embedding <=> $1::vector
        LIMIT ${safeLimit}
      )`;

    const query = skipFallback
      ? `${primaryQuery} `
      : `(${primaryQuery}) ${fallbackQuery} ORDER BY score DESC LIMIT ${safeLimit}`;

    // Search ensemble embeddings first, optionally fall back to inline column
    const results = await this.prisma.$queryRawUnsafe<
      Array<{ id: string; score: number }>
    >(query, ...params);

    this.logger.log(
      `[PgVector] search results: ${results.length}`,
      results.slice(0, 3),
    );

    const vectorResults = results.map((r) => ({
      id: r.id,
      score: Number(r.score),
    }));

    // ENG-26: Hybrid search — fuse vector results with text search if enabled
    if (this.hybridEnabled && this.hybridSearch && options._queryText) {
      try {
        const textResults = await this.hybridSearch.textSearch(
          options._queryText,
          options,
        );

        if (textResults.length > 0) {
          const weights = this.hybridSearch.classifyQuery(options._queryText);
          const fused = this.hybridSearch.fuseResults(
            vectorResults,
            textResults,
            limit,
          );

          this.logger.log(
            `[PgVector] Hybrid fusion: ${vectorResults.length} vector + ${textResults.length} text → ${fused.length} fused (weights: v=${weights.vectorWeight.toFixed(2)}, t=${weights.textWeight.toFixed(2)})`,
          );

          return fused;
        }
      } catch (error) {
        this.logger.warn(
          `[PgVector] Hybrid search failed, falling back to vector-only: ${(error as Error).message}`,
        );
      }
    }

    return vectorResults;
  }

  private serializeEmbedding(embedding: number[], operation: string): string {
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error(
        `[PgVector] Invalid embedding for ${operation}: expected non-empty array`,
      );
    }

    // Ingest H2: sparse arrays (e.g. `new Array(768)`) have holes that
    // .some()/.every() skip, so they previously passed validation and
    // serialized to '[,,,]' — a Postgres 22P02 error. Reject arrays whose
    // own-key count differs from their length (holes), and validate every
    // slot with an index-based loop that does NOT skip holes.
    if (Object.keys(embedding).length !== embedding.length) {
      throw new Error(
        `[PgVector] Invalid embedding for ${operation}: sparse array with holes`,
      );
    }

    for (let i = 0; i < embedding.length; i++) {
      const value = embedding[i];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `[PgVector] Invalid embedding for ${operation}: contains non-finite values`,
        );
      }
    }

    return `[${embedding.join(',')}]`;
  }

  async delete(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE memories SET embedding = NULL WHERE id = ${id}
    `;
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE memories SET embedding = NULL WHERE user_id = ${userId}
    `;
  }

  /**
   * Determines whether to skip the legacy UNION ALL fallback on memories.embedding.
   * Feature flag (DISABLE_LEGACY_EMBEDDING_FALLBACK=true) takes priority.
   * Otherwise, performs a one-time runtime check to see if any memories still
   * lack memory_embeddings rows; caches the result for the process lifetime.
   */
  async shouldSkipLegacyFallback(): Promise<boolean> {
    if (this.disableLegacyFallback) {
      return true;
    }

    if (this.legacyCheckCache !== null) {
      return this.legacyCheckCache;
    }

    try {
      const result = await this.prisma.$queryRawUnsafe<
        Array<{ count: bigint }>
      >(
        `SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL AND id NOT IN (SELECT memory_id FROM memory_embeddings)`,
      );
      const unmigrated = Number(result[0]?.count ?? 1);
      this.legacyCheckCache = unmigrated === 0;
      this.logger.log(
        `[PgVector] legacy fallback check: ${unmigrated} unmigrated memories, skipFallback=${this.legacyCheckCache}`,
      );
    } catch {
      // If the check fails, keep the fallback for safety
      this.legacyCheckCache = false;
    }

    return this.legacyCheckCache;
  }

  isConfigured(): boolean {
    // pgvector is always configured if Postgres is running
    return true;
  }
}
