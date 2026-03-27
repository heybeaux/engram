/**
 * Embedding Provider Interface
 *
 * Abstracts embedding generation behind a clean provider pattern.
 * Implementations: local (engram-embed), OpenAI, Cohere, etc.
 */
export const EMBEDDING_PROVIDER_TOKEN = 'EMBEDDING_PROVIDER';

export interface EmbedOptions {
  /** Priority level — 'recall' skips batch queue on engram-embed */
  priority?: 'recall' | 'batch';
  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

export interface EmbeddingProvider {
  /** Provider identifier */
  readonly name: string;

  /**
   * Generate embeddings for one or more texts.
   * Returns one embedding vector per input text.
   */
  embed(texts: string[], options?: EmbedOptions): Promise<number[][]>;

  /** Model name used for embeddings */
  getModelName(): string;

  /** Dimensionality of the embedding vectors */
  getDimensions(): number;

  /** Check if the provider is reachable and operational */
  healthCheck(): Promise<boolean>;
}
