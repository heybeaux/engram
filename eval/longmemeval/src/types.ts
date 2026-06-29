/**
 * LongMemEval dataset types.
 *
 * Based on the LongMemEval paper (ICLR 2025, xiaowu0162/longmemeval).
 * Categories: single-session-user, single-session-preference, multi-session-user,
 *             temporal-reasoning-ability, knowledge-update, single-session-assistant
 */

export type LmeCategory =
  | 'single-session-user'
  | 'single-session-preference'
  | 'multi-session-user'
  | 'temporal-reasoning-ability'
  | 'knowledge-update'
  | 'single-session-assistant';

export interface RoundEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** ISO timestamp for the round (present in some dataset variants) */
  timestamp?: string;
  /**
   * True for synthetic session-boundary markers woven into the history
   * (e.g. "--- Session 2 (2023/05/20) ---"). Marker entries are emitted
   * verbatim into the transcript with no role label.
   */
  marker?: boolean;
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
  /**
   * The date/time the question was asked (from the dataset's question_date field).
   * Critical for temporal-reasoning questions that ask "how many X ago…".
   */
  question_date?: string;
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
  /** Judge model ID (default: claude-opus-4-7, override via LONGMEMEVAL_JUDGE_MODEL) */
  judgeModel: string;
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
  /** Skip ingest — reuse sessions already in DB (IDs are deterministic: lme-{question_id}) */
  skipIngest?: boolean;
  /** Wait after ingest before recall so the async embedding queue catches up (default 8000ms) */
  postIngestWaitMs?: number;
  /** Ingest all questions up front (resumable manifest), then query with no per-question wait */
  batchIngest?: boolean;
  /** Concurrent ingest requests during the batch-ingest phase (default 4) */
  ingestConcurrency?: number;
}
