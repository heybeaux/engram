/**
 * Shared recall ranking primitives (ported from PR #324 onto the #328 base).
 *
 * Every score sort in the recall pipeline used a bare
 * `(b.score ?? 0) - (a.score ?? 0)`. `Array.prototype.sort` is stable, so ties
 * were resolved by whatever order Postgres happened to return rows in — heap
 * order, which is not stable across restarts, VACUUMs or plan changes.
 *
 * #328 already replaced the flat keyword-rescue constants (1.25 / 1.1 / 1.15)
 * with RRF priors and removed the sticky post-rerank re-add, so #324's banded
 * rescue scores and rerank scale fix are not ported. What remains useful is the
 * total-order comparator and the SQL `id ASC` tiebreak, both gated behind
 * `RECALL_DETERMINISTIC_RANKING=true` (default off: byte-identical ordering).
 */

/** Minimal shape the comparator needs. Deliberately structural, not `Memory`. */
export interface RankableMemory {
  id?: string;
  score?: number | null;
  /** Raw cosine similarity from the vector search, when this candidate had one. */
  vectorScore?: number | null;
  importanceScore?: number | null;
  createdAt?: Date | string | null;
}

/** Read at call time so tests and eval arms can toggle it per process. */
export function isDeterministicRankingEnabled(): boolean {
  return process.env.RECALL_DETERMINISTIC_RANKING === 'true';
}

function timeValue(value: Date | string | null | undefined): number {
  if (value == null) return 0;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** The shipped comparator: score desc, ties left in input order. */
export function compareByScore(a: RankableMemory, b: RankableMemory): number {
  return (b.score ?? 0) - (a.score ?? 0);
}

/**
 * Deterministic total order. Key order:
 *
 *   1. score            desc
 *   2. vectorScore      desc  (missing → -1, so vector hits beat lexical-only)
 *   3. importanceScore  desc
 *   4. createdAt        desc  (newer first — on an exact tie the more recent
 *                              fact wins, which is the knowledge-update case)
 *   5. id               asc   (unique, so the order is total)
 */
export function compareByRankKeys(
  a: RankableMemory,
  b: RankableMemory,
): number {
  const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
  if (scoreDelta !== 0) return scoreDelta;

  const vectorDelta = (b.vectorScore ?? -1) - (a.vectorScore ?? -1);
  if (vectorDelta !== 0) return vectorDelta;

  const importanceDelta = (b.importanceScore ?? 0) - (a.importanceScore ?? 0);
  if (importanceDelta !== 0) return importanceDelta;

  const createdDelta = timeValue(b.createdAt) - timeValue(a.createdAt);
  if (createdDelta !== 0) return createdDelta;

  const idA = a.id ?? '';
  const idB = b.id ?? '';
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

/** Comparator for the current flag state. */
export function recallRankComparator(): (
  a: RankableMemory,
  b: RankableMemory,
) => number {
  return isDeterministicRankingEnabled() ? compareByRankKeys : compareByScore;
}

/**
 * `, <col> ASC` fragment appended to rescue `ORDER BY` clauses, or the empty
 * string when the flag is off — so flag-off SQL is character-identical.
 */
export function rescueSqlTiebreak(column = 'id'): string {
  return isDeterministicRankingEnabled() ? `, ${column} ASC` : '';
}
