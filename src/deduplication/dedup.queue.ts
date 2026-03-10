export const DEDUP_QUEUE = 'dedup-pipeline';

export const DEDUP_JOBS = {
  PROCESS_BATCH: 'dedup:process-batch',
  PROCESS_BACKLOG: 'dedup:process-backlog',
} as const;

export interface DedupBatchJobData {
  /** The trigger source: 'cron', 'manual', 'backlog-drain' */
  trigger: 'cron' | 'manual' | 'backlog-drain';
  /** Batch size for candidate processing */
  batchSize?: number;
}

export interface DedupBacklogJobData {
  /** Minimum similarity for auto-approve */
  minSimilarity?: number;
  /** Minimum age in hours for auto-approve */
  minAgeHours?: number;
}
