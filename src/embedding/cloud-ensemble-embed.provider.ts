import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingProvider } from './embedding-provider.interface';
import { CloudEnsembleService } from './cloud-ensemble.service';

/**
 * Cloud Ensemble Embedding Provider
 *
 * Adapter that wraps CloudEnsembleService to implement the EmbeddingProvider
 * interface. Uses the primary model (openai-small) for single-vector operations
 * like memory creation and search.
 *
 * When EMBEDDING_PROVIDER=cloud-ensemble, this is selected as the active provider
 * in EmbeddingService, enabling cloud-based embeddings without a local embed server.
 */
@Injectable()
export class CloudEnsembleEmbedProvider implements EmbeddingProvider {
  readonly name = 'cloud-ensemble';
  private readonly logger = new Logger(CloudEnsembleEmbedProvider.name);
  private readonly primaryModel = 'openai-small';

  constructor(private readonly cloudEnsemble: CloudEnsembleService) {}

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (const text of texts) {
      // Use embedSingle for efficiency — only hits the primary model
      const result = await this.cloudEnsemble.embedSingle(
        text,
        this.primaryModel,
        'document',
      );
      results.push(result.embedding);
    }

    return results;
  }

  getModelName(): string {
    return `cloud-ensemble (${this.primaryModel})`;
  }

  getDimensions(): number {
    return 1536; // openai-small dimensions
  }

  async healthCheck(): Promise<boolean> {
    // If not yet initialized (e.g. first request race), try initializing now
    if (!this.cloudEnsemble.isAvailable()) {
      this.logger.warn(
        'CloudEnsembleService not available — attempting lazy initialize',
      );
      await this.cloudEnsemble.initialize();
    }

    if (!this.cloudEnsemble.isAvailable()) {
      this.logger.error(
        'CloudEnsembleService unavailable after initialize — check OPENAI_API_KEY',
      );
      return false;
    }

    try {
      const response = await this.cloudEnsemble.embedAll(
        'health check',
        'document',
      );
      if (response.embeddings.length === 0) {
        const errs = response.errors?.map((e) => `${e.model}: ${e.error}`).join(', ');
        this.logger.error(
          `Health check: all models failed — ${errs ?? 'unknown error'}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`Health check failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
}
