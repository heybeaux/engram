import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  resolveEmbeddingModelId,
  resolveExpectedDimensions,
  getDimensionsForModel,
} from './embedding-model.util';

/**
 * Single source of truth for all memory_embeddings table writes.
 *
 * Problem solved: multiple scattered raw SQL paths wrote to memory_embeddings
 * (or the legacy memories.embedding column) with hardcoded or unchecked
 * vector dimensions, causing Postgres error 22000 when the configured model
 * dimension (e.g. openai-small=1536) didn't match the column type (vector(768)).
 *
 * All callers must go through writeMemoryEmbedding(). The legacy inline
 * memories.embedding column (vector(768)) is only written when the incoming
 * vector is exactly 768 dims — matching PgVectorProvider's existing guard.
 */
@Injectable()
export class EmbeddingWriteService {
  private readonly logger = new Logger(EmbeddingWriteService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert a memory embedding into memory_embeddings for the given model.
   *
   * Validates that vector.length matches the expected dimensions for modelId.
   * Also writes to the legacy memories.embedding column only when dims === 768.
   *
   * @param memoryId  - the memories.id this embedding belongs to
   * @param modelId   - embedding model identifier (e.g. 'bge-base', 'openai-small')
   * @param vector    - the embedding float array
   * @param skipLegacyInline - set true to skip the memories.embedding column write
   *                           (use when caller already confirmed memory existence)
   */
  async writeMemoryEmbedding(
    memoryId: string,
    modelId: string,
    vector: number[],
    skipLegacyInline = false,
  ): Promise<void> {
    this.validateDimensions(modelId, vector);

    const embeddingStr = this.serializeVector(vector, memoryId);
    const LEGACY_INLINE_DIMS = 768;

    if (!skipLegacyInline) {
      if (vector.length === LEGACY_INLINE_DIMS) {
        // Write to legacy memories.embedding column — confirm memory exists
        const rows = await this.prisma.$queryRawUnsafe<Array<{ exists: number }>>(
          `SELECT 1 AS exists FROM memories WHERE id = $1`,
          memoryId,
        );
        if (rows.length === 0) {
          this.logger.warn(
            `[EmbeddingWrite] Memory ${memoryId} not found — skipping write`,
          );
          return;
        }
        await this.prisma.$executeRawUnsafe(
          `UPDATE memories SET embedding = $1::vector WHERE id = $2`,
          embeddingStr,
          memoryId,
        );
      } else {
        // Non-768 dim: verify memory exists without touching the typed column
        const rows = await this.prisma.$queryRawUnsafe<Array<{ exists: number }>>(
          `SELECT 1 AS exists FROM memories WHERE id = $1`,
          memoryId,
        );
        if (rows.length === 0) {
          this.logger.warn(
            `[EmbeddingWrite] Memory ${memoryId} not found — skipping write`,
          );
          return;
        }
      }
    }

    // Always write to memory_embeddings (the authoritative multi-model store)
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
      DO UPDATE SET embedding = $1::vector, dimensions = $4, updated_at = NOW()
      `,
      embeddingStr,
      memoryId,
      modelId,
      vector.length,
    );
  }

  /**
   * Write only the legacy memories.embedding inline column — for callers that
   * work exclusively with the legacy column (not memory_embeddings).
   *
   * Skips the write (with a warning) when vector.length != 768 to avoid the
   * Postgres 22000 "expected 768 dimensions" error.
   */
  async writeLegacyInlineEmbedding(
    memoryId: string,
    vector: number[],
  ): Promise<void> {
    const LEGACY_INLINE_DIMS = 768;
    if (vector.length !== LEGACY_INLINE_DIMS) {
      this.logger.warn(
        `[EmbeddingWrite] Skipping legacy inline write for ${memoryId}: ` +
          `memories.embedding is vector(768) but got ${vector.length} dims. ` +
          `Use writeMemoryEmbedding() to store in memory_embeddings instead.`,
      );
      return;
    }
    const embeddingStr = this.serializeVector(vector, memoryId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE memories SET embedding = $1::vector WHERE id = $2`,
      embeddingStr,
      memoryId,
    );
  }

  /**
   * Validates vector dimensions against the expected dimensions for the given
   * modelId. Throws a descriptive error on mismatch rather than letting
   * Postgres produce the opaque 22000 error.
   */
  validateDimensions(modelId: string, vector: number[]): void {
    const expected = getDimensionsForModel(modelId);
    if (expected !== undefined && vector.length !== expected) {
      throw new Error(
        `[EmbeddingWrite] Dimension mismatch for model '${modelId}': ` +
          `expected ${expected} dims but got ${vector.length}. ` +
          `Check EMBEDDING_PROVIDER / LOCAL_EMBED_MODEL / EMBEDDING_MODEL alignment.`,
      );
    }
  }

  private serializeVector(vector: number[], context: string): string {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(`[EmbeddingWrite] Empty or invalid vector for ${context}`);
    }
    if (Object.keys(vector).length !== vector.length) {
      throw new Error(
        `[EmbeddingWrite] Sparse array (holes) for ${context} — rejected`,
      );
    }
    for (let i = 0; i < vector.length; i++) {
      if (typeof vector[i] !== 'number' || !Number.isFinite(vector[i])) {
        throw new Error(
          `[EmbeddingWrite] Non-finite value at index ${i} for ${context}`,
        );
      }
    }
    return `[${vector.join(',')}]`;
  }

  /** Convenience: write using the currently configured model ID */
  async writeWithCurrentModel(
    memoryId: string,
    vector: number[],
    skipLegacyInline = false,
  ): Promise<void> {
    const modelId = resolveEmbeddingModelId();
    return this.writeMemoryEmbedding(memoryId, modelId, vector, skipLegacyInline);
  }

  /** Expose current model/dimension config for callers that need it */
  getCurrentModelId(): string {
    return resolveEmbeddingModelId();
  }

  getCurrentExpectedDimensions(): number | undefined {
    return resolveExpectedDimensions();
  }
}
