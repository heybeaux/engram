/**
 * Shared recall ranking primitives.
 *
 * Two defects motivated this module (see
 * docs/research/memory-formation-query-transform/04-finding-tie-domination.md):
 *
 * 1. The keyword-rescue paths in `memory-query.service.ts` assigned *constants*
 *    (1.25 for FTS/BM25, 1.1 for ILIKE). Every rescued candidate therefore had
 *    an identical score, so on a noisy corpus 18/20 queries ended in a
 *    5-or-more-way tie at the top score.
 * 2. Every score sort was a bare `(b.score ?? 0) - (a.score ?? 0)`. Because
 *    `Array.prototype.sort` is stable, ties were resolved by whatever order
 *    Postgres happened to return rows in — i.e. top-1 was decided by row order,
 *    not by relevance.
 *
 * This module fixes both: continuous *banded* rescue scores, and one explicit
 * deterministic comparator used by every score sort in the recall pipeline.
 */

/**
 * Score bands. Rescue hits deliberately sit ABOVE the cosine ceiling of 1.0 —
 * that inter-band priority is existing, intentional policy ("exact match
 * agrees" beats "semantically close") and is preserved verbatim here. Only the
 * ordering *within* each band changes: it used to be a constant, it is now
 * continuous.
 *
 *   cosine        (0.00 .. 1.00]
 *   ILIKE rescue  (1.00 .. 1.10]
 *   FTS rescue    (1.10 .. 1.25]
 *
 * The bands are half-open at the bottom and closed at the top, so they never
 * overlap and a rescue hit can never be demoted below the band it belongs to.
 */
export const ILIKE_RESCUE_BAND_BOTTOM = 1.0;
export const ILIKE_RESCUE_BAND_TOP = 1.1;
export const FTS_RESCUE_BAND_BOTTOM = 1.1;
export const FTS_RESCUE_BAND_TOP = 1.25;

/** RRF constant retained from the original (dead) BM25 fusion code. */
export const RRF_K = 60;

/**
 * Positional term derived from Reciprocal Rank Fusion, normalised so that
 * rank 0 → 1 and it decreases *strictly* monotonically with rank:
 *
 *   rrf(r)     = 1 / (RRF_K + r + 1)
 *   rrfNorm(r) = rrf(r) / rrf(0) = (RRF_K + 1) / (RRF_K + 1 + r)   ∈ (0, 1]
 *
 * This is what guarantees strictness: the quality signals below (ts_rank,
 * term coverage) can legitimately tie between near-duplicate memories, which
 * is exactly the regime the tie-domination finding is about.
 */
export function rrfNorm(rankIndex: number): number {
  return (RRF_K + 1) / (RRF_K + 1 + Math.max(0, rankIndex));
}

/** Weight split between the quality signal and the positional (RRF) signal. */
const QUALITY_WEIGHT = 0.9;
const POSITION_WEIGHT = 0.1;

/**
 * Map a Postgres `ts_rank` value into the FTS rescue band.
 *
 * Invariants:
 *  - the best FTS hit (rank 0, ts_rank == max) scores exactly
 *    `FTS_RESCUE_BAND_TOP` (1.25), so the pre-existing inter-band policy is
 *    unchanged;
 *  - the value is strictly decreasing in `rankIndex` (rows arrive ordered by
 *    `ts_rank DESC`), so two rescued candidates never tie;
 *  - the value is always > `FTS_RESCUE_BAND_BOTTOM` (1.10), i.e. an FTS rescue
 *    always outranks every ILIKE rescue and every cosine hit.
 *
 * `quality` is ts_rank normalised by the max ts_rank in the result set, so it
 * reflects *how well* the row matched rather than merely that it matched.
 */
export function ftsRescueScore(
  tsRank: number,
  maxTsRank: number,
  rankIndex: number,
): number {
  const safeTsRank = Number.isFinite(tsRank) ? Math.max(0, tsRank) : 0;
  const safeMax = Number.isFinite(maxTsRank) ? maxTsRank : 0;
  const quality = safeMax > 0 ? Math.min(1, safeTsRank / safeMax) : 1;
  const blended =
    QUALITY_WEIGHT * quality + POSITION_WEIGHT * rrfNorm(rankIndex);
  return (
    FTS_RESCUE_BAND_BOTTOM +
    (FTS_RESCUE_BAND_TOP - FTS_RESCUE_BAND_BOTTOM) * blended
  );
}

/**
 * Map an ILIKE lexical-rescue hit into the ILIKE band.
 *
 * The ILIKE SQL orders by `importance_score DESC, created_at DESC`, so unlike
 * FTS there is no relevance value to normalise. The quality signal is instead
 * *lexical coverage*: how many of the extracted rescue terms this row actually
 * contains. Coverage is computed in SQL (`SUM(CASE WHEN LOWER(raw) LIKE $n …)`)
 * so a row matching 3 of 3 terms outranks one matching 1 of 3.
 *
 * Invariants:
 *  - the value is strictly inside `(1.00, 1.10]`, so an ILIKE rescue always
 *    outranks any cosine hit (ceiling 1.0) and never reaches the FTS band;
 *  - full coverage at rank 0 scores exactly `ILIKE_RESCUE_BAND_TOP` (1.10);
 *  - the value is strictly decreasing in `rankIndex` at equal coverage.
 */
