# Tasks: Temporal Anchoring

Sequencing: Phase 1 ships the field model and ingest contract (no behavior change to recall). Phase 2 adds deterministic extraction. Phase 3 adds the LLM pass behind a flag. Phase 4 wires recall scoring. Phase 5 re-runs LongMemEval and tunes. Phase 6 is the lazy backfill of existing memories.

## Phase 1 — Schema + ingest contract

- **T1.** Add Prisma model changes: `Memory.observedAt`, `Memory.temporalAnchorSource`, `MemoryEventTime`, `EventTimeConfidence` enum, `EventTimeExtractor` enum, `TemporalAnchorSource` enum. Add `HISTORICAL` value to existing memory source enum.
- **T2.** Generate migration with `prisma migrate dev` against a local scratch DB (NOT cloud), inspect SQL, then apply to staging via `prisma migrate deploy`. Backfill statement: `UPDATE memories SET observed_at = created_at, temporal_anchor_source = 'FALLBACK_RECORDED_AT' WHERE observed_at IS NULL`.
- **T3.** Update `POST /v1/memories` DTO to accept optional `observedAt` (ISO 8601). Validate it parses; reject future-dated `observedAt` more than 1 hour ahead of `now()` (clock skew tolerance).
- **T4.** Update `POST /v1/sync/push` DTO equivalently.
- **T5.** Ingest service: set `observedAt`, `temporalAnchorSource` correctly per the matrix in design.md. Unit tests cover all four cases (real-time-no-anchor, real-time-with-anchor, historical-with-anchor, historical-no-anchor).
- **T6.** API response: when `source = HISTORICAL` and `observedAt` is missing, include a `warnings: ["relative_extraction_skipped"]` array in the response. Document in api-spec.json.
- **T7.** Update `MEMORY_INSTRUCTIONS.md` and SDK examples to mention `observedAt` for historical imports.

## Phase 2 — Pass-1 extraction (deterministic)

- **T8.** Implement `TemporalExtractorPass1` service. Inputs: content string, `observedAt`. Output: `MemoryEventTime[]`. Patterns:
  - ISO 8601 (`2024-01-15T...`)
  - `YYYY-MM-DD`
  - `MMM D, YYYY` / `MMM D` / `MMMM D, YYYY`
  - `YYYY-Q[1-4]`
  - `in YYYY`
- **T9.** Hook pass-1 into the existing memory processing job (post-ingest). Idempotent: re-running over a memory with existing pass-1 rows is a no-op.
- **T10.** Unit tests: 30+ cases including ambiguous month/year, partial dates with `observedAt` to disambiguate.
- **T11.** Integration test: ingest a memory with `observedAt = 2024-06-15`, content "I'll meet them on Jan 15", expect `eventTimes[0].resolvedInstant = 2024-01-15` (anchored year, not 2026).

## Phase 3 — Pass-2 LLM extraction

- **T12.** Implement `TemporalExtractorPass2` service. Trigger: pass-1 found relative-phrase tokens (regex hit on `yesterday|today|tomorrow|last|next|ago|this (morning|afternoon|evening|week|month|year)`). Skip when `temporalAnchorSource = FALLBACK_RECORDED_AT` AND `source ∈ {HISTORICAL, BACKFILL, IMPORT}`.
- **T13.** LLM prompt template (Claude Haiku, structured JSON output). System prompt includes `observedAt` and asks for `{ surface, resolved_instant|range, confidence }` JSON only.
- **T14.** Feature flag: `TEMPORAL_LLM_EXTRACTION` env var, default `false`. Document in config.
- **T15.** Per-account rate limit (default 100 pass-2 calls/hour) to prevent cost surprises.
- **T16.** Unit tests with stubbed LLM responses. Integration test gated on flag + API key presence.

## Phase 4 — Recall integration

- **T17.** Add `timeFilter: { instant?, rangeStart?, rangeEnd? }` to recall request DTO.
- **T18.** Query-side pass-1 extractor: extract dates from query string at recall time, anchor to `now()`, build implicit `timeFilter` if explicit one absent.
- **T19.** Scoring layer: temporal boost/penalty as described in design.md. Initial constants `α=0.05`, `β=0.10`, both behind config.
- **T20.** Recall response includes `temporalEvidence: { matched: [...], conflicted: [...] }` for debug.
- **T21.** Existing recall regression tests must still pass (P@5 ≥ 98.1% on the gold queries).

## Phase 5 — Eval + tune

- **T22.** Extend LongMemEval sync script with `--observed-at-from <field>` flag. Default to the dataset's per-question timestamp field.
- **T23.** Re-run LongMemEval full subset with anchoring enabled (pass 1 only) and capture all 5 category scores.
- **T24.** Re-run with pass 2 enabled. Capture cost delta and category scores.
- **T25.** Tune `α`/`β` against the eval. Document final values + their measured effect in design.md.
- **T26.** Gate: `temporal-reasoning-ability ≥ 50%` (lift from 32–38% baseline). If gate not met, write a follow-up investigation and pause the change.
- **T27.** Update `engram-cloud-401` MEMORY.md entry resolution status if it's been fixed by Phase 5 timing.

## Phase 6 — Backfill (deferred, separate PR)

- **T28.** Design backfill job: opt-in per user, dry-run-first, surfaces estimated cost and row count before execution. Out of scope for the initial PR; spec'd here so it's not forgotten.

## Cross-cutting

- **T29.** Update `ARCHITECTURE.md` with the four temporal axes diagram.
- **T30.** OpenSpec validation: ensure proposal.md / design.md / tasks.md cross-reference correctly. Run any existing OpenSpec lint if present.
- **T31.** PR description must include before/after LongMemEval temporal-reasoning numbers and the cost-per-1k-memories impact of pass 2.

## Out of scope (tracked elsewhere)

- Time-zone normalization beyond UTC + offset preservation
- Recurring/cyclical expressions ("every Tuesday")
- Bulk re-extraction of existing 14k cloud memories (Phase 6)
- Renaming `created_at` → `recorded_at` column (deferred; re-evaluate post-launch)
