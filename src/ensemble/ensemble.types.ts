/**
 * Ensemble Retrieval Types
 *
 * Multi-model embedding and RRF fusion types for improved memory retrieval.
 * Extended with nightly batch re-embedding support.
 *
 * This file is a barrel re-export for backward compatibility.
 * Types are now organized in focused files:
 *   - ensemble-model.types.ts      — Core model, embedding, query/fusion types
 *   - ensemble-reembed.types.ts    — Re-embedding, drift detection, embedding versions
 *   - ensemble-monitoring.types.ts — Registry, health/monitoring, API responses, fallback
 */

export * from './ensemble-model.types';
export * from './ensemble-reembed.types';
export * from './ensemble-monitoring.types';
