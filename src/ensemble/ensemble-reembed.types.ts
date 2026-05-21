/**
 * Ensemble Re-embedding Types
 *
 * Nightly batch re-embedding, event-triggered re-embedding,
 * drift detection, and embedding version types.
 */

import type { ModelId } from './ensemble-model.types';

// ============================================================================
// Nightly Re-embedding Types
// ============================================================================

/**
 * Re-embed job mode
 */
export type ReembedMode = 'incremental' | 'full';

/**
 * Re-embed job status
 */
export type ReembedJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Re-embed job configuration
 */
export interface ReembedJobConfig {
  mode: ReembedMode;
  models: ModelId[];
  batchSize: number;
  checkpointInterval: number;
  dryRun?: boolean;
  driftCheck?: boolean;
}

/**
 * Re-embed job progress
 */
export interface ReembedProgress {
  totalMemories: number;
  processedMemories: number;
  currentBatch: number;
  totalBatches: number;
  currentModel: ModelId | null;
}

/**
 * Checkpoint for resumable re-embedding
 */
export interface ReembedCheckpoint {
  jobId: string;
  createdAt: Date;
  lastProcessedId: string;
  progress: ReembedProgress;
  completedModels: ModelId[];
  metrics: Partial<ReembedMetrics>;
}

/**
 * Re-embed job metrics
 */
export interface ReembedMetrics {
  totalDurationMs: number;
  avgBatchDurationMs: number;
  memoriesProcessed: number;
  memoriesSkipped: number;
  memoriesFailed: number;
  perModel: Record<ModelId, ModelMetrics>;
  drift: DriftSummary;
}

/**
 * Per-model metrics
 */
export interface ModelMetrics {
  memoriesProcessed: number;
  totalDurationMs: number;
  avgLatencyMs: number;
  errors: number;
  latencyMs: number[];
}

/**
 * Drift analysis for a single memory/model pair
 */
export interface DriftAnalysis {
  memoryId: string;
  model: ModelId;
  cosineDrift: number;
  oldEmbeddingVersion: string;
  newEmbeddingVersion: string;
  flagged: boolean;
}

/**
 * Summary of drift across a batch
 */
export interface DriftSummary {
  measured: boolean;
  avgCosineDrift: number;
  maxCosineDrift: number;
  memoriesWithHighDrift: number;
  driftThreshold: number;
  byModel: Record<ModelId, { avg: number; max: number; flagged: number }>;
}

/**
 * Re-embed job state
 */
export interface ReembedJobState {
  jobId: string;
  startedAt: Date;
  status: ReembedJobStatus;
  progress: ReembedProgress;
  checkpoint: ReembedCheckpoint | null;
  metrics: ReembedMetrics;
  estimatedCompletion: Date | null;
}

/**
 * Re-embed job result
 */
export interface ReembedJobResult {
  jobId: string;
  status: ReembedJobStatus;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  memoriesProcessed: number;
  memoriesFailed: number;
  avgDrift: number;
  error?: string;
}

// ============================================================================
// Event-Triggered Re-embedding Types
// ============================================================================

/**
 * Event types that can trigger re-embedding
 */
export type ReembedEventType =
  | 'lesson_created'
  | 'user_correction'
  | 'entity_change'
  | 'importance_upgrade'
  | 'model_added'
  | 'manual';

/**
 * Priority levels for re-embed events
 */
export type ReembedEventPriority = 'high' | 'normal' | 'low';

/**
 * Scope for event-triggered re-embedding
 */
export interface ReembedEventScope {
  memoryIds?: string[];
  searchQuery?: string;
  userId?: string;
  entityIds?: string[];
  memoryTypes?: string[];
}

/**
 * Event that triggers re-embedding
 */
export interface ReembedEvent {
  eventId: string;
  type: ReembedEventType;
  priority: ReembedEventPriority;
  createdAt: Date;
  processedAt?: Date;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  scope: ReembedEventScope;
  triggeredBy: string;
  reason: string;
  error?: string;
}

// ============================================================================
// Embedding Version Types
// ============================================================================

/**
 * Embedding version metadata
 */
export interface EmbeddingVersionInfo {
  versionId: string;
  createdAt: Date;
  createdBy: 'nightly' | 'manual' | 'model-upgrade' | 'event';
  status: 'creating' | 'active' | 'deprecated' | 'deleted';
  memoriesEmbedded: number;
  previousVersion: string | null;
  modelVersions: ModelVersionInfo[];
}

/**
 * Model version within an embedding version
 */
export interface ModelVersionInfo {
  modelId: ModelId;
  modelVersion: string;
  checksum: string;
}
