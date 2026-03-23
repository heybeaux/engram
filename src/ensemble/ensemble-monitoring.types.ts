/**
 * Ensemble Monitoring Types
 *
 * Model registry, health/monitoring, API responses, and fallback configuration.
 */

import type { ModelId, ModelStatus, QueryType } from './ensemble-model.types';

// ============================================================================
// Model Registry Types
// ============================================================================

/**
 * Model configuration in registry
 */
export interface ModelRegistryEntry {
  modelId: ModelId;
  status: ModelStatus;
  addedAt: Date;
  promotedAt?: Date;
  deprecatedAt?: Date;
  weight: number;
  queryTypeWeights?: Record<QueryType, number>;
  qualityMetrics: ModelQualityMetrics;
  promotionThresholds: PromotionThresholds;
}

/**
 * Quality metrics for promotion decisions
 */
export interface ModelQualityMetrics {
  sampleQueries: number;
  avgRankContribution: number;
  uniqueHits: number;
  correlationWithGoldStandard: number;
}

/**
 * Thresholds for model promotion
 */
export interface PromotionThresholds {
  minSampleQueries: number;
  minRankContribution: number;
  minCorrelation: number;
}

/**
 * Default promotion thresholds
 */
export const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = {
  minSampleQueries: 1000,
  minRankContribution: 0.15,
  minCorrelation: 0.8,
};

// ============================================================================
// Health & Monitoring Types
// ============================================================================

/**
 * Health status for ensemble service
 */
export interface EnsembleHealth {
  overall: 'healthy' | 'degraded' | 'critical';
  models: Record<ModelId, ModelHealth>;
  pinecone: PineconeHealth;
  lastCheck: Date;
}

/**
 * Health status for individual model
 */
export interface ModelHealth {
  status: 'up' | 'slow' | 'down';
  latencyMs: number;
  errorRate: number;
  lastSuccess: Date | null;
}

/**
 * Health status for Pinecone
 */
export interface PineconeHealth {
  status: 'up' | 'degraded' | 'down';
  indexes: Record<string, IndexHealth>;
}

/**
 * Health status for Pinecone index
 */
export interface IndexHealth {
  status: 'up' | 'down';
  vectorCount: number;
  lastQueryMs: number;
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Model info for /ensemble/models endpoint
 */
export interface ModelInfo {
  modelId: ModelId;
  status: ModelStatus;
  dimensions: number;
  weight: number;
  embeddingCount: number;
  qualityMetrics: ModelQualityMetrics | null;
  addedAt: Date | null;
  promotedAt: Date | null;
}

/**
 * Coverage stats for /ensemble/coverage endpoint
 */
export interface CoverageStats {
  totalMemories: number;
  memoriesWithAnyEmbedding: number;
  memoriesWithAllModels: number;
  coveragePercent: number;
  perModel: Record<ModelId, ModelCoverageStats>;
}

/**
 * Per-model coverage statistics
 */
export interface ModelCoverageStats {
  embeddingCount: number;
  coveragePercent: number;
  missingCount: number;
}

/**
 * Memory embedding status for /ensemble/memories/:id/embeddings endpoint
 */
export interface MemoryEmbeddingStatus {
  modelId: ModelId;
  hasEmbedding: boolean;
  dimensions: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/**
 * A/B test result for /ensemble/ab-results endpoint
 */
export interface ABTestResult {
  id: string;
  testId: string;
  config: string;
  queryId: string;
  metrics: Record<string, unknown>;
  timestamp: Date;
}

// ============================================================================
// Fallback Types
// ============================================================================

/**
 * Fallback configuration
 */
export interface FallbackConfig {
  minModelsRequired: number;
  anchorModel: ModelId | null;
  allowPartialResults: boolean;
  modelTimeoutMs: number;
  cacheEnabled: boolean;
  cacheTtlMs: number;
}

/**
 * Default fallback configuration
 */
export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  minModelsRequired: 1,
  anchorModel: 'bge-base',
  allowPartialResults: true,
  modelTimeoutMs: 3000,
  cacheEnabled: true,
  cacheTtlMs: 60000,
};
