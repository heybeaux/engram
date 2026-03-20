export const DREAM_CYCLE_QUEUE = 'dream-cycle';

export const DREAM_CYCLE_JOBS = {
  PENDING: 'dream-cycle:pending',
  TIERING: 'dream-cycle:tiering',
  PATTERNS: 'dream-cycle:patterns',
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
}
