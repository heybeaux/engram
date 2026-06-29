import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EmbeddingProvider,
  EmbedOptions,
} from './embedding-provider.interface';
import { TransientEmbeddingError } from './embedding-validation.util';

/**
 * Local Embedding Provider
 *
 * Wraps engram-embed server (Rust, bge-base-en-v1.5).
 * OpenAI-compatible API on LOCAL_EMBED_URL.
 * 768 dimensions, ~10ms latency, fully local.
 */
@Injectable()
export class LocalEmbedProvider implements EmbeddingProvider {
  readonly name = 'local';
  private readonly logger = new Logger(LocalEmbedProvider.name);
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimensions: number;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>(
      'LOCAL_EMBED_URL',
      'http://127.0.0.1:8080',
    );
    this.model = this.configService.get<string>(
      'LOCAL_EMBED_MODEL',
      'bge-base-en-v1.5',
    );
    const rawDimensions = this.configService.get<number | string>(
      'LOCAL_EMBED_DIMENSIONS',
      768,
    );
    this.dimensions = Number(rawDimensions);
    if (!Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      throw new Error(
        `LOCAL_EMBED_DIMENSIONS must be a positive integer, got ${JSON.stringify(rawDimensions)}`,
      );
    }
  }

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    const input = texts.length === 1 ? texts[0] : texts;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options?.priority) {
      headers['X-Priority'] = options.priority;
    }

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({ input, model: this.model }),
    };

    if (options?.timeoutMs) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      fetchOptions.signal = controller.signal;
      try {
        return await this.doFetch(fetchOptions);
      } finally {
        clearTimeout(timeout);
      }
    }

    return this.doFetch(fetchOptions);
  }

  private async doFetch(fetchOptions: RequestInit): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, fetchOptions);

    if (!response.ok) {
      const error = await response.text();
      // Ingest M2 fix: 503 is a transient backlog signal from engram-embed, not
      // a hard failure. Throw TransientEmbeddingError so the circuit breaker
      // does NOT count it toward consecutive-failure thresholds.
      if (response.status === 503) {
        throw new TransientEmbeddingError(
          `Local embedding service backlog (503): ${error}`,
        );
      }
      throw new Error(
        `Local embedding API error: ${response.status} - ${error}`,
      );
    }

    const data = await response.json();

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid response from local embedding server');
    }

    return data.data.map((item: any, index: number) =>
      this.validateEmbedding(item?.embedding, index),
    );
  }

  private validateEmbedding(embedding: unknown, index: number): number[] {
    if (!Array.isArray(embedding)) {
      throw new Error(
        `Invalid embedding at index ${index}: expected array from local embedding server`,
      );
    }

    if (embedding.length !== this.dimensions) {
      throw new Error(
        `Invalid embedding at index ${index}: expected ${this.dimensions} dimensions, got ${embedding.length}`,
      );
    }

    if (
      embedding.some(
        (value) => typeof value !== 'number' || !Number.isFinite(value),
      )
    ) {
      throw new Error(
        `Invalid embedding at index ${index}: contains non-finite values`,
      );
    }

    return embedding;
  }

  getModelName(): string {
    return this.model;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      // Increased from 5s → 30s: engram-embed /health can be delayed when
      // the embed queue is busy (CPU-bound inference on same Tokio threads).
      // The real fix is spawn_blocking in engram-embed, but this prevents
      // false "down" reports in the meantime.
      const timeout = setTimeout(() => controller.abort(), 30_000);

      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      }).catch(() =>
        fetch(`${this.baseUrl}/v1/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: 'health check', model: this.model }),
          signal: controller.signal,
        }),
      );

      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }
}
