import { Injectable, Logger } from '@nestjs/common';
import { MemoryLayer } from '@prisma/client';
import { LLMService } from '../llm/llm.service';
import { VectorService } from '../vector/vector.service';

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

  constructor(
    private llm: LLMService,
    private vector: VectorService,
  ) {}

  /**
   * Generate embedding for text using configured LLM provider.
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
      const result = await this.llm.embed(text);
      this.dimensions = result.dimensions;
      // Reset on success
      if (this.consecutiveFailures > 0) {
        this.logger.log(
          `[CircuitBreaker] Recovered after ${this.consecutiveFailures} failures`,
        );
      }
      this.consecutiveFailures = 0;
      return result.embedding;
    } catch (error) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.FAILURE_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + this.COOLDOWN_MS;
        this.logger.warn(
          `[CircuitBreaker] OPEN — ${this.consecutiveFailures} consecutive embedding failures. ` +
            `Cooldown until ${new Date(this.circuitOpenUntil).toISOString()}`,
        );
      }
      throw error;
    }
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
  ): Promise<VectorSearchResult[]> {
    return this.vector.search(queryEmbedding, {
      userId,
      limit,
      filter: {
        layers: layers?.map((l) => l.toString()),
        projectId,
        poolIds,
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