export function ilikeRescueScore(
  matchedTerms: number,
  totalTerms: number,
  rankIndex: number,
): number {
  const total = totalTerms > 0 ? totalTerms : 1;
  // A returned row matched at least one term by construction; clamp defensively
  // so a missing/garbled match count can never collapse the row to the floor.
  const matched = Math.min(total, Math.max(1, Math.floor(matchedTerms) || 1));
  const coverage = matched / total;
  const blended =
    QUALITY_WEIGHT * coverage + POSITION_WEIGHT * rrfNorm(rankIndex);
  return (
    ILIKE_RESCUE_BAND_BOTTOM +
    (ILIKE_RESCUE_BAND_TOP - ILIKE_RESCUE_BAND_BOTTOM) * blended
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * PROTOTYPE (feature-flagged, OFF by default): relative lexical rescue.
 *
 * See docs/research/memory-formation-query-transform/05-finding-band-inversion.md.
 *
 * The band design above places every lexical-rescue hit ABOVE the cosine
 * ceiling of 1.0. That makes the priority *categorical*: a weak lexical match
 * always outranks a strong semantic match, and the candidate's own cosine is
 * discarded as an ordering signal even when it is available. On a corpus whose
 * distractors restate the query verbatim, the entire band is distractors.
 *
 * Relative mode instead treats lexical agreement as a *bounded boost on the
 * semantic score* rather than a separate stratum:
 *
 *   score = cosine * (1 + maxBoost * quality)
 *
 * Consequences:
 *  - a lexical hit can promote a candidate, but a candidate with a much better
 *    cosine can still beat it (the boost is bounded by `maxBoost`);
 *  - the cosine ordering inside the rescued set is preserved instead of being
 *    overwritten by ts_rank, which is what the band does today;
 *  - all scores stay in the same numeric scale, so downstream stages
 *    (usage weighting, the fallback blend, the cross-encoder) compare like
 *    with like.
 *
 * Lexical-only candidates (matched by FTS/ILIKE but absent from the vector
 * pool) have no cosine to anchor to. They are admitted just below the best
 * observed cosine, so they enter the candidate pool but cannot displace the
 * best semantic hit.
 * ────────────────────────────────────────────────────────────────────────── */

/** Maximum multiplicative promotion an FTS/BM25 agreement may buy. */
export const RELATIVE_FTS_MAX_BOOST = 0.2;
/** Maximum multiplicative promotion an ILIKE coverage agreement may buy. */
export const RELATIVE_ILIKE_MAX_BOOST = 0.1;
/** Maximum multiplicative promotion the identity-profile rescue may buy. */
export const RELATIVE_IDENTITY_MAX_BOOST = 0.15;
/**
 * A lexical-only candidate (no vector hit) is anchored at this fraction of the
 * best observed cosine, so it can never outrank the best semantic hit.
 */
export const RELATIVE_LEXICAL_ONLY_ANCHOR = 0.9;

/**
 * Relative-mode rescue score.
 *
 * @param cosine    the candidate's own cosine similarity, or null/undefined if
 *                  it was not in the vector pool
 * @param quality   normalised lexical agreement in [0, 1] (ts_rank / max
 *                  ts_rank for FTS, matched/total terms for ILIKE)
 * @param rankIndex position in the lexical result set, used only as a strict
 *                  tie-break so two candidates never collide
 * @param maxBoost  the ceiling on the promotion this signal may buy
 * @param bestVector the best cosine observed in this query's vector pool,
 *                  used to anchor lexical-only candidates
 */
export function relativeRescueScore(
  cosine: number | null | undefined,
  quality: number,
  rankIndex: number,
  maxBoost: number,
  bestVector: number,
): number {
  const q = Number.isFinite(quality) ? Math.min(1, Math.max(0, quality)) : 0;
  // Positional term is deliberately tiny: it exists only to break exact ties.
  const positional = 1e-6 * rrfNorm(rankIndex);

  if (cosine != null && Number.isFinite(cosine) && cosine > 0) {
    return cosine * (1 + maxBoost * q) + positional;
  }

  // Lexical-only: no semantic evidence at all. Anchor strictly below the best
  // semantic hit so it is admitted to the pool but cannot win on lexical
  // agreement alone.
  const anchor =
    (Number.isFinite(bestVector) && bestVector > 0 ? bestVector : 0.5) *
    RELATIVE_LEXICAL_ONLY_ANCHOR;
  return anchor * (0.5 + 0.5 * q) + positional;
}

/** Minimal shape the comparator needs. Deliberately structural, not `Memory`. */
export interface RankableMemory {
  id?: string;
  score?: number | null;
  /** Raw cosine similarity from the vector search, when this candidate had one. */
  vectorScore?: number | null;
  importanceScore?: number | null;
  createdAt?: Date | string | null;
}

function timeValue(value: Date | string | null | undefined): number {
  if (value == null) return 0;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * The single deterministic ordering used by every score sort in the recall
 * pipeline. Key order:
 *
 *   1. score            desc
 *   2. vectorScore      desc  (cosine similarity, when available; candidates
 *                              with no vector hit sort after ones that have
 *                              one, since cosine ∈ [0,1] and missing → -1)
 *   3. importanceScore  desc
 *   4. createdAt        desc  (newer first)
 *   5. id               asc   (total order — this is the key that removes the
 *                              dependency on Postgres row order entirely)
 *
 * Because key 5 is unique, the comparator induces a *total* order: the same set
 * of candidates sorts identically regardless of the input array order. That is
 * the actual defect being fixed.
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

/** Non-mutating convenience wrapper around {@link compareByRankKeys}. */
export function sortByRank<T extends RankableMemory>(items: T[]): T[] {
  return [...items].sort(compareByRankKeys);
}
