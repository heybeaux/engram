export const DREAM_CYCLE_QUEUE = 'dream-cycle';

export const DREAM_CYCLE_JOBS = {
  PENDING: 'dream-cycle:pending',
  TIERING: 'dream-cycle:tiering',
  CONSOLIDATION: 'dream-cycle:consolidation',
  PATTERNS: 'dream-cycle:patterns',
  CLUSTERING: 'dream-cycle:clustering',
  DRIFT: 'dream-cycle:drift',
  IDENTITY: 'dream-cycle:identity',
  REPORT: 'dream-cycle:report',
} as const;

export type DreamCycleJobName =
  (typeof DREAM_CYCLE_JOBS)[keyof typeof DREAM_CYCLE_JOBS];

export interface DreamCycleJobData {
  runId: string;
  userId: string;
  dryRun: boolean;
  maxLlmCalls?: number;
  maxMemories?: number;
  /** Cursor state passed from a completed parent stage to the next child */
  cursor?: DreamCycleCursor;
}

/**
 * Cursor-based state passed between stages so downstream jobs can
 * resume or react to upstream results without re-querying.
 */
export interface DreamCycleCursor {
  /** Number of LLM calls consumed by earlier stages */
  llmCallsUsed?: number;
  /** Rows touched by the previous stage */
  lastStageRowsTouched?: number;
  /** Arbitrary key/value bag for stage-specific state */
  stageState?: Record<string, unknown>;
}

/**
 * Per-stage timeout configuration (milliseconds).
 * Stages that involve LLM calls get longer timeouts.
 */
export const DREAM_CYCLE_STAGE_TIMEOUTS: Record<DreamCycleJobName, number> = {
  [DREAM_CYCLE_JOBS.PENDING]: 1_800_000, // 30 min — LLM merge evaluation
  [DREAM_CYCLE_JOBS.TIERING]: 600_000, // 10 min — pure DB
  [DREAM_CYCLE_JOBS.CONSOLIDATION]: 1_200_000, // 20 min — LLM summarisation
  [DREAM_CYCLE_JOBS.PATTERNS]: 1_800_000, // 30 min — LLM pattern extraction
  [DREAM_CYCLE_JOBS.CLUSTERING]: 900_000, // 15 min — vector math
  [DREAM_CYCLE_JOBS.DRIFT]: 600_000, // 10 min — analysis
  [DREAM_CYCLE_JOBS.IDENTITY]: 1_200_000, // 20 min — LLM identity
  [DREAM_CYCLE_JOBS.REPORT]: 120_000, // 2 min  — aggregation only
};
