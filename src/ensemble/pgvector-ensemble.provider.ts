/**
 * PgVector Ensemble Provider
 *
 * Handles multi-model embedding storage and retrieval using pgvector.
 * Stores embeddings in memory_embeddings table with model_id for separation.
 *
 * Key features:
 * - Stores embeddings per model per memory
 * - Handles different dimensions (768 for bge/nomic, 384 for minilm)
 * - Uses partial indexes for efficient dimension-specific queries
 * - Supports upsert (update on conflict)
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ModelId,
  MODEL_CONFIGS,
  ALL_MODELS,
  ModelSearchResult,
  ModelStatus,
  ModelQualityMetrics,
  CoverageStats,
  ModelCoverageStats,
  MemoryEmbeddingStatus,
  ABTestResult,
} from './ensemble.types';

export interface EnsembleEmbeddingRecord {
  memoryId: string;
  modelId: ModelId;
  embedding: number[];
  dimensions: number;
}

export interface EnsembleSearchOptions {
  userId: string;
  modelId: ModelId;
  embedding: number[];
  limit: number;
}

export interface EnsembleSearchResult {
  memoryId: string;
  score: number;
  modelId: ModelId;
}

@Injectable()
export class PgVectorEnsembleProvider {
  private readonly logger = new Logger(PgVectorEnsembleProvider.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Upsert a single embedding for a memory/model pair
   */
  async upsertEmbedding(record: EnsembleEmbeddingRecord): Promise<void> {
    const embeddingStr = `[${record.embedding.join(',')}]`;
    const now = new Date();

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO memory_embeddings (id, memory_id, model_id, dimensions, embedding, created_at, updated_at)
      VALUES (gen_random_uuid()::text, $1, $2, $3, $4::vector, $5, $5)
      ON CONFLICT (memory_id, model_id) 
      DO UPDATE SET 
        embedding = $4::vector,
        dimensions = $3,
        updated_at = $5
      `,
      record.memoryId,
      record.modelId,
      record.dimensions,
      embeddingStr,
      now,
    );
  }

  /**
   * Upsert multiple embeddings in a batch
   */
  async upsertEmbeddings(records: EnsembleEmbeddingRecord[]): Promise<void> {
    // Use a transaction for atomicity
    await this.prisma.$transaction(
      async (tx) => {
        for (const record of records) {
          const embeddingStr = `[${record.embedding.join(',')}]`;
          const now = new Date();

          await tx.$executeRawUnsafe(
            `
          INSERT INTO memory_embeddings (id, memory_id, model_id, dimensions, embedding, created_at, updated_at)
          VALUES (gen_random_uuid()::text, $1, $2, $3, $4::vector, $5, $5)
          ON CONFLICT (memory_id, model_id) 
          DO UPDATE SET 
            embedding = $4::vector,
            dimensions = $3,
            updated_at = $5
          `,
            record.memoryId,
            record.modelId,
            record.dimensions,
            embeddingStr,
            now,
          );
        }
      },
      { timeout: 120000 },
    );
  }

  /**
   * Query embeddings for a specific model
   * Uses cosine distance for similarity search
   *
   * Each call runs in its own $transaction to get an independent pooled
   * connection. $transaction is in NON_TRANSACTIONAL_PROPS so the PrismaService
   * proxy bypasses the surrounding RLS transaction and opens a fresh connection.
   * This prevents 25P02 "current transaction is aborted" errors from propagating
   * across parallel model queries that share the RLS transaction connection.
   *
   * The memories RLS policy is: rls_account_id() IS NULL OR user_id IN (...).
   * Without SET LOCAL the policy returns NULL → passes for all rows (admin mode).
   * User scoping is enforced by the explicit m.user_id = $4 WHERE clause.
   */
  async queryByModel(
    options: EnsembleSearchOptions,
  ): Promise<EnsembleSearchResult[]> {
    const embeddingStr = `[${options.embedding.join(',')}]`;
    const dimensions = options.embedding.length;

    const results = await this.prisma.$transaction(
      async (tx) =>
        tx.$queryRawUnsafe<Array<{ memory_id: string; score: number }>>(
          `
      SELECT
        me.memory_id,
        1 - (me.embedding <=> $1::vector) as score
      FROM memory_embeddings me
      JOIN memories m ON m.id = me.memory_id
      WHERE me.model_id = $2
        AND me.dimensions = $3
        AND me.embedding IS NOT NULL
        AND m.user_id = $4
        AND m.deleted_at IS NULL
      ORDER BY me.embedding <=> $1::vector
      LIMIT $5
      `,
          embeddingStr,
          options.modelId,
          dimensions,
          options.userId,
          options.limit,
        ),
    );

    return results.map((r) => ({
      memoryId: r.memory_id,
      score: Number(r.score),
      modelId: options.modelId,
    }));
  }

  /**
   * Query all models and return per-model results
   * This is the core method for ensemble retrieval
   */
  async queryAllModels(
    embedding: number[],
    userId: string,
    models: ModelId[],
    limit: number,
  ): Promise<Map<ModelId, ModelSearchResult[]>> {
    const results = new Map<ModelId, ModelSearchResult[]>();

    // Query each model in parallel
    await Promise.all(
      models.map(async (modelId) => {
        const modelConfig = MODEL_CONFIGS[modelId];

        // Skip if embedding dimensions don't match this model
        if (embedding.length !== modelConfig.dimensions) {
          this.logger.debug(
            `Skipping model ${modelId}: embedding dims ${embedding.length} != model dims ${modelConfig.dimensions}`,
          );
          return;
        }

        try {
          const searchResults = await this.queryByModel({
            userId,
            modelId,
            embedding,
            limit,
          });

          const ranked: ModelSearchResult[] = searchResults.map((r, idx) => ({
            memoryId: r.memoryId,
            model: modelId,
            rank: idx + 1,
            score: r.score,
          }));

          results.set(modelId, ranked);
        } catch (error) {
          this.logger.error(`Query failed for model ${modelId}`, error);
        }
      }),
    );

    return results;
  }

  /**
   * Query with model-specific embeddings (when caller has pre-computed per-model embeddings)
   */
  async queryWithModelEmbeddings(
    embeddings: Map<ModelId, number[]>,
    userId: string,
    limit: number,
  ): Promise<Map<ModelId, ModelSearchResult[]>> {
    const results = new Map<ModelId, ModelSearchResult[]>();

    await Promise.all(
      Array.from(embeddings.entries()).map(async ([modelId, embedding]) => {
        try {
          const searchResults = await this.queryByModel({
            userId,
            modelId,
            embedding,
            limit,
          });

          const ranked: ModelSearchResult[] = searchResults.map((r, idx) => ({
            memoryId: r.memoryId,
            model: modelId,
            rank: idx + 1,
            score: r.score,
          }));

          results.set(modelId, ranked);
        } catch (error) {
          this.logger.error(`Query failed for model ${modelId}`, error);
        }
      }),
    );

    return results;
  }

  /**
   * Delete all embeddings for a memory
   */
  async deleteByMemory(memoryId: string): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM memory_embeddings WHERE memory_id = ${memoryId}
    `;
  }

  /**
   * Delete embeddings for a specific model/memory pair
   */
  async deleteByMemoryAndModel(
    memoryId: string,
    modelId: ModelId,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM memory_embeddings 
      WHERE memory_id = ${memoryId} AND model_id = ${modelId}
    `;
  }

  /**
   * Delete all embeddings for a user (cascade through memories table handles this)
   */
  async deleteByUser(userId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `
      DELETE FROM memory_embeddings me
      USING memories m
      WHERE me.memory_id = m.id AND m.user_id = $1
      `,
      userId,
    );
  }

  /**
   * Get embedding count by model
   */
  async getEmbeddingCountByModel(): Promise<Record<ModelId, number>> {
    const results = await this.prisma.$queryRaw<
      Array<{ model_id: string; count: bigint }>
    >`
      SELECT model_id, COUNT(*) as count
      FROM memory_embeddings
      WHERE embedding IS NOT NULL
      GROUP BY model_id
    `;

    const counts: Record<string, number> = {};
    for (const row of results) {
      counts[row.model_id] = Number(row.count);
    }
    return counts as Record<ModelId, number>;
  }

  /**
   * Check if a memory has embeddings for all specified models
   */
  async hasAllModelEmbeddings(
    memoryId: string,
    models: ModelId[],
  ): Promise<boolean> {
    const result = await this.prisma.$queryRawUnsafe<[{ count: bigint }]>(
      `
      SELECT COUNT(*) as count
      FROM memory_embeddings
      WHERE memory_id = $1 
        AND model_id = ANY($2)
        AND embedding IS NOT NULL
      `,
      memoryId,
      models,
    );

    return Number(result[0].count) === models.length;
  }

  /**
   * Get memories missing embeddings for any of the specified models
   */
  async getMemoriesMissingEmbeddings(
    userId: string,
    models: ModelId[],
    limit: number = 1000,
  ): Promise<string[]> {
    // Find memories that don't have embeddings for all models
    const results = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `
      SELECT m.id
      FROM memories m
      WHERE m.user_id = $1
        AND m.deleted_at IS NULL
        AND (
          SELECT COUNT(DISTINCT me.model_id)
          FROM memory_embeddings me
          WHERE me.memory_id = m.id
            AND me.model_id = ANY($2)
            AND me.embedding IS NOT NULL
        ) < $3
      ORDER BY m.created_at DESC
      LIMIT $4
      `,
      userId,
      models,
      models.length,
      limit,
    );

    return results.map((r) => r.id);
  }

  /**
   * Get the existing embedding for drift comparison
   */
  async getExistingEmbedding(
    memoryId: string,
    modelId: ModelId,
  ): Promise<number[] | null> {
    const result = await this.prisma.$queryRawUnsafe<
      Array<{ embedding: string }>
    >(
      `
      SELECT embedding::text
      FROM memory_embeddings
      WHERE memory_id = $1 AND model_id = $2 AND embedding IS NOT NULL
      `,
      memoryId,
      modelId,
    );

    if (result.length === 0 || !result[0].embedding) {
      return null;
    }

    // Parse the vector string "[1.0,2.0,3.0]" to number array
    const embStr = result[0].embedding;
    const nums = embStr.slice(1, -1).split(',').map(Number);
    return nums;
  }

  /**
   * Get model configs from database
   */
  async getModelConfigs(): Promise<
    Array<{
      modelId: ModelId;
      status: ModelStatus;
      weight: number;
      qualityMetrics: ModelQualityMetrics | null;
      addedAt: Date | null;
      promotedAt: Date | null;
    }>
  > {
    try {
      const results = await this.prisma.$queryRaw<
        Array<{
          model_id: string;
          status: string;
          weight: number;
          quality_metrics: string | null;
          added_at: Date | null;
          promoted_at: Date | null;
        }>
      >`
        SELECT model_id, status, weight, quality_metrics, added_at, promoted_at
        FROM ensemble_model_configs
      `;

      return results.map((r) => ({
        modelId: r.model_id as ModelId,
        status: r.status.toLowerCase() as ModelStatus,
        weight: r.weight,
        qualityMetrics: r.quality_metrics
          ? JSON.parse(String(r.quality_metrics))
          : null,
        addedAt: r.added_at,
        promotedAt: r.promoted_at,
      }));
    } catch (error) {
      // Table might not exist or be empty - that's OK
      this.logger.debug('Could not fetch model configs from DB', error);
      return [];
    }
  }

  /**
   * Get embedding coverage statistics
   */
  async getCoverageStats(activeModels: ModelId[]): Promise<CoverageStats> {
    // Get total memory count
    const totalResult = await this.prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM memories WHERE deleted_at IS NULL
    `;
    const totalMemories = Number(totalResult[0].count);

    // Get count of memories with at least one embedding
    const anyEmbeddingResult = await this.prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(DISTINCT memory_id) as count 
      FROM memory_embeddings 
      WHERE embedding IS NOT NULL
    `;
    const memoriesWithAnyEmbedding = Number(anyEmbeddingResult[0].count);

    // Get count of memories with all active models
    const allModelsResult = await this.prisma.$queryRawUnsafe<
      [{ count: bigint }]
    >(
      `
      SELECT COUNT(*) as count
      FROM (
        SELECT memory_id
        FROM memory_embeddings
        WHERE model_id = ANY($1) AND embedding IS NOT NULL
        GROUP BY memory_id
        HAVING COUNT(DISTINCT model_id) = $2
      ) sub
      `,
      activeModels,
      activeModels.length,
    );
    const memoriesWithAllModels = Number(allModelsResult[0].count);

    // Get per-model stats
    const perModelResults = await this.prisma.$queryRaw<
      Array<{ model_id: string; count: bigint }>
    >`
      SELECT model_id, COUNT(*) as count
      FROM memory_embeddings
      WHERE embedding IS NOT NULL
      GROUP BY model_id
    `;

    const perModel: Record<string, ModelCoverageStats> = {};
    for (const modelId of activeModels) {
      const row = perModelResults.find((r) => r.model_id === modelId);
      const embeddingCount = row ? Number(row.count) : 0;
      perModel[modelId] = {
        embeddingCount,
        coveragePercent:
          totalMemories > 0 ? (embeddingCount / totalMemories) * 100 : 0,
        missingCount: totalMemories - embeddingCount,
      };
    }

    return {
      totalMemories,
      memoriesWithAnyEmbedding,
      memoriesWithAllModels,
      coveragePercent:
        totalMemories > 0
          ? (memoriesWithAnyEmbedding / totalMemories) * 100
          : 0,
      perModel: perModel as Record<ModelId, ModelCoverageStats>,
    };
  }

  /**
   * Get embedding status for a specific memory
   */
  async getMemoryEmbeddingStatus(
    memoryId: string,
  ): Promise<MemoryEmbeddingStatus[]> {
    const results = await this.prisma.$queryRawUnsafe<
      Array<{
        model_id: string;
        dimensions: number | null;
        created_at: Date | null;
        updated_at: Date | null;
        has_embedding: boolean;
      }>
    >(
      `
      SELECT 
        model_id,
        dimensions,
        created_at,
        updated_at,
        (embedding IS NOT NULL) as has_embedding
      FROM memory_embeddings
      WHERE memory_id = $1
      `,
      memoryId,
    );

    // Create a map of existing embeddings
    const existingMap = new Map(results.map((r) => [r.model_id, r]));

    // Return status for all known models (useful for debugging)
    return ALL_MODELS.map((modelId) => {
      const existing = existingMap.get(modelId);
      return {
        modelId,
        hasEmbedding: existing?.has_embedding ?? false,
        dimensions: existing?.dimensions ?? null,
        createdAt: existing?.created_at ?? null,
        updatedAt: existing?.updated_at ?? null,
      };
    });
  }

  /**
   * Get A/B test results from database
   */
  async getABTestResults(
    testId?: string,
    limit: number = 100,
  ): Promise<ABTestResult[]> {
    try {
      let results: Array<{
        id: string;
        test_id: string;
        config: string;
        query_id: string;
        metrics: unknown;
        timestamp: Date;
      }>;

      if (testId) {
        results = await this.prisma.$queryRawUnsafe(
          `
          SELECT id, test_id, config, query_id, metrics, timestamp
          FROM ensemble_ab_test_results
          WHERE test_id = $1
          ORDER BY timestamp DESC
          LIMIT $2
          `,
          testId,
          limit,
        );
      } else {
        results = await this.prisma.$queryRawUnsafe(
          `
          SELECT id, test_id, config, query_id, metrics, timestamp
          FROM ensemble_ab_test_results
          ORDER BY timestamp DESC
          LIMIT $1
          `,
          limit,
        );
      }

      return results.map((r) => ({
        id: r.id,
        testId: r.test_id,
        config: r.config,
        queryId: r.query_id,
        metrics: r.metrics as Record<string, unknown>,
        timestamp: r.timestamp,
      }));
    } catch (error) {
      // Table might be empty or not have data yet - that's OK
      this.logger.debug('Could not fetch A/B test results', error);
      return [];
    }
  }
}
