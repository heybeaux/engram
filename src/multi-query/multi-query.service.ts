import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryLayer } from '@prisma/client';
import {
  EmbeddingService,
  VectorSearchResult,
} from '../memory/embedding.service';
import {
  QueryExpansionService,
  QueryExpansionResult,
} from './query-expansion.service';
import {
  ResultFusionService,
  FusedResult,
  QuerySearchResult,
} from './result-fusion.service';
import {
  MultiQueryOptionsDto,
  FusionStrategy,
  ExpansionStrategy,
  MultiQueryMetadataDto,
  MultiQueryTimingsDto,
  ResultExplanationDto,
} from './dto/multi-query.dto';

/**
 * Multi-query search configuration
 */
export interface MultiQueryConfig {
  enabled: boolean;
  expansion: {
    strategy: ExpansionStrategy;
    maxVariants: number;
    llm: {
      enabled: boolean;
      fallbackOnly: boolean;
      timeoutMs: number;
    };
  };
  search: {
    topKPerQuery: number;
    maxConcurrency: number;
    timeoutMs: number;
  };
  fusion: {
    strategy: FusionStrategy;
    rrfK: number;
    weights: {
      original: number;
      rules: number;
      llm: number;
    };
    minQueryMatches: number;
  };
  latency: {
    targetMs: number;
    maxMs: number;
    degradeGracefully: boolean;
  };
}

/**
 * Multi-query search result
 */
export interface MultiQuerySearchResult {
  results: FusedResult[];
  expansion: QueryExpansionResult;
  metrics: MultiQueryTimingsDto;
  degraded: boolean;
}

/**
 * Presets for common use cases
 */
const PRESETS: Record<string, Partial<MultiQueryConfig>> = {
  fast: {
    expansion: {
      strategy: ExpansionStrategy.RULES,
      maxVariants: 3,
      llm: { enabled: false, fallbackOnly: true, timeoutMs: 1000 },
    },
    search: { topKPerQuery: 10, maxConcurrency: 10, timeoutMs: 500 },
    latency: { targetMs: 150, maxMs: 200, degradeGracefully: true },
  },
  balanced: {
    expansion: {
      strategy: ExpansionStrategy.HYBRID,
      maxVariants: 5,
      llm: { enabled: true, fallbackOnly: true, timeoutMs: 1500 },
    },
    search: { topKPerQuery: 15, maxConcurrency: 10, timeoutMs: 800 },
    latency: { targetMs: 250, maxMs: 400, degradeGracefully: true },
  },
  comprehensive: {
    expansion: {
      strategy: ExpansionStrategy.HYBRID,
      maxVariants: 10,
      llm: { enabled: true, fallbackOnly: false, timeoutMs: 2000 },
    },
    search: { topKPerQuery: 30, maxConcurrency: 10, timeoutMs: 1000 },
    latency: { targetMs: 500, maxMs: 1000, degradeGracefully: false },
  },
};

const DEFAULT_CONFIG: MultiQueryConfig = {
  enabled: false,
  expansion: {
    strategy: ExpansionStrategy.HYBRID,
    maxVariants: 7,
    llm: {
      enabled: true,
      fallbackOnly: true,
      timeoutMs: 2000,
    },
  },
  search: {
    topKPerQuery: 20,
    maxConcurrency: 10,
    timeoutMs: 1000,
  },
  fusion: {
    strategy: FusionStrategy.WEIGHTED,
    rrfK: 60,
    weights: {
      original: 2.0,
      rules: 1.0,
      llm: 0.8,
    },
    minQueryMatches: 1,
  },
  latency: {
    targetMs: 300,
    maxMs: 500,
    degradeGracefully: true,
  },
};

/**
 * Multi-Query Retrieval Service
 *
 * Implements multi-query retrieval to improve recall by:
 * 1. Expanding the user query into semantic variants
 * 2. Embedding all variants in parallel (batch)
 * 3. Searching vector store with each variant
 * 4. Fusing results using RRF or other strategies
 * 5. Deduplicating and returning ranked results
 */
@Injectable()
export class MultiQueryService {
  private readonly logger = new Logger(MultiQueryService.name);
  private globalConfig: MultiQueryConfig;

  constructor(
    private config: ConfigService,
    private embedding: EmbeddingService,
    private expansion: QueryExpansionService,
    private fusion: ResultFusionService,
  ) {
    this.globalConfig = this.loadConfig();
  }

  /**
   * Check if multi-query is globally enabled
   */
  isEnabled(): boolean {
    const envEnabled = this.config.get<string>('MULTI_QUERY_ENABLED');
    return (
      envEnabled === 'true' || envEnabled === '1' || this.globalConfig.enabled
    );
  }

