import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EmbeddingProvider,
  EmbedOptions,
} from './embedding-provider.interface';

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
  private static readonly INVALID_EMBED_RETRY_ATTEMPTS = 2;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>(
      'LOCAL_EMBED_URL',
      'http://127.0.0.1:8080',
    );
    this.model = this.configService.get<string>(
      'LOCAL_EMBED_MODEL',
      'bge-base-en-v1.5',
    );
    this.dimensions = this.configService.get<number>(
      'LOCAL_EMBED_DIMENSIONS',
      768,
    );
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
    let lastError: Error | null = null;

    for (
      let attempt = 1;
      attempt <= LocalEmbedProvider.INVALID_EMBED_RETRY_ATTEMPTS;
      attempt++
    ) {
      try {
        const response = await fetch(
          `${this.baseUrl}/v1/embeddings`,
          fetchOptions,
        );

        if (!response.ok) {
          const error = await response.text();
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
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error ?? 'unknown'));

        if (
          attempt < LocalEmbedProvider.INVALID_EMBED_RETRY_ATTEMPTS &&
          this.isRetryableInvalidEmbedding(lastError)
        ) {
          this.logger.warn(
            `[LocalEmbed] Invalid embedding payload on attempt ${attempt}; retrying once: ${lastError.message}`,
          );
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new Error('Local embedding request failed');
  }

  private validateEmbedding(value: unknown, index: number): number[] {
    if (!Array.isArray(value)) {
      throw new Error(
        `Invalid embedding payload at index ${index}: expected array`,
      );
    }

    if (value.length === 0) {
      throw new Error(`Invalid embedding payload at index ${index}: empty`);
    }

    const invalidEntries = value.filter(
      (item) => typeof item !== 'number' || !Number.isFinite(item),
    ).length;

    if (invalidEntries > 0) {
      throw new Error(
        `Invalid embedding payload at index ${index}: ${invalidEntries}/${value.length} entries were non-finite`,
      );
    }

    return value as number[];
  }

  private isRetryableInvalidEmbedding(error: Error): boolean {
    return (
      error.message.includes('Invalid embedding payload') ||
      error.message.includes('Invalid response from local embedding server')
    );
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
