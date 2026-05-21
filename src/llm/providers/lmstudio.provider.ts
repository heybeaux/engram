import {
  LLMProvider,
  LLMConfig,
  LLMMessage,
  LLMResponse,
  EmbeddingResponse,
} from '../llm.interface';

/**
 * LM Studio LLM Provider
 * LM Studio exposes an OpenAI-compatible API at localhost:1234
 * For running local models with a GUI
 */
export class LMStudioProvider implements LLMProvider {
  readonly name = 'lmstudio';

  private baseUrl: string;
  private defaultModel: string;

  constructor(config: LLMConfig) {
    this.baseUrl = config.baseUrl || 'http://localhost:1234/v1';
    this.defaultModel = config.model || 'local-model';
  }

  async chat(
    messages: LLMMessage[],
    options?: Partial<LLMConfig>,
  ): Promise<LLMResponse> {
    // LM Studio uses OpenAI-compatible API
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options?.model || this.defaultModel,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens || 4096,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LM Studio API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    return {
      content: data.choices[0]?.message?.content || '',
      model: data.model || this.defaultModel,
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
    // Add JSON instruction to last user message
    const enhancedMessages = messages.map((m, i) => {
      if (m.role === 'user' && i === messages.length - 1) {
        return {
          ...m,
          content: `${m.content}\n\nRespond with valid JSON only. No markdown code blocks, no explanation.`,
        };
      }
      return m;
    });

    const response = await this.chat(enhancedMessages, {
      ...options,
      temperature: options?.temperature ?? 0.3,
    });

    try {
      // Try to extract JSON from response
      let content = response.content.trim();

      // Handle markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        content = jsonMatch[1];
      }

      return JSON.parse(content) as T;
    } catch (e) {
      throw new Error(`Failed to parse JSON response: ${response.content}`, {
        cause: e,
      });
    }
  }

  async embed(text: string): Promise<EmbeddingResponse> {
    // LM Studio supports embeddings if an embedding model is loaded
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.defaultModel,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `LM Studio Embedding API error: ${response.status} - ${error}. ` +
          'Make sure an embedding model is loaded in LM Studio.',
      );
    }

    const data = await response.json();
    const embedding = data.data?.[0]?.embedding;

    if (!embedding) {
      throw new Error(
        'No embedding returned. Load an embedding model in LM Studio.',
      );
    }

    return {
      embedding,
      model: data.model || this.defaultModel,
      dimensions: embedding.length,
    };
  }

  supportsEmbeddings(): boolean {
    return true; // If an embedding model is loaded
  }
}
