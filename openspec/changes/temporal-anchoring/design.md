# Design: Temporal Anchoring

## Core insight

`createdAt` is the wrong anchor for relative temporal references inside memory content. The right anchor is **the speaker's "now" at the moment of utterance**, which is only the same as `createdAt` for real-time capture. Bulk/historical import breaks the equivalence and silently poisons every relative reference in the corpus.

Three axes are not interchangeable and must be modeled separately:

| Axis | Source | Mutable? | Use |
|---|---|---|---|
| `recordedAt` (current `createdAt`) | System clock at write | No | Audit, dedup, sync ordering |
| `updatedAt` | System clock at mutation | Yes | Cache invalidation, sync |
| `observedAt` | Caller-supplied OR equal to `recordedAt` | Rare | **Anchor for relative phrases** |

A fourth concept — `eventTimes[]` — is the *output* of extraction: structured times mentioned inside the content, resolved against `observedAt`.

## Anchor source enum

```prisma
enum TemporalAnchorSource {
  EXPLICIT_CALLER       // caller passed observedAt
  INFERRED_FROM_CONTENT // an unambiguous explicit date in the content set observedAt
  FALLBACK_RECORDED_AT  // no anchor; observedAt = recordedAt (default for real-time capture; flag for bulk)
}
```

Storing the provenance is the linchpin. Downstream code (extraction pass 2, recall scoring, eval reporting) gates on this field to decide whether `observedAt` is trustworthy. Without it we'd have no way to distinguish a real-time capture from a poisoned bulk-load row after the fact.

## Schema additions

```prisma
model Memory {
  // ... existing fields ...

  observedAt           DateTime?              @map("observed_at")
  temporalAnchorSource TemporalAnchorSource   @default(FALLBACK_RECORDED_AT) @map("temporal_anchor_source")
  eventTimes           MemoryEventTime[]

  @@index([userId, observedAt])
  @@index([observedAt])
}

model MemoryEventTime {
  id                 String              @id @default(cuid())
  memoryId           String              @map("memory_id")
  memory             Memory              @relation(fields: [memoryId], references: [id], onDelete: Cascade)

  surface            String              // original phrase
  resolvedInstant    DateTime?           @map("resolved_instant")
  resolvedRangeStart DateTime?           @map("resolved_range_start")
  resolvedRangeEnd   DateTime?           @map("resolved_range_end")

  anchor             DateTime            // the observedAt this was resolved against
  confidence         EventTimeConfidence
  extractor          EventTimeExtractor

  createdAt          DateTime            @default(now()) @map("created_at")

  @@index([memoryId])
  @@index([resolvedInstant])
  @@index([resolvedRangeStart, resolvedRangeEnd])
  @@map("memory_event_times")
}

enum EventTimeConfidence { HIGH MEDIUM LOW }
enum EventTimeExtractor  { REGEX DATEPARSER LLM }
```

`observedAt` is nullable in the table because backfilled rows may genuinely have no anchor, but the API layer treats `null` → `recordedAt` for query convenience.

## Ingest contract

**Real-time capture (existing flow, unchanged externally):**
```
POST /v1/memories
{ content, type, layer, source: "AGENT_OBSERVATION" | "USER_MESSAGE" | "INTERNAL", ... }
→ observedAt defaults to NOW(), anchor = FALLBACK_RECORDED_AT, both passes run
```

**Real-time with explicit anchor (new):**
```
POST /v1/memories
{ content, ..., observedAt: "2026-05-25T18:30:00-07:00" }
→ anchor = EXPLICIT_CALLER, both passes run
```

**Historical/bulk import (new):**
```
POST /v1/sync/push  OR  POST /v1/memories
{ content, ..., source: "HISTORICAL", observedAt: "2024-01-15T14:00:00Z" }
→ anchor = EXPLICIT_CALLER, both passes run, eventTimes anchored to 2024-01-15
```

**Historical without anchor (refusal mode):**
```
POST /v1/memories
{ content, ..., source: "HISTORICAL" }
→ anchor = FALLBACK_RECORDED_AT, pass 1 runs (explicit dates only), pass 2 SKIPPED
→ Response includes warning: "relative_extraction_skipped: no observedAt for HISTORICAL source"
```

The refusal-mode design is deliberate: it's the *only* way to prevent the LongMemEval-class poisoning. We trade silent corpus poisoning for explicit caller responsibility.

## Two-pass extraction

