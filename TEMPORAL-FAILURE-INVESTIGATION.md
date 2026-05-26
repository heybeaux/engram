# Temporal Failure Investigation

Updated: 2026-05-25
Owner: Pax
Branch: `fix/temporal-extraction-pipeline-ab`
Related repos:
- `heybeaux/engram`
- `heybeaux/engram-embed`

## Goal

Recover trustworthy LongMemEval temporal results by identifying the actual failure chain before making more fixes.

## Rules

1. No code change without a linked hypothesis.
2. Every probe updates this file with result and conclusion.
3. Separate harness failures from backend failures.
4. Prefer smallest reproducer over full reruns.
5. Track repo ownership explicitly when a failure crosses service boundaries.

## Current Failure Matrix

| Area | Symptom | Evidence | Status |
| --- | --- | --- | --- |
| Temporal projection | Temporal answers collapsed toward ingest time | Structured recall emitted `createdAt` instead of original source timestamp | Fixed earlier, needs final runtime confirmation |
| Eval readiness | Harness silently graded empty response after readiness timeout | `waitForSessionReadiness()` timeout path reproduced and tested | Fixed earlier |
| Eval session isolation | "Fresh" runs reused static `lme-{question_id}` identifiers | Reproduced in ingest path; patched with per-run scoped IDs | Fixed earlier |
| Eval judge | Numeric gold answers crashed scorer with `trim is not a function` | Reproduced during temporal first-5 rerun | Fixed locally |
| Extraction backlog | Fresh ingest produced huge pending/failed counts | Earlier run showed `10 COMPLETE / 190 FAILED / 672 PENDING` after ~2m | Partially addressed by A+B follow-up |
| Recall 500s | `/v1/memories/query` returns HTTP 500 during temporal reruns | Fresh reruns still show recall 500s | Active |
| Vector storage/query | Postgres rejects vector input with `22P02 invalid input syntax for type vector` | Live server log; Prisma `P2010` in `PgVectorProvider.search()` | Active |
| Hierarchy interaction | Disabling hierarchy reduced failure count but did not eliminate 500s | With `HIERARCHY_ENABLED=false`, temporal first-5 improved from `4x 500 + 1 crash` to `3x 500 + 2 wrong-empty` | Active contributing factor |
| Local embed integrity | `engram-embed` intermittently returns 768-length arrays of all `null` under load | Direct reproducer against `http://127.0.0.1:8080/v1/embeddings` | Active primary suspect |
| Engram validation boundary | Engram accepts raw embedding arrays from provider and serializes them directly into pgvector literals | `LocalEmbedProvider` returns `item.embedding` blindly; `PgVectorProvider` uses `join(',')` blindly | Active primary suspect |

## Timeline

1. Temporal score dropped to `0/16`, then `1/16`, revealing timestamp projection bug.
2. Structured recall timestamp precedence fixed.
3. Fresh rerun exposed harness readiness timeout bug.
4. Backend investigation found entity fan-out and lazy enqueue bottleneck.
5. Rook landed Fix A + Fix B + follow-up on `fix/temporal-extraction-pipeline-ab`.
6. Fresh rerun exposed ingest ID reuse bug in LongMemEval harness.
7. Fresh rerun exposed judge numeric-answer crash.
8. Current blocker is backend recall 500s with pgvector input/serialization failure.

## Working Hypotheses

### H1. `engram-embed` intermittently returns null-filled vectors under load

- Why it fits:
  - Direct concurrent probe against `engram-embed` reproduced the exact failure shape:
    - 15/20 responses returned arrays of length 768 with all elements `null`
    - 85/100 concurrent responses returned all-null embeddings
  - `PgVectorProvider` serializes vectors with `join(',')`, so an all-null array becomes the exact `"[,,,,]"` literal seen in logs.
  - This explains both write-time and read-time failures without needing DB corruption as the first cause.
- What would confirm it:
  - Sequential vs concurrent failure-rate comparison.
  - A guard in Engram rejecting null/non-finite embeddings before pgvector write, followed by disappearance of `22P02`.

### H2. Engram lacks embedding validation at the provider boundary

- Why it fits:
  - `LocalEmbedProvider` returns raw `item.embedding` arrays with no validation.
  - `EmbeddingService`, `MemoryPipelineService`, and `PgVectorProvider` do not verify length, finiteness, or nullability before write/search.
  - A single bad provider response propagates directly into a pgvector cast failure.
- What would confirm it:
  - Add temporary logging or a unit test around validation-free passage of null embeddings.

### H2a. `engram-embed` concurrency/device behavior may be corrupting tensor output before JSON serialization

- Why it fits:
  - The embed server uses shared lazy-loaded `Arc<Embedder>` instances stored in a `RwLock<HashMap<...>>`.
  - Standard BERT-family models are pushed through the Metal path by default.
  - The request handler runs model inference inline on the async server path; there is no isolation or validation between tensor output and JSON response.
- What would confirm it:
  - A reproducer that compares CPU vs Metal under the same concurrency.
  - A server-side assertion rejecting null/non-finite vectors before response serialization.

