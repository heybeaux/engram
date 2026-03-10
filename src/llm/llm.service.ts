import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LLMProvider,
  LLMConfig,
  LLMMessage,
  LLMResponse,
  EmbeddingResponse,
  DEFAULT_MODELS,
} from './llm.interface';
import { OpenAIProvider } from './providers/openai.provider';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OllamaProvider } from './providers/ollama.provider';
import { LMStudioProvider } from './providers/lmstudio.provider';
import { LocalProvider } from './providers/local.provider';
import { EmbeddingService } from '../embedding/embedding.service';

/**
 * LLM Service
 *
 * Manages LLM providers and routes requests to the appropriate one.
 * Supports runtime provider switching and fallbacks.
 */
@Injectable()
export class LLMService {
  private readonly logger = new Logger(LLMService.name);
  private defaultProvider: LLMProvider;
  private embeddingProvider: LLMProvider;
  private providers: Map<string, LLMProvider> = new Map();

  constructor(
    private config: ConfigService,
    @Optional() private embeddingServiceRef?: EmbeddingService,
  ) {
    this.initializeProviders();
  }

  /**
   * Initialize providers from environment config
   */
  private initializeProviders(): void {
    // Default LLM provider for chat/extraction
    const llmProvider = this.config.get<string>('LLM_PROVIDER') || 'openai';
    const llmModel =
      this.config.get<string>('LLM_MODEL') ||
      DEFAULT_MODELS[llmProvider as keyof typeof DEFAULT_MODELS];

    // Embedding provider (might be different from chat provider)
    const embeddingProvider =
      this.config.get<string>('EMBEDDING_PROVIDER') || 'openai';

    // Initialize providers based on config
    const openaiKey = this.config.get<string>('OPENAI_API_KEY');
    const anthropicKey = this.config.get<string>('ANTHROPIC_API_KEY');
    const ollamaUrl = this.config.get<string>('OLLAMA_URL');
    const lmstudioUrl = this.config.get<string>('LMSTUDIO_URL');

    // Create available providers
    if (openaiKey) {
      this.providers.set(
        'openai',
        new OpenAIProvider({
          provider: 'openai',
          model: llmProvider === 'openai' ? llmModel : 'gpt-4o-mini',
          apiKey: openaiKey,
        }),
      );
    }

    if (anthropicKey) {
      this.providers.set(
        'anthropic',
        new AnthropicProvider({
          provider: 'anthropic',
          model:
            llmProvider === 'anthropic'
              ? llmModel
              : 'claude-3-5-sonnet-20241022',
          apiKey: anthropicKey,
        }),
      );
    }

    // Ollama (no API key needed)
    this.providers.set(
      'ollama',
      new OllamaProvider({
        provider: 'ollama',
        model: llmProvider === 'ollama' ? llmModel : 'llama3.2',
        baseUrl: ollamaUrl,
      }),
    );

    // LM Studio (no API key needed)
    this.providers.set(
      'lmstudio',
      new LMStudioProvider({
        provider: 'lmstudio',
        model: llmProvider === 'lmstudio' ? llmModel : 'local-model',
        baseUrl: lmstudioUrl,
      }),
    );

    // Local embedding server (engram-embed, no API key needed)
    const localUrl =
      this.config.get<string>('LOCAL_EMBED_URL') || 'http://127.0.0.1:8080';
    this.providers.set(
      'local',
      new LocalProvider({
        provider: 'local',
        model: 'bge-base-en-v1.5',
        baseUrl: localUrl,
      }),
    );

    // Set default providers
    this.defaultProvider =
      this.providers.get(llmProvider) || this.providers.get('openai')!;
    this.embeddingProvider =
      this.providers.get(embeddingProvider) || this.providers.get('openai')!;

    if (!this.defaultProvider) {
      const nodeEnv = this.config.get<string>('NODE_ENV', 'development');
      if (nodeEnv === 'test') {
        this.logger.warn(
          'No LLM provider configured in test environment — LLM calls will throw at invocation time',
        );
      } else {
        throw new Error(
          `No LLM provider configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or use Ollama/LM Studio.`,
        );
      }
    }
  }

  /**
   * Get a specific provider by name
   */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Generate a chat completion using the default provider
   */
  async chat(
    messages: LLMMessage[],
    options?: { provider?: string } & Partial<LLMConfig>,
  ): Promise<LLMResponse> {
    const provider = options?.provider
      ? this.providers.get(options.provider) || this.defaultProvider
      : this.defaultProvider;

    return provider.chat(messages, options);
  }

  /**
   * Generate a structured JSON response
   */
  async json<T>(
    messages: LLMMessage[],
    schema?: object,
    options?: { provider?: string } & Partial<LLMConfig>,
  ): Promise<T> {
    const provider = options?.provider
      ? this.providers.get(options.provider) || this.defaultProvider
      : this.defaultProvider;

    return provider.json<T>(messages, schema, options);
  }

  /**
   * Generate an embedding
   *
   * Delegates to EmbeddingService when available (preferred path).
   * Falls back to legacy LLM provider embed for backward compatibility.
   */
  async embed(
    text: string,
    options?: { provider?: string },
  ): Promise<EmbeddingResponse> {
    // Prefer EmbeddingService when available and no specific provider requested
    if (this.embeddingServiceRef && !options?.provider) {
      const embedding = await this.embeddingServiceRef.embedOne(text);
      return {
        embedding,
        model: this.embeddingServiceRef.getModelName(),
        dimensions: embedding.length,
      };
    }

    const provider = options?.provider
      ? this.providers.get(options.provider) || this.embeddingProvider
      : this.embeddingProvider;

    if (!provider.supportsEmbeddings()) {
      throw new Error(
        `Provider ${provider.name} does not support embeddings. ` +
          `Configure EMBEDDING_PROVIDER to use openai or ollama.`,
      );
    }

    return provider.embed(text);
  }

  /**
   * List available providers
   */
  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Check which providers support embeddings
   */
  listEmbeddingProviders(): string[] {
    return Array.from(this.providers.entries())
      .filter(([_, provider]) => provider.supportsEmbeddings())
      .map(([name, _]) => name);
  }
}
