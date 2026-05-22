# S3 — Time-Aware Query Expansion

## Summary

When a recall query contains temporal cues ("last week", "before the migration", "in March"), automatically narrow the vector search to a time-bounded window *before* doing cosine similarity ranking. ENG-131 / PR #244 shipped `TemporalParserService` which already detects temporal intent and builds a `createdAt` filter — this spec closes the remaining gap: expanding the temporal window adaptively and injecting it into *all* recall paths, not just the primary `MemoryQueryService.recall` path.

## Motivation

**Paper finding:** Time-aware retrieval improves temporal recall by +7–11 absolute points on LongMemEval's temporal-reasoning ability category (the hardest single category, ~15% of questions). The key technique is using the query timestamp + extracted temporal cues to pre-filter candidates before vector ranking.

**Current Engram state:**
- `TemporalParserService` (`src/memory/temporal/temporal-parser.service.ts`) parses expressions like "last week", "yesterday", "2 hours ago" → `TemporalFilter { start, end }`.
- `MemoryQueryService.recall` (`src/memory/memory-query.service.ts:110`) calls `temporalParser.parse()` and applies a `createdAt` filter when temporal intent is detected — **this path works**.
- **Gaps:**
  1. `ContextualRecallService.recall` (`src/memory/contextual-recall.service.ts`) does *not* call `TemporalParserService` — no temporal narrowing on the streaming recall path.
  2. Temporal window is fixed to the parsed expression boundaries. For vague queries ("recent", "a while back"), the window should expand adaptively (e.g. try last 7 days, widen to 30 if < N results).
  3. `temporalParser.parse` only matches pre-defined patterns. Relative expressions tied to agent-known events ("before the deployment last Tuesday") are not handled.

## Proposed Change

### 1. Inject `TemporalParserService` into `ContextualRecallService`

```typescript
// src/memory/contextual-recall.service.ts
constructor(
  private readonly prisma: PrismaService,
  private readonly embedding: EmbeddingService,
  private readonly temporalParser: TemporalParserService,  // add
  ...
)
```

In `ContextualRecallService.recall`, parse `dto.text` for temporal intent and apply the same `createdAt` filter used in `MemoryQueryService`.

### 2. Adaptive window expansion

```typescript
// src/memory/temporal/temporal-parser.service.ts — new method
expandWindow(filter: TemporalFilter, multiplier: number): TemporalFilter {
  const mid = (filter.start.getTime() + filter.end.getTime()) / 2;
  const halfSpan = (filter.end.getTime() - filter.start.getTime()) / 2;
  return {
    ...filter,
    start: new Date(mid - halfSpan * multiplier),
    end:   new Date(mid + halfSpan * multiplier),
  };
}
```

In `MemoryQueryService.recall`, after the initial temporal query, if `temporalMemories.length < dto.limit * 2`, retry with `expandWindow(filter, 2.0)` (double the window), up to `MAX_EXPAND=3` passes. Log each expansion.

### 3. Event-anchored temporal expressions (v2 stretch goal)

For queries like "before the production deploy", resolve the anchor event by running a quick recall against `MemoryType=EVENT` memories, extracting the event's `createdAt`, and using it as the temporal boundary. Track in a follow-up ticket.

### 4. Env flags

```
TEMPORAL_QUERY_ADAPTIVE=true       # enable adaptive expansion (default: true)
TEMPORAL_QUERY_MIN_RESULTS=5       # threshold below which expansion triggers (default: 5)
TEMPORAL_QUERY_MAX_EXPAND=3        # max expansion passes (default: 3)
```

## Acceptance Criteria

- `ContextualRecallService.recall` applies temporal filtering when `dto.text` contains temporal cues.
- Adaptive expansion: a narrow window returning 0 results expands to produce >= 1 result when matching memories exist in a wider window.
- Benchmark: LongMemEval temporal-reasoning ability category recall must improve >= 5 pts vs. current baseline; target +7.
- No regression on non-temporal queries (P@5 stays >= 98.1%).
- Unit tests: `expandWindow` doubles span correctly; `ContextualRecallService` applies filter from temporal parser; expansion halts at `MAX_EXPAND`.

## Migration / Rollout Plan

- `TEMPORAL_QUERY_ADAPTIVE` defaults to `true` but can be set `false` to restore current behaviour.
- `ContextualRecallService` change is additive — no API contract changes.
- Ship behind a test in `contextual-recall.service.spec.ts` before enabling in production.
- No Prisma migration, no new DB columns.

## Open Questions / Risks

- **Latency:** Adaptive expansion is up to 3 serial DB queries. Add a hard timeout (`TEMPORAL_QUERY_TIMEOUT_MS=200`) and fall back to non-temporal recall if exceeded.
- **Pattern coverage:** `TemporalParserService` regex patterns cover common English expressions but miss non-English and domain-specific phrases. Consider an LLM-assisted fallback for unmatched queries (costs one LLM call per unmatched temporal query).
- **`TEMPORAL_GAP` marker interference:** ENG-131 markers are `searchable=false`, so they never appear in recall results — confirmed safe. However, markers' `createdAt` should not be used as the "last memory" anchor for temporal window calculations.

## References

- LongMemEval (ICLR 2025), §3.3 Time-Aware Retrieval (+7–11% temporal recall)
- ENG-131 / PR #244 — `TemporalGapMarkerService`, `TemporalParserService`
- `src/memory/temporal/temporal-parser.service.ts` — `parse()`, `calculateTemporalRelevance()`, `blendScores()`
- `src/memory/memory-query.service.ts:110` — existing temporal filter application
- `src/memory/contextual-recall.service.ts` — gap: no temporal parsing