  /**
   * Perform multi-query search
   *
   * @param query - Original search query
   * @param userId - User ID for filtering
   * @param options - Search options including multi-query config
   */
  async search(
    query: string,
    userId: string | string[],
    options: {
      topK?: number;
      layers?: MemoryLayer[];
      projectId?: string;
      multiQuery?: MultiQueryOptionsDto;
      poolIds?: string[];
    } = {},
  ): Promise<MultiQuerySearchResult> {
    const startTime = Date.now();
    const config = this.resolveConfig(options.multiQuery);
    const metrics: MultiQueryTimingsDto = {
      expansionMs: 0,
      embeddingMs: 0,
      searchMs: 0,
      fusionMs: 0,
      totalMs: 0,
    };
    let degraded = false;

    // 1. Expand query into variants
    const expansionStart = Date.now();
    let expansion: QueryExpansionResult;

    try {
      expansion = await this.withTimeout(
        this.expansion.expand(query, {
          strategy: config.expansion.strategy,
          maxVariants: config.expansion.maxVariants,
          llm: config.expansion.llm,
        }),
        config.latency.targetMs * 0.4, // 40% of budget for expansion
      );
    } catch (error) {
      // Fallback to rules-only on timeout
      this.logger.warn('[MultiQuery] Expansion timeout, falling back to rules');
      expansion = await this.expansion.expand(query, {
        strategy: ExpansionStrategy.RULES,
        maxVariants: 3,
        llm: {
          enabled: false,
          fallbackOnly: true,
          timeoutMs: 500,
          temperature: 0.3,
        },
      });
      degraded = true;
    }
    metrics.expansionMs = Date.now() - expansionStart;

    // Check if we should degrade to single query
    const elapsedAfterExpansion = Date.now() - startTime;
    if (
      config.latency.degradeGracefully &&
      elapsedAfterExpansion > config.latency.targetMs * 0.5
    ) {
      this.logger.warn(
        `[MultiQuery] Over budget after expansion (${elapsedAfterExpansion}ms), limiting variants`,
      );
      expansion.variants = expansion.variants.slice(0, 3);
      degraded = true;
    }

    // 2. Embed all variants in parallel (batch)
    const embedStart = Date.now();
    const embeddings = await this.embedVariants(expansion.variants);
    metrics.embeddingMs = Date.now() - embedStart;

    // 3. Search vector store in parallel
    const searchStart = Date.now();
    const searchResults = await this.searchParallel(
      embeddings,
      expansion.variants,
      userId,
      {
        topK: options.topK ?? config.search.topKPerQuery,
        layers: options.layers,
        projectId: options.projectId,
        poolIds: options.poolIds,
      },
    );
    metrics.searchMs = Date.now() - searchStart;

    // 4. Fuse results
    const fusionStart = Date.now();
    const fusedResults = this.fusion.fuse(
      searchResults,
      (options.multiQuery?.fusionStrategy as any) ?? config.fusion.strategy,
      expansion,
    );
    metrics.fusionMs = Date.now() - fusionStart;

    // 5. Limit to requested topK
    const topK = options.topK ?? 10;
    const limitedResults = fusedResults.slice(0, topK);

    metrics.totalMs = Date.now() - startTime;

    return {
      results: limitedResults,
      expansion,
      metrics,
      degraded,
    };
  }

  /**
   * Generate metadata for API response
   */
  generateMetadata(
    result: MultiQuerySearchResult,
    options: MultiQueryOptionsDto = {},
  ): MultiQueryMetadataDto {
    return {
      enabled: true,
      variants: options.includeVariants ? result.expansion.variants : undefined,
      variantSources: options.includeVariants
        ? result.expansion.sources
        : undefined,
      fusionStrategy: options.fusionStrategy ?? FusionStrategy.WEIGHTED,
      timings: options.includeTimings ? result.metrics : undefined,
    };
  }

  /**
   * Generate explanations for results
   */
  generateExplanations(
    results: FusedResult[],
    expansion: QueryExpansionResult,
  ): Record<string, ResultExplanationDto> {
    const explanations: Record<string, ResultExplanationDto> = {};

    for (const result of results) {
      explanations[result.memoryId] = {
        memoryId: result.memoryId,
        totalScore: result.score,
        matchedQueries: result.queryMatches.map((qm) => ({
          ...qm,
          isOriginal: expansion.sources[qm.query] === 'original',
        })),
        fusionContributions: {
          rrfScore: result.rrfScore,
          frequencyBoost: result.queryCount / expansion.variants.length,
          weightBoost: result.queryMatches.some(
            (qm) => expansion.sources[qm.query] === 'original',
          )
            ? 1.5
            : 1.0,
        },
      };
    }

    return explanations;
  }