### H3. Hierarchy increases load and therefore amplifies the embed-server corruption rate

- Why it fits:
  - Disabling hierarchy reduced the number of recall 500s.
  - Hierarchy adds extra embedding work per memory, increasing concurrency/pressure on the same local embed server.
- What would confirm it:
  - Compare failure rate with hierarchy on/off at the same ingest concurrency.

### H4. LongMemEval-specific load pattern is exposing a general Engram bug

- Why it fits:
  - Temporal eval generates unusual volume and shape.
  - But the direct `engram-embed` reproducer shows the issue is broader than LongMemEval itself.
- What would confirm it:
  - Reproducer outside eval using a few handcrafted memories still causing vector/query errors.

## Probe Log

### 2026-05-25: Temporal first-5 rerun after branch restart

- Command class: `pnpm longmemeval --subset full --category temporal-reasoning-ability --limit 5`
- Result: `0/5`
- Breakdown:
  - `4` recall `500`s
  - `1` harness crash from numeric gold answer handling
- Conclusion:
  - Backend recall failures are primary.
  - Harness also had at least one independent bug.

### 2026-05-25: Judge numeric-answer patch

- File: `eval/longmemeval/src/judge.ts`
- Verification: targeted eval Jest passed
- Conclusion:
  - Removed one false-negative/crash source.

### 2026-05-25: Temporal first-5 rerun with `HIERARCHY_ENABLED=false`

- Result: `0/5`
- Breakdown:
  - `3` recall `500`s
  - `2` judged wrong with empty predictions
- Conclusion:
  - Hierarchy contributes to poisoning/failure rate.
  - Core recall/vector failure still exists with hierarchy disabled.

### 2026-05-25: Live server log review

- Error:
  - Prisma `P2010`
  - Postgres `22P02`
  - `invalid input syntax for type vector`
  - stack in `PgVectorProvider.search()`
- Conclusion:
  - Backend vector storage/serialization/query path is the current highest-value target.

### 2026-05-25: Write-time failure confirmed in memory pipeline

- Evidence:
  - `/v1/memories/bulk/text` log showed `MemoryPipelineService` embedding failure with the same malformed vector literal.
- Conclusion:
  - This is not only a recall-path/search-path issue.
  - Corruption is happening before or during embedding writes.

### 2026-05-25: Direct `engram-embed` stress reproducer

- Probe:
  - Direct concurrent calls to `http://127.0.0.1:8080/v1/embeddings`
- Result:
  - `15/20` bad under one short concurrent run
  - `85/100` bad under a larger concurrent run
  - Bad responses were arrays of length `768` with all elements `null`
  - Sequential run of `50` calls still produced `1` bad response
- Conclusion:
  - Primary cause is upstream of pgvector: the local embedding server can emit null-filled vectors.
  - Concurrency/load strongly amplifies the failure rate.
  - Engram still needs defensive validation because one bad provider response currently becomes a hard backend failure.

### 2026-05-25: Known-good control probes

- Probe:
  - Single direct calls to `engram-embed` with short text and with raw text from a previously failed memory
- Result:
  - Returned valid `768`-dimensional numeric vectors with zero null/non-finite values
- Conclusion:
  - Failure is intermittent/load-sensitive, not a deterministic “this text always breaks” bug.

## Parallel Ownership

### Track A: Backend vector corruption path

- Owner: open
- Scope:
  - `src/vector/providers/pgvector.provider.ts`
  - embedding write/read call sites
  - hierarchy write path
- Deliverable:
  - exact failing path
  - smallest reproducer
  - ranked likely fixes

### Track A1: `engram-embed` integrity path

- Owner: open
- Scope:
  - `heybeaux/engram-embed`
  - request handling
  - model registry/shared state
  - tensor-to-JSON conversion
  - Metal vs CPU behavior under load
- Deliverable:
  - exact failure mode for null vectors
  - smallest standalone reproducer
  - recommended server-side guardrails

### Track B: Eval and harness correctness

- Owner: open
- Scope:
  - `eval/longmemeval/*`
  - verify remaining results are trustworthy once backend stabilizes
- Deliverable:
  - list of remaining harness distortions
  - minimal rerun protocol

### Track C: External reference patterns

- Owner: open
- Scope:
  - how mature pgvector-backed memory/retrieval stacks serialize/store/query vectors
  - how they isolate hierarchy/summarization writes from primary recall path
- Deliverable:
  - comparable implementations or design patterns worth stealing

## Immediate Next Steps

1. Reproduce the `engram-embed` null-vector failure with CPU vs Metal and low vs high concurrency.
2. Add Engram-side validation/rejection for null/non-finite/wrong-dimension embeddings before pgvector writes or searches.
3. Instrument and reproduce `PgVectorProvider` write/search failures locally with validated vs unvalidated vectors.
4. Trace hierarchy-on vs hierarchy-off code paths to isolate why hierarchy amplifies failure rate.
5. Freeze further "score chasing" reruns until we have a clean backend reproducer and a safe concurrency envelope.
