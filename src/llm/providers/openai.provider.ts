import {
  LLMProvider,
  LLMConfig,
  LLMMessage,
  LLMResponse,
  EmbeddingResponse,
  DEFAULT_EMBEDDING_MODELS,
} from '../llm.interface';

/**
 * OpenAI LLM Provider
 * Supports: GPT-4, GPT-4o, GPT-4o-mini, GPT-3.5-turbo
 * Embeddings: text-embedding-3-small, text-embedding-3-large
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: LLMConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAI provider requires an API key');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.defaultModel = config.model || 'gpt-4o-mini';
  }

  async chat(
    messages: LLMMessage[],
    options?: Partial<LLMConfig>,
  ): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model || this.defaultModel,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    return {
      content: data.choices[0]?.message?.content || '',
      model: data.model,
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      },
    };
  }

  async json<T>(
    messages: LLMMessage[],
    schema?: object,
    options?: Partial<LLMConfig>,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model || this.defaultModel,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: options?.temperature ?? 0.3, // Lower for structured output
        max_tokens: options?.maxTokens,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content || '{}';

    try {
      return JSON.parse(content) as T;
    } catch (e) {
      throw new Error(`Failed to parse JSON response: ${content}`, {
        cause: e,
      });
    }
  }

  async embed(text: string): Promise<EmbeddingResponse> {
    const model = DEFAULT_EMBEDDING_MODELS.openai;

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `OpenAI Embedding API error: ${response.status} - ${error}`,
      );
    }

    const data = await response.json();
    const embedding = data.data[0]?.embedding;

    if (!embedding) {
      throw new Error('No embedding returned from OpenAI');
    }

    return {
      embedding,
      model: data.model,
      dimensions: embedding.length,
    };
  }

  supportsEmbeddings(): boolean {
    return true;
  }
}
