/**
 * Model Registry Service
 *
 * Manages the ensemble model registry including:
 * - Active and shadow model tracking
 * - Model weights and configuration
 * - Promotion from shadow to active
 * - Quality metrics tracking
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnsembleModelConfig } from '@prisma/client';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import {
  ModelId,
  ModelStatus,
  ModelRegistryEntry,
  ModelQualityMetrics,
  PromotionThresholds,
  QueryType,
  MODEL_CONFIGS,
  DEFAULT_ACTIVE_MODELS,
  DEFAULT_PROMOTION_THRESHOLDS,
} from './ensemble.types';

@Injectable()
export class ModelRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ModelRegistryService.name);

  // In-memory cache of model configs
  private modelCache: Map<ModelId, ModelRegistryEntry> = new Map();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: ServicePrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Initialize model registry from DB or defaults
    await this.initializeRegistry();
  }

  /**
   * Initialize model registry with defaults if empty
   */
  private async initializeRegistry(): Promise<void> {
    const existingModels = await this.prisma.ensembleModelConfig.findMany();

    if (existingModels.length === 0) {
      this.logger.log('Initializing model registry with defaults');

      // Create default active models
      for (const modelId of DEFAULT_ACTIVE_MODELS) {
        await this.addModel({
          modelId,
          status: 'active',
          weight: MODEL_CONFIGS[modelId]?.weight ?? 1.0,
          promotionThresholds: DEFAULT_PROMOTION_THRESHOLDS,
        });
      }
    } else {
      // Load existing configs into cache
      const existingIds = new Set<string>();
      for (const model of existingModels) {
        const entry = this.dbToEntry(model);
        this.modelCache.set(model.modelId as ModelId, entry);
        existingIds.add(model.modelId);
      }

      // Add any missing models from DEFAULT_ACTIVE_MODELS
      for (const modelId of DEFAULT_ACTIVE_MODELS) {
        if (!existingIds.has(modelId)) {
          this.logger.log(`Adding missing default model: ${modelId}`);
          await this.addModel({
            modelId,
            status: 'active',
            weight: MODEL_CONFIGS[modelId]?.weight ?? 1.0,
            promotionThresholds: DEFAULT_PROMOTION_THRESHOLDS,
          });
        }
      }
    }

    this.logger.log(
      `Model registry initialized with ${this.modelCache.size} models`,
    );
  }

  /**
   * Get all active models
   */
  async getActiveModels(): Promise<ModelId[]> {
    const models = await this.prisma.ensembleModelConfig.findMany({
      where: { status: 'ACTIVE' },
      select: { modelId: true },
    });

    return models.map((m) => m.modelId as ModelId);
  }

  /**
   * Get all active and shadow models
   */
  async getActiveAndShadowModels(): Promise<ModelId[]> {
    const models = await this.prisma.ensembleModelConfig.findMany({
      where: { status: { in: ['ACTIVE', 'SHADOW'] } },
      select: { modelId: true },
    });

    return models.map((m) => m.modelId as ModelId);
  }

  /**
   * Get model configuration
   */
  async getModelConfig(modelId: ModelId): Promise<ModelRegistryEntry | null> {
    // Check cache first
    if (this.modelCache.has(modelId)) {
      return this.modelCache.get(modelId)!;
    }

    const model = await this.prisma.ensembleModelConfig.findUnique({
      where: { modelId },
    });

    if (!model) return null;

    const entry = this.dbToEntry(model);
    this.modelCache.set(modelId, entry);
    return entry;
  }

  /**
   * Get all model configurations
   */
  async getAllModels(): Promise<ModelRegistryEntry[]> {
    const models = await this.prisma.ensembleModelConfig.findMany({
      orderBy: { addedAt: 'asc' },
    });

    return models.map((m) => this.dbToEntry(m));
  }

  /**
   * Add a new model to the registry
   */
  async addModel(config: {
    modelId: ModelId;
    status?: ModelStatus;
    weight?: number;
    promotionThresholds?: PromotionThresholds;
  }): Promise<ModelRegistryEntry> {
    const {
      modelId,
      status = 'shadow',
      weight = 1.0,
      promotionThresholds,
    } = config;

    const model = await this.prisma.ensembleModelConfig.create({
      data: {
        modelId,
        status: status.toUpperCase() as
          | 'ACTIVE'
          | 'SHADOW'
          | 'DEPRECATED'
          | 'DISABLED',
        weight,
        promotionThresholds: (promotionThresholds ??
          DEFAULT_PROMOTION_THRESHOLDS) as any,
        qualityMetrics: {
          sampleQueries: 0,
          avgRankContribution: 0,
          uniqueHits: 0,
          correlationWithGoldStandard: 0,
        },
        promotedAt: status === 'active' ? new Date() : null,
      },
    });

    const entry = this.dbToEntry(model);
    this.modelCache.set(modelId, entry);

    this.logger.log(`Added model ${modelId} with status ${status}`);
    return entry;
  }

  /**
   * Update model status
   */
  async updateModelStatus(
    modelId: ModelId,
    status: ModelStatus,
  ): Promise<void> {
    const updateData: Record<string, unknown> = {
      status: status.toUpperCase(),
    };

    if (status === 'active') {
      updateData.promotedAt = new Date();
    } else if (status === 'deprecated') {
      updateData.deprecatedAt = new Date();
    }

    await this.prisma.ensembleModelConfig.update({
      where: { modelId },
      data: updateData,
    });

    // Update cache
    const cached = this.modelCache.get(modelId);
    if (cached) {
      cached.status = status;
      if (status === 'active') cached.promotedAt = new Date();
      if (status === 'deprecated') cached.deprecatedAt = new Date();
    }

    this.logger.log(`Updated model ${modelId} status to ${status}`);
  }

  /**
   * Update model weight
   */
  async updateModelWeight(modelId: ModelId, weight: number): Promise<void> {
    await this.prisma.ensembleModelConfig.update({
      where: { modelId },
      data: { weight },
    });

    // Update cache
    const cached = this.modelCache.get(modelId);
    if (cached) {
      cached.weight = weight;
    }

    this.logger.log(`Updated model ${modelId} weight to ${weight}`);
  }

  /**
   * Update model quality metrics
   */
  async updateQualityMetrics(
    modelId: ModelId,
    metrics: Partial<ModelQualityMetrics>,
  ): Promise<void> {
    const existing = await this.getModelConfig(modelId);
    if (!existing) return;

    const updated = {
      ...existing.qualityMetrics,
      ...metrics,
    };

    await this.prisma.ensembleModelConfig.update({
      where: { modelId },
      data: { qualityMetrics: updated },
    });

    // Update cache
    const cached = this.modelCache.get(modelId);
    if (cached) {
      cached.qualityMetrics = updated;
    }
  }

  /**
   * Check if model meets promotion criteria
   */
  async checkPromotionCriteria(modelId: ModelId): Promise<{
    passed: boolean;
    reasons: string[];
  }> {
    const config = await this.getModelConfig(modelId);
    if (!config) {
      return { passed: false, reasons: ['Model not found'] };
    }

    const { qualityMetrics, promotionThresholds } = config;
    const reasons: string[] = [];

    if (qualityMetrics.sampleQueries < promotionThresholds.minSampleQueries) {
      reasons.push(
        `Insufficient samples: ${qualityMetrics.sampleQueries} < ${promotionThresholds.minSampleQueries}`,
      );
    }

    if (
      qualityMetrics.avgRankContribution <
      promotionThresholds.minRankContribution
    ) {
      reasons.push(
        `Low rank contribution: ${qualityMetrics.avgRankContribution.toFixed(3)} < ${promotionThresholds.minRankContribution}`,
      );
    }

    if (
      qualityMetrics.correlationWithGoldStandard <
      promotionThresholds.minCorrelation
    ) {
      reasons.push(
        `Low correlation: ${qualityMetrics.correlationWithGoldStandard.toFixed(3)} < ${promotionThresholds.minCorrelation}`,
      );
    }

    return {
      passed: reasons.length === 0,
      reasons,
    };
  }

  /**
   * Promote model from shadow to active
   */
  async promoteModel(
    modelId: ModelId,
  ): Promise<{ success: boolean; error?: string }> {
    const criteria = await this.checkPromotionCriteria(modelId);

    if (!criteria.passed) {
      return {
        success: false,
        error: `Promotion criteria not met: ${criteria.reasons.join('; ')}`,
      };
    }

    await this.updateModelStatus(modelId, 'active');
    return { success: true };
  }

  /**
   * Get model weights for fusion
   */
  async getModelWeights(): Promise<Record<ModelId, number>> {
    const models = await this.prisma.ensembleModelConfig.findMany({
      where: { status: { in: ['ACTIVE', 'SHADOW'] } },
      select: { modelId: true, weight: true },
    });

    const weights: Record<string, number> = {};
    for (const model of models) {
      weights[model.modelId] = model.weight;
    }

    return weights as Record<ModelId, number>;
  }

  /**
   * Get query-type-specific weights for a model
   */
  async getQueryTypeWeights(
    modelId: ModelId,
    queryType: QueryType,
  ): Promise<number> {
    const config = await this.getModelConfig(modelId);
    if (!config) return 1.0;

    return config.queryTypeWeights?.[queryType] ?? config.weight;
  }

  /**
   * Clear the in-memory cache
   */
  clearCache(): void {
    this.modelCache.clear();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private dbToEntry(model: EnsembleModelConfig): ModelRegistryEntry {
    return {
      modelId: model.modelId as ModelId,
      status: model.status.toLowerCase() as ModelStatus,
      addedAt: model.addedAt,
      promotedAt: model.promotedAt ?? undefined,
      deprecatedAt: model.deprecatedAt ?? undefined,
      weight: model.weight,
      queryTypeWeights: model.queryTypeWeights as
        | Record<QueryType, number>
        | undefined,
      qualityMetrics:
        (model.qualityMetrics as unknown as ModelQualityMetrics) ?? {
          sampleQueries: 0,
          avgRankContribution: 0,
          uniqueHits: 0,
          correlationWithGoldStandard: 0,
        },
      promotionThresholds:
        (model.promotionThresholds as unknown as PromotionThresholds) ??
        DEFAULT_PROMOTION_THRESHOLDS,
    };
  }
}
