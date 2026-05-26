# Temporal Anchoring for Memories

**Status:** Draft
**Branch:** TBD (target: new branch off `main`, e.g. `feat/temporal-anchoring`)
**Owner:** Rook
**Date:** 2026-05-26

## Why

LongMemEval scored **32.3%** on the `temporal-reasoning-ability` subset in Run 1 (43/133) and roughly **38%** in Run 2. This is Engram's weakest category by a wide margin. Investigation traces the failure to a single architectural gap: **memories have no concept of *when the event they describe occurred*, only when they were written to the database.**

Concretely, the `memories` table has `createdAt` (and `updatedAt`), both populated from the system clock at write time. Any relative temporal reference inside a memory's content — "yesterday", "last Tuesday", "two months ago", "before the kids were born" — has no anchor to resolve against. At recall time, the retrieval and prompt layers either:

1. silently anchor relative phrases to the *recording* timestamp (wrong whenever the speaker's "now" differs from the system "now"), or
2. ignore temporal references entirely and rely on lexical/embedding match (which is what the eval is actually measuring as 32%).

The problem is most acute under **bulk ingest**. LongMemEval's questions are dated 2023–2024 but get ingested today (2026-05-26). Every "yesterday" inside those questions, if resolved against `createdAt`, points to *2026-05-25* — completely poisoning the corpus. The same hazard applies to any historical import: Slack backfills, email archives, prior-session conversation imports, conversational dataset evals.

The fix is to model time as a first-class concept with multiple distinct axes, and to require callers to supply the speaker's reference point on bulk ingest rather than silently falling back to system time.

## What Changes

### 1. Memory temporal field model

Three distinct timestamp axes on `Memory`, plus a structured set of extracted event times:

- **`recordedAt`** *(new, renamed from `createdAt`)* — when Engram wrote the row. System clock, immutable, audit trail. Replaces the current `createdAt` semantically; column rename + back-compat alias.
- **`updatedAt`** *(existing, semantics clarified)* — last mutation to the memory body. System clock.
- **`observedAt`** *(new)* — when the event being remembered actually happened from the speaker's perspective. **This is the anchor that relative phrases inside the content resolve against.** For real-time agent capture, equals `recordedAt`. For bulk import, supplied by the caller per-memory.
- **`temporalAnchorSource`** *(new, enum)* — provenance of `observedAt`:
  - `EXPLICIT_CALLER` — caller passed `observedAt` in the request
  - `INFERRED_FROM_CONTENT` — derived from an explicit date in the content itself
  - `FALLBACK_RECORDED_AT` — no anchor available; copied from `recordedAt` (default for real-time capture)
- **`eventTimes` (1:N relation)** *(new)* — extracted temporal references from the content. One row per reference:
  - `surface` (the original phrase: "yesterday", "last Tuesday")
  - `resolvedInstant` *or* `resolvedRangeStart` + `resolvedRangeEnd`
  - `anchor` (which `observedAt` value it was resolved against)
  - `confidence` (`HIGH` for explicit dates, `MEDIUM` for unambiguous relatives, `LOW` for fuzzy)
  - `extractor` (`REGEX`, `DATEPARSER`, `LLM`)

### 2. Ingest contract

- `POST /v1/memories` and `POST /v1/sync/push` accept optional `observedAt` (ISO 8601) per memory.
- If `observedAt` is absent and `source` indicates real-time capture (`AGENT_OBSERVATION`, `USER_MESSAGE`, `INTERNAL`), default `observedAt = recordedAt` and set anchor source to `FALLBACK_RECORDED_AT`.
- If `observedAt` is absent and `source` indicates bulk/historical import (`BACKFILL`, `IMPORT`, new `HISTORICAL` enum value), **refuse relative-reference extraction** rather than poisoning with `recordedAt`. The row is still stored; `eventTimes` is empty for relatives; explicit dates extracted from content are still kept.
- Add a new `source = HISTORICAL` value to the existing memory source enum to make bulk-import callers explicit. LongMemEval sync uses this.

### 3. Extraction pipeline

Two-pass extraction runs as part of the existing memory processing job, gated by `observedAt` availability:

- **Pass 1 (cheap, always runs):** regex + `dateparser` for explicit dates ("May 25 2026", "2024-01-15", "2024-Q3"). Writes to `eventTimes` with `extractor = REGEX` or `DATEPARSER`, confidence `HIGH`.
- **Pass 2 (LLM, only when pass 1 finds relative candidates AND `observedAt` is trusted):** an LLM call resolves relative phrases ("yesterday", "last Friday", "two months ago") against `observedAt`. Writes to `eventTimes` with `extractor = LLM`, confidence `MEDIUM` or `LOW`.
- Pass 2 is **skipped** when `temporalAnchorSource = FALLBACK_RECORDED_AT` *and* `source` is historical. This is the core safety rule that prevents bulk-load poisoning.

### 4. Recall integration

- Recall API gains optional `timeFilter` parameter (instant or range).
- pgvector search results are post-filtered/boosted by `eventTimes` overlap with the query's time filter.
- Query-side temporal extraction runs the same pass-1 regex/dateparser on the query string at recall time, with `observedAt` = request timestamp.
- Scoring: memories with a confident `eventTimes` match get a boost; conflicts (memory says 2024-01, query asks 2023-06) get a small penalty. Exact tuning lives in design.md.

### 5. Schema migration

- Add `observed_at`, `temporal_anchor_source` columns to `memories`. Backfill `observed_at = created_at`, `temporal_anchor_source = FALLBACK_RECORDED_AT` for existing rows.
- Add `memory_event_times` table with FK to `memories`.
- Rename `created_at` → `recorded_at` is **deferred** (large index churn risk). Keep `created_at` as the column name, treat it as `recordedAt` semantically in code, add a comment in the schema. Re-evaluate after Phase 5.
- All migrations run via `prisma migrate deploy`. No `migrate dev`/`migrate reset` on cloud DB (per MEMORY.md hard rule).

### 6. Eval harness

- LongMemEval sync script gets a flag `--observed-at-from <field>` to pass each question's original timestamp as `observedAt`.
- Run the eval again with anchoring on; the `temporal-reasoning-ability` score is the gate metric.
- Target: **>50% on temporal-reasoning** (lift from 32–38% baseline) before this change is considered done.

## What's Out of Scope

- Time-zone disambiguation beyond storing offsets. We store everything as UTC instant and surface the original TZ string if present.
- Backfilling `eventTimes` for the ~14k existing cloud memories. Spec'd as a follow-up; existing memories keep `temporalAnchorSource = FALLBACK_RECORDED_AT` and can be re-extracted lazily.
- Recurring/cyclical temporal expressions ("every Tuesday", "monthly"). Phase-2 work.
- Changing the embedding model or per-model schema (covered by `embed-pipeline-overhaul`).
