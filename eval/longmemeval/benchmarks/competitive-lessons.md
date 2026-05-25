# Competitive Lessons From Backboard And OMEGA

**Reviewed:** May 24, 2026  
**Purpose:** Pull practical lessons from public LongMemEval writeups without copying benchmark theater.

## Sources Reviewed

- Backboard LongMemEval results:
  - https://github.com/Backboard-io/Backboard-longmemEval-results
- OMEGA benchmark leaderboard:
  - https://omegamax.co/benchmarks
- OMEGA benchmark report:
  - https://omegamax.co/docs/benchmark-report
- LongMemEval paper:
  - https://arxiv.org/abs/2410.10813

## What Looks Useful

- **Benchmark hygiene**
  - Public category breakdowns, judge details, and reproducibility notes make the result legible.
  - Engram should keep publishing run date, dataset variant, judge model, generation model, hardware, and artifact paths for every official run.

- **Separate retrieval quality from end-to-end QA**
  - OMEGA splits official LongMemEval scoring from an internal retrieval benchmark.
  - Engram should do the same so we can tell whether a miss came from retrieval, temporal modeling, or answer synthesis.

- **Hybrid retrieval is the baseline**
  - OMEGA publicly describes a blend of BM25/full-text plus vectors, then reranking and freshness logic.
  - This matches the direction Engram needs: exact phrase recovery, semantic retrieval, and a post-retrieval ranking pass.

- **Knowledge updates should be first-class**
  - OMEGA’s public materials emphasize outdated information handling.
  - Engram should treat mutable facts as versioned state, not just unrelated memories that happen to mention the same entity.

- **Graph-style relationships matter more than generic continuity**
  - Useful relationships are things like `supersedes`, `contradicts`, `same_event`, and `related_to`.
  - These are more relevant to LongMemEval than a broad project/task arc abstraction by itself.

## What Not To Copy Blindly

- **Backboard’s published setup is not normal product usage**
  - Their repo explicitly says they fed the maximum possible conversation history in a single message for apples-to-apples benchmarking.
  - That makes the score useful as a ceiling, but not a direct blueprint for day-to-day Engram behavior.

- **Time decay is not the same as temporal reasoning**
  - Freshness weighting can help with knowledge updates.
  - It does not solve questions like "what happened yesterday" or "which event happened first" if event time is not stored explicitly.

- **Leaderboard claims need version discipline**
  - OMEGA publicly shows different LongMemEval figures in different places.
  - The lesson for Engram is not "they are wrong"; it is "we should keep one dated, versioned benchmark trail so our own numbers stay coherent."

## Engram-Specific Read

- Our worst gap is still **event-time structure**.
  - We need resolved event dates and ranges, not only memory creation timestamps.

- Our next gap is **multi-memory reasoning**.
  - Count, sum, dedupe, and ordered reconstruction need to become explicit retrieval/reasoning helpers.

- Our third gap is **latest-valid-state recall**.
  - A mutable fact should surface with a confidence that the newest valid memory supersedes earlier ones.

- **Continuity arcs are not the first lever**
  - They may help later for task/project continuity.
  - They are not the most direct fix for current LongMemEval misses.

## Bottom Line

- Keep LongMemEval as Engram’s official public baseline.
- Add a second internal retrieval benchmark.
- Work in two phases:
  1. fix score trustworthiness first
  2. then improve product behavior
- Product priority after the harness is clean:
  1. event-time resolution
  2. multi-memory aggregation
  3. mutable-fact supersession
  4. hybrid retrieval + reranking
- Treat continuity arcs as a follow-on advantage, not the immediate benchmark unlock.
