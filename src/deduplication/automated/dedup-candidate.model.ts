/**
 * Automated Dedup Pipeline — shared types and thresholds
 */

export type DetectionMethod = 'VECTOR' | 'TEXT';

export type DedupClassification =
  | 'DUPLICATE'
  | 'SUPPORTING'
  | 'OVERLAPPING'
  | 'CONFLICTING'
  | 'RELATED';

export type AutoCandidateStatus = 'PENDING' | 'CLASSIFIED' | 'RESOLVED';

/** pgvector cosine similarity threshold for candidate creation */
export const COSINE_THRESHOLD = 0.88;

/** Normalised Levenshtein similarity threshold */
export const LEVENSHTEIN_THRESHOLD = 0.9;

/** Minimum confidence for DUPLICATE / SUPPORTING auto-merge */
export const AUTO_MERGE_CONFIDENCE = 0.7;

/** Minimum confidence for OVERLAPPING auto-consolidation (high) */
export const AUTO_CONSOLIDATE_CONFIDENCE_HIGH = 0.9;

/** Minimum confidence for OVERLAPPING auto-consolidation (low — queues below this) */
export const AUTO_CONSOLIDATE_CONFIDENCE_LOW = 0.7;

/** Default look-back window for candidate detection (hours).
 *  Override via DEDUP_DETECTION_WINDOW_HOURS env var. */
export const DEFAULT_DETECTION_WINDOW_HOURS = 24;
