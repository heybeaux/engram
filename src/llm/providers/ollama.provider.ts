import {
  LLMProvider,
  LLMConfig,
  LLMMessage,
  LLMResponse,
  EmbeddingResponse,
} from '../llm.interface';

/**
 * Ollama LLM Provider
 * For running local models: Llama 3, Mistral, Phi, etc.
 * Supports embeddings via nomic-embed-text or similar
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';

  private baseUrl: string;
  private defaultModel: string;
  private embeddingModel: string;

  constructor(config: LLMConfig) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.defaultModel = config.model || 'llama3.2';
    this.embeddingModel = 'nomic-embed-text'; // Default embedding model for Ollama
  }

  async chat(
    messages: LLMMessage[],
    options?: Partial<LLMConfig>,
  ): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options?.model || this.defaultModel,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: false,
        options: {
          temperature: options?.temperature ?? 0.7,
          num_predict: options?.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    return {
      content: data.message?.content || '',
      model: data.model,
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
    };
  }

  async json<T>(
    messages: LLMMessage[],
    schema?: object,
    options?: Partial<LLMConfig>,
  ): Promise<T> {
    // Add JSON instruction
    const enhancedMessages = messages.map((m, i) => {
      if (m.role === 'user' && i === messages.length - 1) {
        return {
          ...m,
          content: `${m.content}\n\nRespond with valid JSON only. No markdown, no explanation, no extra text.`,
        };
      }
      return m;
    });

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options?.model || this.defaultModel,
        messages: enhancedMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: false,
        format: 'json', // Ollama native JSON mode
        options: {
          temperature: options?.temperature ?? 0.3,
          num_predict: options?.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const content = data.message?.content || '{}';

    try {
      return JSON.parse(content) as T;
    } catch (e) {
      throw new Error(`Failed to parse JSON response: ${content}`, {
        cause: e,
      });
    }
  }

  async embed(text: string): Promise<EmbeddingResponse> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.embeddingModel,
        prompt: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Ollama Embedding API error: ${response.status} - ${error}`,
      );
    }

    const data = await response.json();

    if (!data.embedding) {
      throw new Error(
        `No embedding returned. Make sure ${this.embeddingModel} is pulled: ollama pull ${this.embeddingModel}`,
      );
    }

    return {
      embedding: data.embedding,
      model: this.embeddingModel,
      dimensions: data.embedding.length,
    };
  }

  supportsEmbeddings(): boolean {
    return true; // With nomic-embed-text or similar
  }
}
