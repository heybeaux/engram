import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { toValidatedVectorLiteral } from '../memory/vector-literal.util';

export type PerModelId =
  | 'openai-small'
  | 'bge-base'
  | 'minilm'
  | 'nomic'; // quarantined

export interface EmbeddingRow {
  memoryId: string;
  modelVersion: string;
  score?: number;
}

@Injectable()
export class EmbeddingRouterService {
  private readonly logger = new Logger(EmbeddingRouterService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert a vector into the correct per-model table.
   * Vectors are written via raw SQL because Prisma cannot assign Unsupported fields.
   */
  async writeEmbedding(
    memoryId: string,
    model: PerModelId,
    vector: number[],
    modelVersion?: string,
  ): Promise<void> {
    const table = this.tableFor(model);
    const version = modelVersion ?? model;
    const id = randomUUID();
    const vectorLiteral = toValidatedVectorLiteral(
      vector,
      `EmbeddingRouterService.writeEmbedding ${model}/${memoryId}`,
    );

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO "${table}" (id, memory_id, model_version, embedding)
      VALUES ($1, $2, $3, $4::vector)
      ON CONFLICT (memory_id)
      DO UPDATE SET
        model_version = EXCLUDED.model_version,
        embedding     = EXCLUDED.embedding
      `,
      id,
      memoryId,
      version,
      vectorLiteral,
    );
  }

  /**
   * ANN search against a single model's table.
   * Returns up to k results ordered by cosine similarity (highest first).
   */
  async queryByModel(
    model: PerModelId,
    queryVector: number[],
    k: number,
  ): Promise<EmbeddingRow[]> {
    const table = this.tableFor(model);
    const vec = toValidatedVectorLiteral(
      queryVector,
      `EmbeddingRouterService.queryByModel ${model}`,
    );

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ memory_id: string; model_version: string; score: number }>
    >(
      `
      SELECT
        memory_id,
        model_version,
        1 - (embedding <=> $1::vector) AS score
      FROM "${table}"
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2
      `,
      vec,
      k,
    );

    return rows.map((r) => ({
      memoryId: r.memory_id,
      modelVersion: r.model_version,
      score: r.score,
    }));
  }

  /**
   * UNION ALL search across multiple models.
   * Scores from each model are normalised to [0,1] within their own result set
   * before merging, then results are deduplicated by memoryId keeping max score.
   *
   * NOTE: normalisation is min-max per model; a proper cross-model calibration
   * layer (e.g. learned sigmoid) should replace this in v2.
   */
  async queryUnion(
    models: PerModelId[],
    queryVector: number[],
    k: number,
  ): Promise<EmbeddingRow[]> {
    if (models.length === 0) return [];

    const perModelK = k * 2; // fetch extra per model so union has headroom
    const resultsPerModel = await Promise.all(
      models.map((m) => this.queryByModel(m, queryVector, perModelK)),
    );

    // Normalize each model's scores to [0,1] and merge
    const merged = new Map<string, EmbeddingRow>();

    for (const rows of resultsPerModel) {
      if (rows.length === 0) continue;

      const scores = rows.map((r) => r.score ?? 0);
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const range = max - min || 1; // avoid div-by-zero on ties

      for (const row of rows) {
        const normalised = ((row.score ?? 0) - min) / range;
        const existing = merged.get(row.memoryId);
        if (!existing || normalised > (existing.score ?? 0)) {
          merged.set(row.memoryId, { ...row, score: normalised });
        }
      }
    }

    return [...merged.values()]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, k);
  }

  private tableFor(model: PerModelId): string {
    switch (model) {
      case 'openai-small':
        return 'embedding_openai_small';
      case 'bge-base':
        return 'embedding_bge_base';
      case 'minilm':
        return 'embedding_minilm';
      case 'nomic':
        return 'embedding_nomic';
    }
  }
}