  /**
   * Embed multiple query variants using batch embedding
   */
  private async embedVariants(variants: string[]): Promise<number[][]> {
    // Use Promise.all for parallel embedding
    // The embedding service should handle batching internally if supported
    const embeddings = await Promise.all(
      variants.map((v) => this.embedding.generateForRecall(v)),
    );
    // Validate embeddings — filter out any that contain non-numeric values
    return embeddings.filter(
      (emb) =>
        Array.isArray(emb) &&
        emb.length > 0 &&
        emb.every((val) => typeof val === 'number' && !isNaN(val)),
    );
  }

  /**
   * Search vector store in parallel for all variants
   */
  private async searchParallel(
    embeddings: number[][],
    variants: string[],
    userId: string | string[],
    options: {
      topK: number;
      layers?: MemoryLayer[];
      projectId?: string;
      poolIds?: string[];
    },
  ): Promise<QuerySearchResult[]> {
    const searchPromises = embeddings.map(async (embedding, index) => {
      const searchStart = Date.now();

      const results = await this.embedding.search(
        userId,
        embedding,
        options.topK,
        options.layers,
        options.projectId,
        options.poolIds,
      );

      return {
        query: variants[index],
        queryIndex: index,
        matches: results.map((r) => ({
          id: r.id,
          score: r.score,
          metadata: r.metadata,
        })),
        searchTimeMs: Date.now() - searchStart,
      };
    });

    return Promise.all(searchPromises);
  }

  /**
   * Resolve final configuration from options, preset, and defaults
   */
  private resolveConfig(options?: MultiQueryOptionsDto): MultiQueryConfig {
    let config = { ...this.globalConfig };

    // Apply preset if specified
    if (options?.preset && PRESETS[options.preset]) {
      config = this.mergeConfig(config, PRESETS[options.preset]);
    }

    // Apply individual overrides
    if (options) {
      if (options.maxVariants !== undefined) {
        config.expansion.maxVariants = options.maxVariants;
      }
      if (options.fusionStrategy !== undefined) {
        config.fusion.strategy = options.fusionStrategy as any;
      }
      if (options.expansionStrategy !== undefined) {
        config.expansion.strategy = options.expansionStrategy as any;
      }
      if (options.targetLatencyMs !== undefined) {
        config.latency.targetMs = options.targetLatencyMs;
        config.latency.maxMs = options.targetLatencyMs * 1.5;
      }
    }

    return config;
  }

  /**
   * Merge partial config into full config
   */
  private mergeConfig(
    base: MultiQueryConfig,
    partial: Partial<MultiQueryConfig>,
  ): MultiQueryConfig {
    return {
      ...base,
      expansion: {
        ...base.expansion,
        ...partial.expansion,
        llm: {
          ...base.expansion.llm,
          ...partial.expansion?.llm,
        },
      },
      search: {
        ...base.search,
        ...partial.search,
      },
      fusion: {
        ...base.fusion,
        ...partial.fusion,
        weights: {
          ...base.fusion.weights,
          ...partial.fusion?.weights,
        },
      },
      latency: {
        ...base.latency,
        ...partial.latency,
      },
    };
  }

  /**
   * Load configuration from environment
   */
  private loadConfig(): MultiQueryConfig {
    const config = { ...DEFAULT_CONFIG };

    // Environment overrides
    const enabled = this.config.get<string>('MULTI_QUERY_ENABLED');
    if (enabled !== undefined) {
      config.enabled = enabled === 'true' || enabled === '1';
    }

    const strategy = this.config.get<string>('MULTI_QUERY_STRATEGY');
    if (
      strategy &&
      Object.values(ExpansionStrategy).includes(strategy as ExpansionStrategy)
    ) {
      config.expansion.strategy = strategy as ExpansionStrategy;
    }

    const maxVariants = this.config.get<number>('MULTI_QUERY_MAX_VARIANTS');
    if (maxVariants !== undefined) {
      config.expansion.maxVariants = maxVariants;
    }

    const targetLatency = this.config.get<number>(
      'MULTI_QUERY_LATENCY_TARGET_MS',
    );
    if (targetLatency !== undefined) {
      config.latency.targetMs = targetLatency;
    }

    const llmEnabled = this.config.get<string>('MULTI_QUERY_LLM_ENABLED');
    if (llmEnabled !== undefined) {
      config.expansion.llm.enabled =
        llmEnabled === 'true' || llmEnabled === '1';
    }

    const fusionStrategy = this.config.get<string>(
      'MULTI_QUERY_FUSION_STRATEGY',
    );
    if (
      fusionStrategy &&
      Object.values(FusionStrategy).includes(fusionStrategy as FusionStrategy)
    ) {
      config.fusion.strategy = fusionStrategy as FusionStrategy;
    }

    return config;
  }

  /**
   * Helper to wrap a promise with timeout
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs),
      ),
    ]);
  }
}
