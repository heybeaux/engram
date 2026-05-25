# LongMemEval Improvement Checklist

**Created:** May 24, 2026  
**Purpose:** Ordered implementation plan following Baseline 1 and the competitive review.

## Working Rule

- Phase 1 is **score fix**: make the benchmark trustworthy before claiming improvement.
- Phase 2 is **product fix**: once the harness is clean, improve Engram behavior in the order most likely to move LongMemEval.

## P0. Benchmark Trustworthiness

1. Fix the scorer bug that throws on numeric gold answers such as `expected.trim is not a function`.
2. Eliminate empty-prediction and HTTP `500` benchmark failures before the next official rerun.
3. Record each official run with:
   - date
   - commit SHA
   - dataset variant
   - generation model
   - judge model
   - hardware
   - artifact paths
4. Add a lightweight internal retrieval-only benchmark so retrieval regressions are visible without running the full 500-question harness.

## P1. Temporal Modeling

5. Promote resolved event time to a first-class memory field, separate from write time.
6. Persist temporal metadata that captures:
   - original phrase such as `yesterday`
   - reference timestamp used for resolution
   - resolved absolute date or datetime
   - resolved start/end range when precision is fuzzy
7. Prefer event time in recall, ranking, and ordering logic, with write time only as fallback.
8. Add query helpers for:
   - before/after
   - between
   - nearest event to a date
   - ordered event reconstruction

## P2. Multi-Memory Reasoning

9. Add retrieval helpers for count, sum, difference, and dedupe across memories.
10. Introduce a same-event merge or clustering pass so repeated mentions do not inflate counts.
11. Add an explicit reasoning layer for multi-memory answers instead of relying on a plain retrieved list.

## P3. Knowledge Updates

12. Add mutable-fact versioning or relationships such as `supersedes` and `contradicts`.
13. Bias retrieval toward the newest valid state for update-style questions.
14. Preserve older states for auditability, but make latest-state recall the default answer path.

## P4. Retrieval Quality

15. Add exact phrase and keyword recovery alongside vector retrieval.
16. Add a reranking step after initial candidate recall.
17. Add type-aware weighting so preferences, identity facts, decisions, and updates can rank differently by question type.

## P5. Continuity And Arcs

18. Audit the current timeline/arc scaffolding and document what is real versus preparatory.
19. If arcs stay in scope, refocus them around memory relationships that help benchmark behavior:
   - `same_event`
   - `related_to`
   - `supersedes`
   - `contradicts`
20. Treat task/project continuity arcs as secondary until temporal and update handling improve.

## Next Official Rerun Gate

- Do not rerun the official 500-question benchmark until:
  - scorer bugs are fixed
  - empty/500 failures are resolved
  - event-time fields are live in recall
  - at least one aggregation pass exists for multi-memory questions

## Execution Order

1. Finish `P0. Benchmark Trustworthiness`.
2. Rerun the harness to establish a clean post-fix score.
3. Start product work in order: `P1 -> P2 -> P3 -> P4`.
4. Revisit `P5` only after the benchmark-critical product fixes land.