**Pass 1 (`extractor = REGEX | DATEPARSER`, confidence `HIGH`):**
- Patterns: ISO 8601, `YYYY-MM-DD`, "January 15, 2024", "Jan 15", "2024-Q3", "in 2024"
- Pure functions, deterministic, fast (<5ms per memory)
- Always runs, regardless of `observedAt` availability
- Output: any explicit dates found, anchored to `observedAt` if available (for "Jan 15" → which year?) or left as year-ambiguous if not

**Pass 2 (`extractor = LLM`, confidence `MEDIUM | LOW`):**
- Triggers: pass 1 found relative-phrase candidates ("yesterday", "last X", "N ago", "tomorrow", "this morning")
- Skipped when: `temporalAnchorSource = FALLBACK_RECORDED_AT` AND `source ∈ HISTORICAL/BACKFILL/IMPORT`
- LLM prompt: given content + `observedAt`, return JSON array of `{ surface, resolved_instant|range, confidence }`
- Model: Claude Haiku (cheap, fast, structured output)
- Output: rows with `extractor = LLM`

Both passes write to the same `memory_event_times` table. The two-pass design keeps the LLM call optional and gated, which both saves cost and provides the safety mechanism for historical loads.

## Recall integration

Recall API extension:
```
POST /v1/recall
{
  query: "what did I do last week",
  timeFilter: { rangeStart: "2026-05-19", rangeEnd: "2026-05-25" }  // optional
}
```

If `timeFilter` is absent, the query string itself runs through pass-1 extraction at recall time (anchored to `now()`) and a derived filter is applied with low confidence weight.

Scoring layer changes:
- Base: existing pgvector cosine + reranker score
- Temporal boost: `+α` if any `eventTimes` row falls within the filter window
- Temporal penalty: `-β` if memory has confident `eventTimes` outside the window AND the query had a confident time filter
- `α`, `β` tunable; start at `α=0.05, β=0.10`; tune via LongMemEval

This avoids hard-filtering (which would drop memories whose extraction missed a relative phrase) in favour of soft ranking with a penalty for *confident contradictions*.

## Migration plan

1. Add `observed_at`, `temporal_anchor_source` columns + `memory_event_times` table (new migration, `prisma migrate deploy` only)
2. Backfill: `UPDATE memories SET observed_at = created_at, temporal_anchor_source = 'FALLBACK_RECORDED_AT'` (single statement, runs in migration)
3. Code path 1: ingest writes new fields, recall reads them (extraction stub initially returns empty `eventTimes`)
4. Code path 2: pass-1 extractor enabled (deterministic, low risk)
5. Code path 3: pass-2 LLM extractor enabled behind a feature flag (`TEMPORAL_LLM_EXTRACTION=true`)
6. Re-run LongMemEval, measure delta on `temporal-reasoning-ability`, then on `multi-session-user`
7. Re-extract existing high-priority memories in a background job (Phase 2 of this change; not gated by initial release)

`created_at` column is **not renamed** in this change. We re-evaluate after Phase 6 — renaming a heavily-indexed column on the cloud DB has migration risk that isn't worth bundling here.

## Failure modes and mitigations

| Risk | Mitigation |
|---|---|
| LLM extraction hallucinates dates | Confidence field; recall layer down-weights `LOW` confidence; eval gates on real metric not LLM output |
| Pass 2 cost explodes | Trigger only on pass-1 relative-phrase hits; bulk-load with no anchor skips it entirely; per-account rate limit |
| Bulk import without `observedAt` silently poisons (the bug we're fixing) | Refuse extraction; surface warning in API response; new `HISTORICAL` source enum forces explicit caller choice |
| Time zone ambiguity | Store everything as UTC instant; preserve original offset string in `surface` field for audit |
| Existing memories get re-extracted incorrectly | Backfill job is separate phase, opt-in per user, dry-run-first |
| `observedAt` index churn at scale | Add indexes in migration before backfill; backfill is a single bounded UPDATE not a row-by-row job |

## Alternatives considered

- **Single `eventAt` field, no `observedAt`/`eventTimes` split.** Rejected: conflates the anchor (one value per memory) with extracted references (many values per memory). Can't represent "I went to the cafe yesterday and last Tuesday" without losing one.
- **LLM-only extraction (no pass 1).** Rejected: cost and latency. Explicit dates don't need an LLM.
- **Hard-filter recall by time window.** Rejected: extraction coverage will be imperfect; soft scoring degrades more gracefully.
- **Compute `observedAt` from content at ingest, no caller field.** Rejected: bulk imports of conversational data often have no explicit date in the content; the dataset metadata is the only source of truth. Caller must pass it.
