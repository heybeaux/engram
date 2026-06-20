/**
 * Awareness / Waking Cycle configuration.
 *
 * All values are controlled via environment variables so operators can tune
 * behaviour without code changes. Defaults are conservative.
 */
export const DEFAULT_AWARENESS_SCHEDULE = '0 0 8,12,16,20 * * *';

export const AwarenessConfig = {
  /** Master feature flag — when false the module is a no-op. */
  enabled: process.env.AWARENESS_ENABLED === 'true',

  /**
   * Cron expression for the Waking Cycle scheduler.
   * Default: every 4 hours during waking hours.
   *
   * Nest/cron uses six fields: second minute hour day month weekday.
   * A value like "0 star-slash-4 8-23 * * *" means every 4 minutes,
   * not every 4 hours.
   */
  schedule: process.env.AWARENESS_SCHEDULE || DEFAULT_AWARENESS_SCHEDULE,

  // ── Resource budgets (per cycle) ──────────────────────────────────────
  maxDbQueries: int('AWARENESS_MAX_DB_QUERIES', 50),
  maxEmbeddingCalls: int('AWARENESS_MAX_EMBEDDING_CALLS', 10),
  maxLlmCalls: int('AWARENESS_MAX_LLM_CALLS', 3),
  cycleTimeoutMs: int('AWARENESS_CYCLE_TIMEOUT_MS', 60_000),
  maxInsightsPerCycle: int('AWARENESS_MAX_INSIGHTS_PER_CYCLE', 5),

  // ── Quality gates ─────────────────────────────────────────────────────
  minConfidence: float('AWARENESS_MIN_CONFIDENCE', 0.5),
  insightTtlDays: int('AWARENESS_INSIGHT_TTL_DAYS', 14),

  // ── Signal sources ────────────────────────────────────────────────────
  signals: (process.env.AWARENESS_SIGNALS || 'memory,github')
    .split(',')
    .map((s) => s.trim()),

  // ── GitHub signal config ──────────────────────────────────────────────
  github: {
    token: process.env.AWARENESS_GITHUB_TOKEN,
    repos: (process.env.AWARENESS_GITHUB_REPOS ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
  },

  // ── LLM model for insight generation (budget-friendly default) ───────
  llmModel: process.env.AWARENESS_LLM_MODEL || 'gpt-4o-mini',
};

// ── Helpers ───────────────────────────────────────────────────────────────
/** Parse an integer environment variable with a fallback default. */
function int(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

/** Parse a float environment variable with a fallback default. */
function float(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseFloat(v) : fallback;
}
