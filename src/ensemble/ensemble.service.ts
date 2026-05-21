/**
 * Ensemble Service
 *
 * Manages multi-model embedding and retrieval with RRF fusion.
 * Uses pgvector for storage (replaced Pinecone).
 *
 * Key features:
 * - Multiple models: bge-base (768-dim), nomic (768-dim), minilm (384-dim)
 * - Parallel vector queries across models stored in memory_embeddings table
 * - Reciprocal Rank Fusion for result combination
 * - Feature-flagged for gradual rollout
 * - Support for batch embedding (for nightly re-embed)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { rlsContext } from '../prisma/rls-context';
import { EmbeddingService } from '../embedding/embedding.service';
import { CloudEnsembleService } from '../embedding/cloud-ensemble.service';
import { CohereEmbeddingProvider } from '../embedding/providers';
import { MemoryCreatedEvent, MemoryDeletedEvent } from '../events/event-types';
import {
  PgVectorEnsembleProvider,
  EnsembleEmbeddingRecord,
} from './pgvector-ensemble.provider';
import { PLAN_LIMITS } from '../account/plan-limits';
import { Plan } from '@prisma/client';
import {
  ModelId,
  ModelConfig,
  MODEL_CONFIGS,
  ModelSearchResult,
  FusedResult,
  EmbeddingResult,
  MultiEmbedResponse,
  EnsembleQueryOptions,
  EnsembleQueryResult,
  EnsembleUpsertOptions,
  EnsembleConfig,
  EmbedError,
  ModelInfo,
  CoverageStats,
  MemoryEmbeddingStatus,
  ABTestResult,
  DEFAULT_ACTIVE_MODELS,
} from './ensemble.types';

@Injectable()
export class EnsembleService implements OnModuleInit {
  private readonly logger = new Logger(EnsembleService.name);
  private config: EnsembleConfig;

  private useCloud = false;

  constructor(
    private configService: ConfigService,
    private pgvectorProvider: PgVectorEnsembleProvider,
    private prisma: PrismaService,
    private embeddingService: EmbeddingService,
    private cloudEnsemble: CloudEnsembleService,
  ) {
    // Load configuration
    // Models can be configured via ENSEMBLE_MODELS env var (comma-separated)
    const modelsEnv = this.configService.get<string>(
      'ENSEMBLE_MODELS',
      DEFAULT_ACTIVE_MODELS.join(','),
    );
    const models = modelsEnv.split(',').map((m) => m.trim()) as ModelId[];

    this.config = {
      enabled: this.configService.get<boolean>('ENSEMBLE_ENABLED', false),
      models,
      weights: { 'bge-base': 1.0, nomic: 0.8, 'gte-base': 0.7, minilm: 1.0 },
      rrfK: 60,
      localEmbedUrl: this.configService.get<string>(
        'LOCAL_EMBED_URL',
        'http://127.0.0.1:8080',
      ),
      consensusBoostEnabled: this.configService.get<boolean>(
        'ENSEMBLE_CONSENSUS_BOOST',
        true,
      ),
      consensusBoostFactor: this.configService.get<number>(
        'ENSEMBLE_CONSENSUS_FACTOR',
        0.1,
      ),
    };
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.log('Ensemble retrieval is disabled');
      return;
    }

    // Check if cloud ensemble should be used
    const provider = this.configService.get<string>(
      'EMBEDDING_PROVIDER',
      'local',
    );
    if (provider === 'cloud-ensemble') {
      await this.cloudEnsemble.initialize();
      if (this.cloudEnsemble.isAvailable()) {
        this.useCloud = true;
        this.config.models = this.cloudEnsemble.getModelIds();
        // Set weights for cloud models
        for (const modelId of this.config.models) {
          this.config.weights[modelId] = MODEL_CONFIGS[modelId]?.weight ?? 1.0;
        }
        this.logger.log(
          `Ensemble initialized with CLOUD providers, models: ${this.config.models.join(', ')}`,
        );
        return;
      }
      this.logger.warn(
        'Cloud ensemble requested but no providers available, falling back to local',
      );
    }

    // pgvector is always available if database is configured
    this.logger.log(
      `Ensemble initialized with pgvector storage, models: ${this.config.models.join(', ')}`,
    );
  }

  /**
   * Handle memory.created events — generate ensemble embeddings
   * for newly created memories so they're immediately searchable
   * via multi-model RRF fusion.
   */
  @OnEvent('memory.created', { async: true })
  async handleMemoryCreated(event: MemoryCreatedEvent): Promise<void> {
    if (!this.config.enabled) return;

    // Escape any inherited AsyncLocalStorage tx from the emitter's request.
    // Async listeners outlive the request transaction; reusing tx → "Transaction already closed".
    await rlsContext.run(undefined as any, async () => {
      try {
        const memory = await this.prisma.memory.findUnique({
          where: { id: event.memoryId },
          select: { id: true, raw: true },
        });

        if (!memory) {
          this.logger.warn(
            `Memory ${event.memoryId} not found for ensemble embedding`,
          );
          return;
        }

        await this.upsert({
          memoryId: memory.id,
          content: memory.raw,
          userId: event.userId,
        });

        this.logger.debug(
          `Ensemble embeddings created for memory ${event.memoryId}`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to create ensemble embeddings for ${event.memoryId}: ${err}`,
        );
      }
    });
  }

  /**
   * Handle memory.deleted events — clean up ensemble embeddings
   */
  @OnEvent('memory.deleted', { async: true })
  async handleMemoryDeleted(event: MemoryDeletedEvent): Promise<void> {
    if (!this.config.enabled) return;

    try {
      await this.delete(event.memoryId);
    } catch (err) {
      this.logger.error(
        `Failed to delete ensemble embeddings for ${event.memoryId}: ${err}`,
      );
    }
  }

  /**
   * Look up a user's plan and return the allowed ensemble model count.
   * Returns undefined if not using cloud (local always uses all models).
   */
  private async getEnsembleModelCount(
    userId?: string,
  ): Promise<number | undefined> {
    if (!this.useCloud || !userId) return undefined;

    try {
      // User → Agent → Account
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { account: { select: { plan: true } } },
      });
      const account = user?.account;
      const plan: Plan = account?.plan ?? 'FREE';
      return PLAN_LIMITS[plan].ensembleModels;
    } catch (err) {
      this.logger.warn(
        `Failed to look up plan for user ${userId}, defaulting to FREE limits: ${err}`,
      );
      return PLAN_LIMITS.FREE.ensembleModels;
    }
  }

  /**
   * Get the model IDs that EnsembleService has configured (from env/cloud init).
   * Used by nightly-reembed to avoid querying DB defaults that don't match cloud providers.
   */
  getConfiguredModelIds(): ModelId[] {
    return [...this.config.models];
  }

  /**
   * Check if ensemble is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get current configuration
   */
  getConfig(): EnsembleConfig {
    return { ...this.config };
  }

  /**
   * Generate embeddings for text using all configured models.
   * When using cloud providers, respects plan-based ensemble model limits.
   * @param userId Used to look up plan limits for cloud ensemble (ignored for local)
   */
  async embedAll(
    text: string,
    mode: 'document' | 'query' = 'document',
    userId?: string,
  ): Promise<MultiEmbedResponse> {
    // Route to cloud providers if active (with plan limits)
    if (this.useCloud) {
      const modelCount = await this.getEnsembleModelCount(userId);
      if (modelCount !== undefined) {
        if (modelCount === 0) {
          // FREE plan: no ensemble embedding
          return { embeddings: [], totalMs: 0 };
        }
        return this.cloudEnsemble.embedAllForPlan(text, modelCount, mode);
      }
      return this.cloudEnsemble.embedAll(text, mode);
    }

    const start = Date.now();
    const embeddings: EmbeddingResult[] = [];

    // Call local embed server with model="*" for all models
    try {
      const response = await fetch(
        `${this.config.localEmbedUrl}/v1/embeddings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: text,
            model: '*', // Request all models
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Embed server returned ${response.status}: ${await response.text()}`,
        );
      }

      const data = await response.json();

      // Parse multi-model response
      if (data.embeddings) {
        for (const modelEmbed of data.embeddings) {
          const modelId = modelEmbed.model as ModelId;
          if (modelEmbed.data?.[0]?.embedding) {
            embeddings.push({
              model: modelId,
              dimensions: modelEmbed.dimensions,
              embedding: modelEmbed.data[0].embedding,
              latencyMs: data.timing?.per_model?.[modelId] ?? 0,
            });
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to get embeddings from local server', error);
      // Graceful degradation: return empty embeddings instead of throwing
      // Memory will be created without embeddings and retried later
      return {
        embeddings: [],
        totalMs: Date.now() - start,
        errors: this.config.models.map((model) => ({
          model,
          error: error instanceof Error ? error.message : String(error),
          recoverable: true,
        })),
      };
    }

    return {
      embeddings,
      totalMs: Date.now() - start,
    };
  }

  /**
   * Generate embedding for a specific model
   *
   * Note: For single-model embedding when using the default provider,
   * this delegates to EmbeddingService. For ensemble-specific multi-model
   * requests, embedAll() still uses the local embed server directly.
   */
  async embed(text: string, model: ModelId): Promise<EmbeddingResult> {
    const start = Date.now();

    // Use cloud provider if available for this model
    if (this.useCloud) {
      const provider = this.cloudEnsemble.getProvider(model);
      if (provider) {
        // Set Cohere input type for single embeds
        if (provider instanceof CohereEmbeddingProvider) {
          provider.setInputType('search_document');
        }
        const vectors = await provider.embed([text]);
        return {
          model,
          dimensions: provider.getDimensions(),
          embedding: vectors[0],
          latencyMs: Date.now() - start,
        };
      }
    }

    // Use local embed server directly for model-specific requests
    const response = await fetch(`${this.config.localEmbedUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: text,
        model,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Embed server returned ${response.status}: ${await response.text()}`,
      );
    }

    const data = await response.json();
    const embedding = data.data?.[0]?.embedding;

    if (!embedding) {
      throw new Error('No embedding in response');
    }

    return {
      model,
      dimensions: MODEL_CONFIGS[model].dimensions,
      embedding,
      latencyMs: Date.now() - start,
    };
  }

  /**
   * Upsert memory embeddings to pgvector memory_embeddings table
   */
  async upsert(options: EnsembleUpsertOptions): Promise<void> {
    if (!this.config.enabled) {
      this.logger.debug('Ensemble disabled, skipping upsert');
      return;
    }

    // Generate embeddings from all models (plan-limited for cloud)
    const { embeddings, errors } = await this.embedAll(
      options.content,
      'document',
      options.userId,
    );

    if (embeddings.length === 0) {
      this.logger.warn(
        `No embeddings generated for memory ${options.memoryId} — embed service may be down`,
      );
      return;
    }

    // Prepare records for batch upsert
    const records: EnsembleEmbeddingRecord[] = embeddings.map((embResult) => ({
      memoryId: options.memoryId,
      modelId: embResult.model,
      embedding: embResult.embedding,
      dimensions: embResult.dimensions,
    }));

    // Upsert to pgvector
    await this.pgvectorProvider.upsertEmbeddings(records);

    this.logger.debug(
      `Upserted ${embeddings.length} embeddings for memory ${options.memoryId}`,
    );
  }

  /**
   * Upsert pre-computed embeddings directly (used by nightly re-embed)
   */
  async upsertEmbeddings(records: EnsembleEmbeddingRecord[]): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    await this.pgvectorProvider.upsertEmbeddings(records);
  }

  /**
   * Embed specific memories with specific models (fetches content, embeds, stores)
   */
  async embedBatchForMemories(
    memoryIds: string[],
    models: ModelId[],
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // Fetch memories
    const memories = await this.prisma.memory.findMany({
      where: { id: { in: memoryIds } },
      select: { id: true, raw: true, userId: true },
    });

    if (memories.length === 0) return;

    // Generate embeddings - embedBatch returns embeddings grouped by model, then by text index
    const texts = memories.map((m) => m.raw);
    const batchResult = await this.embedBatch(texts, models);

    // Group embeddings by model to track text index
    const embeddingsByModel = new Map<ModelId, number[][]>();
    for (const embedding of batchResult.embeddings) {
      if (!embeddingsByModel.has(embedding.model)) {
        embeddingsByModel.set(embedding.model, []);
      }
      embeddingsByModel.get(embedding.model)!.push(embedding.embedding);
    }

    // Convert to records for storage
    const records: EnsembleEmbeddingRecord[] = [];
    for (const [modelId, modelEmbeddings] of embeddingsByModel) {
      for (let i = 0; i < memories.length && i < modelEmbeddings.length; i++) {
        const memory = memories[i];
        const embedding = modelEmbeddings[i];
        if (embedding) {
          records.push({
            memoryId: memory.id,
            modelId,
            embedding,
            dimensions: embedding.length,
          });
        }
      }
    }

    // Store embeddings
    if (records.length > 0) {
      await this.pgvectorProvider.upsertEmbeddings(records);
    }
  }

  /**
   * Query all model namespaces and fuse results with RRF
   */
  async query(options: EnsembleQueryOptions): Promise<EnsembleQueryResult> {
    const start = Date.now();

    if (!this.config.enabled) {
      throw new Error('Ensemble is not enabled');
    }

    const models = options.models ?? this.config.models;
    const limit = options.limit ?? 10;
    const topKPerModel = Math.ceil(limit * 2.5); // Fetch more for fusion
    const k = options.k ?? this.config.rrfK;

    // Generate query embeddings for all models (plan-limited for cloud)
    const { embeddings } = await this.embedAll(
      options.query,
      'query',
      options.userId,
    );
    const embeddingMap = new Map(embeddings.map((e) => [e.model, e.embedding]));

    // Query each model using pgvector
    const modelResults = await this.pgvectorProvider.queryWithModelEmbeddings(
      embeddingMap,
      options.userId,
      topKPerModel,
    );

    // Apply RRF fusion
    const weights = { ...this.config.weights, ...options.weights };
    const fusedResults = this.reciprocalRankFusion(modelResults, k, weights);

    return {
      results: fusedResults.slice(0, limit),
      metadata: {
        queryTimeMs: Date.now() - start,
        modelsQueried: Array.from(modelResults.keys()),
        candidatesEvaluated: fusedResults.length,
        fusionAlgorithm: 'rrf',
      },
    };
  }

  /**
   * Reciprocal Rank Fusion (RRF)
   *
   * Combines results from multiple models using the formula:
   * RRF_score(d) = Σ weight_m * (1 / (k + rank_m(d)))
   *
   * @param modelResults Map of model -> ranked results
   * @param k RRF constant (default 60)
   * @param weights Per-model weights
   */
  reciprocalRankFusion(
    modelResults: Map<ModelId, ModelSearchResult[]>,
    k: number = 60,
    weights: Partial<Record<ModelId, number>> = {
      'bge-base': 1.0,
      nomic: 0.8,
      'gte-base': 0.7,
      minilm: 1.0,
    },
  ): FusedResult[] {
    const fusedScores = new Map<string, FusedResult>();

    for (const [model, results] of modelResults) {
      const weight = weights[model] ?? 1.0;

      for (const result of results) {
        let existing = fusedScores.get(result.memoryId);

        if (!existing) {
          existing = {
            memoryId: result.memoryId,
            rrfScore: 0,
            modelScores: new Map(),
            appearsInModels: 0,
          };
          fusedScores.set(result.memoryId, existing);
        }

        // RRF contribution: weight * (1 / (k + rank))
        const rrfContribution = weight * (1 / (k + result.rank));
        existing.rrfScore += rrfContribution;
        existing.modelScores.set(model, {
          rank: result.rank,
          score: result.score,
        });
        existing.appearsInModels++;
      }
    }

    // Apply consensus boost if enabled
    if (this.config.consensusBoostEnabled) {
      const maxModels = modelResults.size;
      for (const result of fusedScores.values()) {
        if (result.appearsInModels > 1) {
          // Boost score based on how many models agree
          const consensusRatio = result.appearsInModels / maxModels;
          result.rrfScore *=
            1 + this.config.consensusBoostFactor * consensusRatio;
        }
      }
    }

    // Sort by RRF score descending
    return Array.from(fusedScores.values()).sort(
      (a, b) => b.rrfScore - a.rrfScore,
    );
  }

  /**
   * Delete embeddings for a memory from all models
   */
  async delete(memoryId: string): Promise<void> {
    if (!this.config.enabled) return;
    await this.pgvectorProvider.deleteByMemory(memoryId);
  }

  /**
   * Generate embeddings for a batch of texts with specific models
   * Used by nightly re-embed service
   */
  async embedBatch(
    texts: string[],
    models: ModelId[],
  ): Promise<MultiEmbedResponse> {
    // Route to cloud providers if active
    if (this.useCloud) {
      return this.cloudEnsemble.embedBatch(texts, models);
    }

    const start = Date.now();
    const embeddings: EmbeddingResult[] = [];
    const errors: EmbedError[] = [];

    try {
      const response = await fetch(
        `${this.config.localEmbedUrl}/v1/embeddings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: texts,
            model: models.length === 1 ? models[0] : '*',
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Embed server returned ${response.status}: ${await response.text()}`,
        );
      }

      const data = await response.json();

      // Handle multi-model response
      if (data.embeddings) {
        for (const modelEmbed of data.embeddings) {
          const modelId = modelEmbed.model as ModelId;
          if (models.includes(modelId) && modelEmbed.data) {
            // For batch embeddings, we get an array of embeddings
            for (let i = 0; i < modelEmbed.data.length; i++) {
              if (modelEmbed.data[i]?.embedding) {
                embeddings.push({
                  model: modelId,
                  dimensions: modelEmbed.dimensions,
                  embedding: modelEmbed.data[i].embedding,
                  latencyMs: data.timing?.per_model?.[modelId] ?? 0,
                });
              }
            }
          }
        }
      } else if (data.data) {
        // Single model response format
        for (let i = 0; i < data.data.length; i++) {
          if (data.data[i]?.embedding) {
            embeddings.push({
              model: models[0],
              dimensions: data.data[i].embedding.length,
              embedding: data.data[i].embedding,
              latencyMs: Date.now() - start,
            });
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to get batch embeddings', error);
      for (const model of models) {
        errors.push({
          model,
          error: error instanceof Error ? error.message : String(error),
          recoverable: true,
        });
      }
    }

    return {
      embeddings,
      totalMs: Date.now() - start,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Compare ensemble vs single-model retrieval (for debugging/benchmarking)
   */
  async compare(
    query: string,
    userId: string,
    limit: number = 10,
  ): Promise<{
    ensemble: EnsembleQueryResult;
    singleModel: Map<ModelId, ModelSearchResult[]>;
  }> {
    // Get ensemble results
    const ensemble = await this.query({ query, userId, limit });

    // Get individual model results
    const { embeddings } = await this.embedAll(query);
    const embeddingMap = new Map(embeddings.map((e) => [e.model, e.embedding]));

    const singleModel = await this.pgvectorProvider.queryWithModelEmbeddings(
      embeddingMap,
      userId,
      limit,
    );

    return { ensemble, singleModel };
  }

  /**
   * Get embedding counts by model (useful for monitoring)
   */
  async getEmbeddingStats(): Promise<Record<ModelId, number>> {
    return this.pgvectorProvider.getEmbeddingCountByModel();
  }

  /**
   * Get existing embedding for drift detection
   */
  async getExistingEmbedding(
    memoryId: string,
    modelId: ModelId,
  ): Promise<number[] | null> {
    return this.pgvectorProvider.getExistingEmbedding(memoryId, modelId);
  }

  /**
   * Get memories missing embeddings for specified models
   */
  async getMemoriesMissingEmbeddings(
    userId: string,
    models?: ModelId[],
    limit?: number,
  ): Promise<string[]> {
    const targetModels = models ?? this.config.models;
    return this.pgvectorProvider.getMemoriesMissingEmbeddings(
      userId,
      targetModels,
      limit,
    );
  }

  /**
   * Get all registered models with their status, dimensions, weights, and quality scores
   */
  async getModels(): Promise<ModelInfo[]> {
    // Get counts per model
    const counts = await this.pgvectorProvider.getEmbeddingCountByModel();

    // Get model configs from database if available, otherwise use defaults
    const modelConfigs = await this.pgvectorProvider.getModelConfigs();

    const models: ModelInfo[] = [];

    for (const modelId of this.config.models) {
      const config = MODEL_CONFIGS[modelId];
      const dbConfig = modelConfigs.find((m) => m.modelId === modelId);

      models.push({
        modelId,
        status:
          dbConfig?.status ??
          (this.config.models.includes(modelId) ? 'active' : 'disabled'),
        dimensions: config.dimensions,
        weight: dbConfig?.weight ?? this.config.weights[modelId] ?? 1.0,
        embeddingCount: counts[modelId] ?? 0,
        qualityMetrics: dbConfig?.qualityMetrics ?? null,
        addedAt: dbConfig?.addedAt ?? null,
        promotedAt: dbConfig?.promotedAt ?? null,
      });
    }

    return models;
  }

  /**
   * Get embedding coverage statistics
   */
  async getCoverage(): Promise<CoverageStats> {
    return this.pgvectorProvider.getCoverageStats(this.config.models);
  }

  /**
   * Get embeddings status for a specific memory
   */
  async getMemoryEmbeddings(
    memoryId: string,
  ): Promise<MemoryEmbeddingStatus[]> {
    return this.pgvectorProvider.getMemoryEmbeddingStatus(memoryId);
  }

  /**
   * Get A/B test results
   */
  async getABTestResults(
    testId?: string,
    limit?: number,
  ): Promise<ABTestResult[]> {
    return this.pgvectorProvider.getABTestResults(testId, limit);
  }
}
