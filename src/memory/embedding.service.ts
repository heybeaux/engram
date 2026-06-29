import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { MemoryLayer } from '@prisma/client';
import { LLMService } from '../llm/llm.service';
import { VectorService } from '../vector/vector.service';
import { EmbeddingService as EmbedFacade } from '../embedding/embedding.service';
import {
  assertValidEmbedding,
  isTransientEmbeddingError,
} from '../embedding/embedding-validation.util';

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata?: Record<string, any>;
}

/**
 * Handles embedding generation and vector storage
 * Uses LLM service for embedding generation
 * Uses Vector service for storage (pgvector or Pinecone)
 */
@Injectable()
export class EmbeddingService {
  private dimensions: number = 1536; // Default for OpenAI text-embedding-3-small

  // HEY-365: Circuit breaker — after N consecutive failures, skip embedding
  // for a cooldown period and queue for retry
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private readonly FAILURE_THRESHOLD = 5;
  private readonly COOLDOWN_MS = 60_000; // 1 minute cooldown
  private readonly logger = new Logger(EmbeddingService.name);

  private static readonly RECALL_TIMEOUT_MS = 5_000;

  constructor(
    private llm: LLMService,
    private vector: VectorService,
    @Optional() @Inject(EmbedFacade) private embedFacade?: EmbedFacade,
  ) {}

  /**
   * Generate embedding for text using the configured embedding provider.
   * Prefers the EmbedFacade (embedding/embedding.service.ts) directly so
   * write-path model selection is identical to the recall path.  The legacy
   * LLMService.embed() path is kept as a last-resort fallback: its
   * LocalProvider hardcodes 'bge-base-en-v1.5' regardless of LOCAL_EMBED_MODEL,
   * so letting it run first causes 384-dim minilm vectors to be written under
   * the wrong model slot when the server is loaded with minilm.
   *
   * Includes circuit breaker: after FAILURE_THRESHOLD consecutive failures,
   * rejects immediately for COOLDOWN_MS to avoid hammering a down service.
   */
  async generate(text: string): Promise<number[]> {
    // Circuit breaker: check if open
    if (this.consecutiveFailures >= this.FAILURE_THRESHOLD) {
      if (Date.now() < this.circuitOpenUntil) {
        throw new Error(
          `Embedding circuit breaker open (${this.consecutiveFailures} consecutive failures). ` +
            `Retry after ${new Date(this.circuitOpenUntil).toISOString()}`,
        );
      }
      // Cooldown expired — allow a probe request
      this.logger.log('[CircuitBreaker] Cooldown expired, probing...');
    }

    try {
      let embedding: number[];

      // Write path: prefer EmbedFacade (same provider selection as recall path)
      // to guarantee write and recall embeddings come from the same model.
      if (this.embedFacade) {
        embedding = await this.embedFacade.embedOne(text);
      } else {
        // Fallback: LLMService.embed() — model may diverge from recall path
        // if EMBEDDING_PROVIDER is not registered in LLMService's provider map.
        const result = await this.llm.embed(text);
        embedding = result.embedding;
      }

      this.dimensions = embedding.length;
      // Reset on success
      if (this.consecutiveFailures > 0) {
        this.logger.log(
          `[CircuitBreaker] Recovered after ${this.consecutiveFailures} failures`,
        );
      }
      this.consecutiveFailures = 0;
      return embedding;
    } catch (error) {
      // Ingest M2 fix: transient errors (e.g. engram-embed 503 backlog) must
      // NOT count toward the circuit-breaker threshold — they are expected
      // under burst load and will self-heal once the queue drains.
      if (!isTransientEmbeddingError(error)) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.FAILURE_THRESHOLD) {
          this.circuitOpenUntil = Date.now() + this.COOLDOWN_MS;
          this.logger.warn(
            `[CircuitBreaker] OPEN — ${this.consecutiveFailures} consecutive embedding failures. ` +
              `Cooldown until ${new Date(this.circuitOpenUntil).toISOString()}`,
          );
        }
      }
      throw error;
    }
  }

  /**
   * Generate embedding for a recall query with priority flag and shorter timeout.
   * Sends X-Priority: recall to engram-embed so the request skips the batch queue.
   * Falls back to standard generate() if the facade is unavailable.
   */
  async generateForRecall(text: string): Promise<number[]> {
    if (this.embedFacade) {
      try {
        const embedding = await this.embedFacade.embedOneWithOptions(text, {
          priority: 'recall',
          timeoutMs: EmbeddingService.RECALL_TIMEOUT_MS,
        });
        this.dimensions = embedding.length;
        // Reset circuit breaker on success (recall proves service is up)
        if (this.consecutiveFailures > 0) {
          this.logger.log(
            `[CircuitBreaker] Recovered via recall after ${this.consecutiveFailures} failures`,
          );
        }
        this.consecutiveFailures = 0;
        return embedding;
      } catch (error) {
        this.logger.warn(
          `[Recall] Priority embed failed, falling back to standard: ${(error as Error).message}`,
        );
      }
    }
    return this.generate(text);
  }

  /**
   * Store embedding in vector database
   */
  async store(
    memoryId: string,
    embedding: number[],
    metadata?: {
      userId?: string;
      layer?: MemoryLayer;
      projectId?: string;
      importance?: number;
      createdAt?: Date;
    },
  ): Promise<string> {
    assertValidEmbedding(embedding, { context: `store ${memoryId}` });
    await this.vector.upsert({
      id: memoryId,
      embedding,
      metadata: {
        userId: metadata?.userId || '',
        layer: metadata?.layer || MemoryLayer.SESSION,
        projectId: metadata?.projectId || '',
        importance: metadata?.importance || 0.5,
        createdAt:
          metadata?.createdAt?.toISOString() || new Date().toISOString(),
      },
    });

    return memoryId;
  }

  /**
   * Search for similar embeddings
   */
  async search(
    userId: string | string[],
    queryEmbedding: number[],
    limit: number = 10,
    layers?: MemoryLayer[],
    projectId?: string,
    poolIds?: string[],
    queryText?: string,
    tags?: string[],
    metadata?: Record<string, any>,
  ): Promise<VectorSearchResult[]> {
    return this.vector.search(queryEmbedding, {
      userId,
      limit,
      filter: {
        layers: layers?.map((l) => l.toString()),
        projectId,
        poolIds,
        tags,
        metadata,
      },
      _queryText: queryText,
    });
  }

  /**
   * Delete embedding
   */
  async delete(memoryId: string): Promise<void> {
    await this.vector.delete(memoryId);
  }

  /**
   * Delete all embeddings for a user
   */
  async deleteAllForUser(userId: string): Promise<void> {
    await this.vector.deleteByUser(userId);
  }

  /**
   * Get embedding dimensions
   */
  getDimensions(): number {
    return this.dimensions;
  }

  /**
   * Get current vector provider name
   */
  getProviderName(): string {
    return this.vector.getProviderName();
  }
}
