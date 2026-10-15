import { withLocalEmbeddingSlot } from '../../embedding/local-embedding-limiter';
import {
  LLMProvider,
  LLMConfig,
  LLMMessage,
  LLMResponse,
  EmbeddingResponse,
} from '../llm.interface';

/**
 * Local Embedding Provider
 *
 * Uses engram-embed server (Rust, bge-base-en-v1.5)
 * OpenAI-compatible API on http://127.0.0.1:8080
 * 768 dimensions, ~10ms latency, fully local
 */
export class LocalProvider implements LLMProvider {
  readonly name = 'local';

  private baseUrl: string;
  private embeddingModel: string;

  constructor(config: LLMConfig) {
    this.baseUrl = config.baseUrl || 'http://127.0.0.1:8080';
    this.embeddingModel = config.model || 'bge-base-en-v1.5';
  }

  async chat(
    messages: LLMMessage[],
    options?: Partial<LLMConfig>,
  ): Promise<LLMResponse> {
    // Local provider doesn't support chat - use Ollama or LM Studio for that
    throw new Error(
      'Local embedding provider does not support chat. ' +
        'Use ollama, lmstudio, openai, or anthropic for chat.',
    );
  }

  async json<T>(
    messages: LLMMessage[],
    schema?: object,
    options?: Partial<LLMConfig>,
  ): Promise<T> {
    throw new Error(
      'Local embedding provider does not support JSON generation. ' +
        'Use ollama, lmstudio, openai, or anthropic for chat.',
    );
  }

  async embed(text: string): Promise<EmbeddingResponse> {
    return withLocalEmbeddingSlot(() => this.embedAdmitted(text));
  }

  private async embedAdmitted(text: string): Promise<EmbeddingResponse> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        model: this.embeddingModel,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Local embedding API error: ${response.status} - ${error}`,
      );
    }

    const data = await response.json();
    const embedding = data.data?.[0]?.embedding;

    if (!embedding) {
      throw new Error('No embedding returned from local endpoint');
    }

    return {
      embedding,
      model: data.model || this.embeddingModel,
      dimensions: embedding.length,
    };
  }

  /**
   * Batch embed multiple texts in a single request
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResponse[]> {
    return withLocalEmbeddingSlot(() => this.embedBatchAdmitted(texts));
  }

  private async embedBatchAdmitted(
    texts: string[],
  ): Promise<EmbeddingResponse[]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: texts,
        model: this.embeddingModel,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Local embedding API error: ${response.status} - ${error}`,
      );
    }

    const data = await response.json();

    return data.data.map((item: any) => ({
      embedding: item.embedding,
      model: data.model || this.embeddingModel,
      dimensions: item.embedding.length,
    }));
  }

  supportsEmbeddings(): boolean {
    return true;
  }
}
