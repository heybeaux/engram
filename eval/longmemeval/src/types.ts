/**
 * LongMemEval dataset types.
 *
 * Based on the LongMemEval paper (ICLR 2025, xiaowu0162/longmemeval).
 * Categories: single-session-user, multi-session-user, temporal-reasoning-ability,
 *             knowledge-update, single-session-assistant
 */

export type LmeCategory =
  | 'single-session-user'
  | 'multi-session-user'
  | 'temporal-reasoning-ability'
  | 'knowledge-update'
  | 'single-session-assistant';

export interface RoundEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** ISO timestamp for the round (present in some dataset variants) */
  timestamp?: string;
}

export interface LongMemEvalQuestion {
  question_id: string;
  question: string;
  /** Gold answer — may be null/empty for abstention-category questions */
  answer: string;
  category: LmeCategory;
  /** The session history that should be ingested before answering */
  session_history: RoundEntry[];
  /** Optional: pre-split into multiple sessions (for multi-session questions) */
  sessions?: RoundEntry[][];
}

export interface LmeDataset {
  questions: LongMemEvalQuestion[];
}

/** Per-question result after judging */
export interface QuestionResult {
  questionId: string;
  question: string;
  expected: string;
  predicted: string;
  correct: boolean;
  category: LmeCategory;
  /** E2E latency from ingest to answer in ms */
  latencyMs: number;
  judgeReasoning?: string;
  /** ISO timestamp when this question was completed (set when streamed to JSONL) */
  timestamp?: string;
}

/** Per-category aggregate */
export interface CategoryScore {
  total: number;
  correct: number;
  accuracy: number;
}

/** Top-level summary written to summary.json */
export interface SummaryReport {
  runAt: string;
  subset: 'smoke' | 'full' | string;
  totalQuestions: number;
  correctCount: number;
  accuracy: number;
  byCategory: Record<string, CategoryScore>;
  questions: QuestionResult[];
}

/** Config for a single harness run */
export interface RunConfig {
  /** Engram API base URL (default: http://localhost:3000) */
  apiBase: string;
  /** API key for Engram */
  apiKey: string;
  /** Anthropic API key for judge + reading model */
  anthropicApiKey: string;
  /** Reading model ID (default: claude-opus-4-7) */
  readModel: string;
  /** Judge model ID (always claude-opus-4-7, not configurable) */
  judgeModel: 'claude-opus-4-7';
  /** Max questions to evaluate (undefined = all) */
  limit?: number;
  /** Filter to a single category */
  category?: LmeCategory;
  /** Dataset subset to use */
  subset: 'smoke' | 'full';
  /** Output path for summary.json */
  outputPath: string;
  /** Path to JSONL results file (created fresh, or reused via --resume) */
  resultsPath: string;
  /** True when resuming an existing JSONL file */
  resume: boolean;
}
