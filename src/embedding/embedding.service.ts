import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingProvider, EmbedOptions } from './embedding-provider.interface';
import { LocalEmbedProvider } from './local-embed.provider';
import { OpenAIEmbedProvider } from './openai-embed.provider';
import { CloudEnsembleEmbedProvider } from './cloud-ensemble-embed.provider';

/**
 * Embedding Service
 *
 * Facade that delegates to the configured embedding provider.
 * Selected via EMBEDDING_PROVIDER env var (default: 'local').
 *
 * This replaces all scattered direct HTTP embedding calls
 * with a single injection point.
 */
@Injectable()
export class EmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingService.name);
  private provider: EmbeddingProvider;

  constructor(
    private configService: ConfigService,
    private localProvider: LocalEmbedProvider,
    private openaiProvider: OpenAIEmbedProvider,
    private cloudEnsembleProvider: CloudEnsembleEmbedProvider,
  ) {
    const providerName = this.configService.get<string>(
      'EMBEDDING_PROVIDER',
      'local',
    );
    this.provider = this.resolveProvider(providerName);
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(
      `Embedding provider: ${this.provider.name} (model: ${this.provider.getModelName()}, dims: ${this.provider.getDimensions()})`,
    );
  }

  /**
   * Generate embeddings for one or more texts
   */
  async embed(texts: string[]): Promise<number[][]> {
    return this.provider.embed(texts);
  }

  /**
   * Generate embedding for a single text (convenience)
   */
  async embedOne(text: string): Promise<number[]> {
    const results = await this.provider.embed([text]);
    return results[0];
  }

  /**
   * Generate embedding with priority and timeout options.
   * Used by recall path to skip batch queue on engram-embed.
   */
  async embedOneWithOptions(
    text: string,
    options: EmbedOptions,
  ): Promise<number[]> {
    const results = await this.provider.embed([text], options);
    return results[0];
  }

  /**
   * Get the model name of the active provider
   */
  getModelName(): string {
    return this.provider.getModelName();
  }

  /**
   * Get the dimensionality of the active provider
   */
  getDimensions(): number {
    return this.provider.getDimensions();
  }

  /**
   * Check if the active provider is healthy
   */
  async healthCheck(): Promise<boolean> {
    return this.provider.healthCheck();
  }

  /**
   * Get the active provider name
   */
  getProviderName(): string {
    return this.provider.name;
  }

  /**
   * Get the underlying provider instance (for advanced use cases)
   */
  getProvider(): EmbeddingProvider {
    return this.provider;
  }

  private resolveProvider(name: string): EmbeddingProvider {
    switch (name) {
      case 'local':
        return this.localProvider;
      case 'openai':
        return this.openaiProvider;
      case 'cloud-ensemble':
        return this.cloudEnsembleProvider;
      default:
        this.logger.warn(
          `Unknown embedding provider '${name}', falling back to 'local'`,
        );
        return this.localProvider;
    }
  }
}
