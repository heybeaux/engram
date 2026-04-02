/**
 * Strategy for merging duplicate memories
 */
export enum MergeStrategy {
  KEEP_NEWEST = 'KEEP_NEWEST',
  KEEP_OLDEST = 'KEEP_OLDEST',
  KEEP_DETAILED = 'KEEP_DETAILED',
  KEEP_IMPORTANCE = 'KEEP_IMPORTANCE',
  COMBINE_METADATA = 'COMBINE_METADATA',
}

/**
 * Status of a merge candidate
 */
export enum CandidateStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SKIPPED = 'SKIPPED',
}

/**
 * Status of a batch dedup job
 */
export enum BatchJobStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/**
 * Safety reason types
 */
export enum SafetyReasonType {
  PROTECTED_TYPE = 'protected_type',
  PROTECTED_KEYWORD = 'protected_keyword',
  HIGH_IMPORTANCE = 'high_importance',
  REQUIRES_REVIEW = 'requires_review',
  RECENTLY_ACCESSED = 'recently_accessed',
  MANUALLY_EDITED = 'manually_edited',
}
