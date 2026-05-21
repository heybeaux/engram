import {
  LLMProvider,
  LLMConfig,
  LLMMessage,
  LLMResponse,
  EmbeddingResponse,
} from '../llm.interface';

/**
 * Anthropic LLM Provider
 * Supports: Claude 3.5 Sonnet, Claude 3 Opus, Claude 3 Haiku
 * Note: Anthropic doesn't provide embeddings — use OpenAI or local for that
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: LLMConfig) {
    if (!config.apiKey) {
      throw new Error('Anthropic provider requires an API key');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.defaultModel = config.model || 'claude-3-5-sonnet-20241022';
  }

  async chat(
    messages: LLMMessage[],
    options?: Partial<LLMConfig>,
  ): Promise<LLMResponse> {
    // Anthropic uses a different message format
    // System message must be separate
    const systemMessage = messages.find((m) => m.role === 'system');
    const chatMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options?.model || this.defaultModel,
        max_tokens: options?.maxTokens || 4096,
        system: systemMessage?.content,
        messages: chatMessages,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    return {
      content: data.content[0]?.text || '',
      model: data.model,
      usage: {
        promptTokens: data.usage?.input_tokens || 0,
        completionTokens: data.usage?.output_tokens || 0,
        totalTokens:
          (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
    };
  }

  async json<T>(
    messages: LLMMessage[],
    schema?: object,
    options?: Partial<LLMConfig>,
  ): Promise<T> {
    // Add JSON instruction to the last user message
    const enhancedMessages = messages.map((m, i) => {
      if (m.role === 'user' && i === messages.length - 1) {
        return {
          ...m,
          content: `${m.content}\n\nRespond with valid JSON only. No markdown, no explanation.`,
        };
      }
      return m;
    });

    const response = await this.chat(enhancedMessages, options);

    try {
      // Try to extract JSON from response (Claude sometimes wraps in markdown)
      let content = response.content;
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
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
    throw new Error(
      'Anthropic does not provide embeddings. Use OpenAI or a local embedding model.',
    );
  }

  supportsEmbeddings(): boolean {
    return false;
  }
}
