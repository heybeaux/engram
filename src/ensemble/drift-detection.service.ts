/**
 * Drift Detection Service
 *
 * Detects embedding drift between old and new embeddings.
 * Uses pgvector to fetch existing embeddings for comparison.
 * High drift may indicate model changes or content issues.
 */

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { ModelId, DriftAnalysis, DriftSummary } from './ensemble.types';

@Injectable()
export class DriftDetectionService {
  private readonly logger = new Logger(DriftDetectionService.name);

  // Thresholds for drift detection
  private readonly DRIFT_THRESHOLD: number;
  private readonly ALERT_THRESHOLD: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: ServicePrismaService,
  ) {
    this.DRIFT_THRESHOLD = this.config.get<number>(
      'ENSEMBLE_DRIFT_THRESHOLD',
      0.15,
    );
    this.ALERT_THRESHOLD = this.config.get<number>(
      'ENSEMBLE_DRIFT_ALERT',
      0.25,
    );
  }

  /**
   * Measure drift between old and new embedding for a single memory
   */
  async measureDrift(
    memoryId: string,
    oldEmbedding: number[] | null,
    newEmbedding: number[],
    model: ModelId,
    oldVersion?: string,
  ): Promise<DriftAnalysis> {
    // If no old embedding, can't measure drift
    if (!oldEmbedding || oldEmbedding.length === 0) {
      return {
        memoryId,
        model,
        cosineDrift: 0,
        oldEmbeddingVersion: oldVersion || 'none',
        newEmbeddingVersion: 'current',
        flagged: false,
      };
    }

    const cosineDrift = this.cosineDistance(oldEmbedding, newEmbedding);
    const flagged = cosineDrift > this.DRIFT_THRESHOLD;

    // Alert on high drift
    if (cosineDrift > this.ALERT_THRESHOLD) {
      this.logger.warn(
        `High embedding drift detected: memory=${memoryId}, model=${model}, drift=${cosineDrift.toFixed(4)}`,
      );
    }

    return {
      memoryId,
      model,
      cosineDrift,
      oldEmbeddingVersion: oldVersion || 'previous',
      newEmbeddingVersion: 'current',
      flagged,
    };
  }

  /**
   * Measure drift for a batch of memories
   * Fetches existing embeddings from pgvector for comparison
   */
  async measureBatchDrift(
    memories: Array<{ id: string; raw: string }>,
    newEmbeddings: number[][],
    model: ModelId,
  ): Promise<DriftAnalysis[]> {
    // Fetch existing embeddings for these memories
    const memoryIds = memories.map((m) => m.id);
    const existingEmbeddings = await this.fetchExistingEmbeddings(
      memoryIds,
      model,
    );

    const analyses: DriftAnalysis[] = [];

    for (let i = 0; i < memories.length; i++) {
      const memory = memories[i];
      const newEmbedding = newEmbeddings[i];
      const oldEmbedding = existingEmbeddings.get(memory.id);

      if (!newEmbedding) {
        // No new embedding, skip
        continue;
      }

      if (!oldEmbedding) {
        // No old embedding, no drift to measure
        analyses.push({
          memoryId: memory.id,
          model,
          cosineDrift: 0,
          oldEmbeddingVersion: 'none',
          newEmbeddingVersion: 'current',
          flagged: false,
        });
        continue;
      }

      const cosineDrift = this.cosineDistance(oldEmbedding, newEmbedding);
      const flagged = cosineDrift > this.DRIFT_THRESHOLD;

      if (cosineDrift > this.ALERT_THRESHOLD) {
        this.logger.warn(
          `High embedding drift: memory=${memory.id}, model=${model}, drift=${cosineDrift.toFixed(4)}`,
        );
      }

      analyses.push({
        memoryId: memory.id,
        model,
        cosineDrift,
        oldEmbeddingVersion: 'previous',
        newEmbeddingVersion: 'current',
        flagged,
      });
    }

    return analyses;
  }

  /**
   * Fetch existing embeddings from pgvector for a batch of memories
   */
  private async fetchExistingEmbeddings(
    memoryIds: string[],
    model: ModelId,
  ): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();

    if (memoryIds.length === 0) {
      return result;
    }

    try {
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{ memory_id: string; embedding: string }>
      >(
        `
        SELECT memory_id, embedding::text
        FROM memory_embeddings
        WHERE memory_id = ANY($1) 
          AND model_id = $2 
          AND embedding IS NOT NULL
        `,
        memoryIds,
        model,
      );

      for (const row of rows) {
        if (row.embedding) {
          // Parse vector string "[1.0,2.0,3.0]" to number array
          const nums = row.embedding.slice(1, -1).split(',').map(Number);
          result.set(row.memory_id, nums);
        }
      }
    } catch (error) {
      this.logger.error(
        'Failed to fetch existing embeddings for drift detection',
        error,
      );
    }

    return result;
  }

  /**
   * Summarize drift across a batch of analyses
   */
  summarizeDrift(analyses: DriftAnalysis[]): DriftSummary {
    if (analyses.length === 0) {
      return {
        measured: false,
        avgCosineDrift: 0,
        maxCosineDrift: 0,
        memoriesWithHighDrift: 0,
        driftThreshold: this.DRIFT_THRESHOLD,
        byModel: {} as Record<
          ModelId,
          { avg: number; max: number; flagged: number }
        >,
      };
    }

    const drifts = analyses.map((a) => a.cosineDrift);
    const avgDrift = this.average(drifts);
    const maxDrift = Math.max(...drifts);
    const flaggedCount = analyses.filter((a) => a.flagged).length;

    // Group by model
    const byModel = {} as Record<
      ModelId,
      { avg: number; max: number; flagged: number }
    >;
    const models = new Set(analyses.map((a) => a.model));

    for (const model of models) {
      const modelAnalyses = analyses.filter((a) => a.model === model);
      const modelDrifts = modelAnalyses.map((a) => a.cosineDrift);

      byModel[model] = {
        avg: this.average(modelDrifts),
        max: Math.max(...modelDrifts),
        flagged: modelAnalyses.filter((a) => a.flagged).length,
      };
    }

    return {
      measured: true,
      avgCosineDrift: avgDrift,
      maxCosineDrift: maxDrift,
      memoriesWithHighDrift: flaggedCount,
      driftThreshold: this.DRIFT_THRESHOLD,
      byModel,
    };
  }

  /**
   * Check if drift exceeds alert threshold
   */
  shouldAlert(drift: number): boolean {
    return drift > this.ALERT_THRESHOLD;
  }

  /**
   * Check if drift exceeds warning threshold
   */
  isHighDrift(drift: number): boolean {
    return drift > this.DRIFT_THRESHOLD;
  }

  /**
   * Get current thresholds
   */
  getThresholds(): { drift: number; alert: number } {
    return {
      drift: this.DRIFT_THRESHOLD,
      alert: this.ALERT_THRESHOLD,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Calculate cosine distance between two vectors
   * Distance = 1 - similarity, so 0 = identical, 2 = opposite
   */
  private cosineDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 1; // Treat zero vectors as maximally different
    }

    const similarity = dotProduct / (normA * normB);
    return 1 - similarity;
  }

  /**
   * Calculate average of numbers
   */
  private average(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }
}
