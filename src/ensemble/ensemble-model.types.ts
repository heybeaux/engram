/**
 * Ensemble Model Types
 *
 * Core model configuration, embedding, and query/fusion types.
 */

/**
 * Supported embedding models
 */
export type ModelId =
  | 'bge-base'
  | 'nomic'
  | 'minilm'
  | 'gte-base'
  | 'openai-small'
  | 'openai-large'
  | 'cohere-v3'
  | 'kalm-v2';

/**
 * Model status in the registry
 */
export type ModelStatus = 'active' | 'shadow' | 'deprecated' | 'disabled';

/**
 * Query type for adaptive fusion
 */
export type QueryType =
  | 'factual'
  | 'conversational'
  | 'temporal'
  | 'entity'
  | 'procedural';

/**
 * Model configuration
 */
export interface ModelConfig {
  id: ModelId;
  dimensions: number;
  namespace: string; // Pinecone namespace for this model
  weight: number; // Fusion weight (default 1.0)
  maxTokens: number;
  queryPrefix?: string;
  documentPrefix?: string;
}

/**
 * Default model configurations
 */
export const MODEL_CONFIGS: Record<ModelId, ModelConfig> = {
  'bge-base': {
    id: 'bge-base',
    dimensions: 768,
    namespace: 'bge-base',
    weight: 1.0,
    maxTokens: 512,
  },
  nomic: {
    id: 'nomic',
    dimensions: 768,
    namespace: 'nomic',
    weight: 1.0,
    maxTokens: 8192,
    queryPrefix: 'search_query: ',
    documentPrefix: 'search_document: ',
  },
  minilm: {
    id: 'minilm',
    dimensions: 384,
    namespace: 'minilm',
    weight: 1.0,
    maxTokens: 256,
  },
  'gte-base': {
    id: 'gte-base',
    dimensions: 768,
    namespace: 'gte-base',
    weight: 1.0,
    maxTokens: 512,
  },
  'openai-small': {
    id: 'openai-small',
    dimensions: 1536,
    namespace: 'openai-small',
    weight: 1.0,
    maxTokens: 8191,
  },
  'openai-large': {
    id: 'openai-large',
    dimensions: 3072,
    namespace: 'openai-large',
    weight: 1.2,
    maxTokens: 8191,
  },
  'cohere-v3': {
    id: 'cohere-v3',
    dimensions: 1024,
    namespace: 'cohere-v3',
    weight: 1.0,
    maxTokens: 512,
    queryPrefix: '',
    documentPrefix: '',
  },
  'kalm-v2': {
    id: 'kalm-v2',
    dimensions: 896,
    namespace: 'kalm-v2',
    weight: 0, // disabled — latency regression (2026-02-21)
    maxTokens: 512,
  },
};

/**
 * All available models
 */
export const ALL_MODELS: ModelId[] = [
  'bge-base',
  'nomic',
  'minilm',
  'gte-base',
  'openai-small',
  'openai-large',
  'cohere-v3',
  'kalm-v2',
];

/**
 * Default active models (MVP)
 */
export const DEFAULT_ACTIVE_MODELS: ModelId[] = [
  'bge-base',
  'minilm',
  'nomic',
  'gte-base',
];

/**
 * Result from a single model query
 */
export interface ModelSearchResult {
  memoryId: string;
  model: ModelId;
  rank: number; // 1-indexed position in results
  score: number; // Raw similarity score (0-1)
}

/**
 * Fused result after RRF
 */
export interface FusedResult {
  memoryId: string;
  rrfScore: number;
  modelScores: Map<ModelId, { rank: number; score: number }>;
  appearsInModels: number; // Consensus count
}

/**
 * Embedding result from engram-embed
 */
export interface EmbeddingResult {
  model: ModelId;
  dimensions: number;
  embedding: number[];
  latencyMs: number;
}

/**
 * Multi-model embedding response
 */
export interface MultiEmbedResponse {
  embeddings: EmbeddingResult[];
  totalMs: number;
  errors?: EmbedError[];
}

/**
 * Embed error details
 */
export interface EmbedError {
  model: ModelId;
  error: string;
  recoverable: boolean;
}

/**
 * Ensemble query options
 */
export interface EnsembleQueryOptions {
  query: string;
  userId: string;
  limit?: number;
  k?: number; // RRF constant (default 60)
  weights?: Partial<Record<ModelId, number>>;
  models?: ModelId[]; // Specific models to query (default: all active)
}

/**
 * Ensemble query result
 */
export interface EnsembleQueryResult {
  results: FusedResult[];
  metadata: {
    queryTimeMs: number;
    modelsQueried: ModelId[];
    candidatesEvaluated: number;
    fusionAlgorithm: string;
  };
}

/**
 * Ensemble upsert options
 */
export interface EnsembleUpsertOptions {
  memoryId: string;
  content: string;
  userId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Ensemble configuration
 */
export interface EnsembleConfig {
  enabled: boolean;
  models: ModelId[];
  weights: Partial<Record<ModelId, number>>;
  rrfK: number; // RRF constant
  localEmbedUrl: string;
  consensusBoostEnabled: boolean;
  consensusBoostFactor: number;
}

/**
 * Scoring weights for final ranking
 */
export interface ScoringWeights {
  semantic: number;
  recency: number;
  importance: number;
  access: number;
  consensus: number;
}

/**
 * Default scoring weights
 */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  semantic: 0.5,
  recency: 0.15,
  importance: 0.2,
  access: 0.05,
  consensus: 0.1,
};
