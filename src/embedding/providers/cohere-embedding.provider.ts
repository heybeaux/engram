import { CohereClient } from 'cohere-ai';
import { EmbeddingProvider } from '../embedding-provider.interface';

/**
 * Cohere Cloud Embedding Provider
 *
 * Uses embed-english-v3.0 (1024d) with input_type differentiation:
 * - search_document for indexing
 * - search_query for queries
 */
export class CohereEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'cohere-v3';
  private readonly client: CohereClient;
  private readonly model = 'embed-english-v3.0';
  private readonly dimensions = 1024;
  private inputType: 'search_document' | 'search_query' = 'search_document';

  constructor(apiKey: string) {
    this.client = new CohereClient({ token: apiKey });
  }

  /**
   * Set input type before embedding. Call setInputType('search_query')
   * for query embeddings, 'search_document' for indexing.
   */
  setInputType(type: 'search_document' | 'search_query'): void {
    this.inputType = type;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Cohere API limits to 96 texts per request
    const MAX_BATCH = 96;
    if (texts.length <= MAX_BATCH) {
      return this.embedBatch(texts);
    }

    const allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const chunk = texts.slice(i, i + MAX_BATCH);
      const chunkEmbeddings = await this.embedBatch(chunk);
      allEmbeddings.push(...chunkEmbeddings);
    }
    return allEmbeddings;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embed({
      texts,
      model: this.model,
      inputType: this.inputType,
      embeddingTypes: ['float'],
    });

    const embeddings = (response.embeddings as any)?.float;
    if (!embeddings) {
      throw new Error('No float embeddings in Cohere response');
    }

    return embeddings;
  }

  getModelName(): string {
    return this.model;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.embed(['health check']);
      return result.length > 0 && result[0].length > 0;
    } catch {
      return false;
    }
  }
}
