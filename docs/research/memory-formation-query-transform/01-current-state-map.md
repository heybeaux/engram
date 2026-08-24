# Current-State Map: Engram Memory Lifecycle (Ingestion → Recall)

**Scope:** Read-only audit of Engram's `staging` branch. No code or data modified.
**Date:** 2026-08-23 (revised same day after prototype-build verification)

> **Errata from the prototype build.** Three assumptions in the original revision
> were falsified by running against the live service. All are corrected inline:
> 1. **Local Engram serves on port `47291`, not `3001`.** Port 3001 is the
>    whalehawk provider-server (returns `Hello World!` at `/`, 404s on
>    `/v1/memories/*`). Verified: `47291` returns 401 on
>    `/v1/memories/embedding-status`; `3001` returns 404.
> 2. **`content` is a legacy alias for `raw`, not a second field** — see §4.
> 3. **The local embedder 500s under parallel recall** (`non-finite value
>    NaN/inf` from minilm) — see §7.
**Purpose:** Map the ingestion→recall data flow and identify intervention points for
(A) LLM-assisted memory formation at store time and (B) LLM-assisted query
transformation at recall time.

> File/line references are as observed during the audit against `staging`
> (base commit `7af144b3`). Line numbers drift; treat them as anchors, re-grep
> before editing.

---

## 1. Ingestion → Recall Data Flow

### Ingestion entry points (memory create)
- `POST /v1/memories` — single create (`memory-core.controller.ts` ~L74)
- `POST /v1/memories/batch` — synchronous batch (~L95)
- `POST /v1/memories/batch/async` — async batch via BullMQ, returns `jobId` (~L118)
- `POST /v1/memories/bulk` — high-volume insert (via `bulk.dto`)

### Write path (`memory-write.service.ts` `remember()` ~L66–330)
1. Fetch user context (accountId, display name) (~L78)
2. `ImportanceService.calculate()` from layer hint (~L95)
3. Confidence from `SOURCE_CONFIDENCE` map — `EXPLICIT_STATEMENT=1.0`,
   `AGENT_OBSERVATION=0.7`, etc. (~L100)
4. Resolve temporal anchor — `observedAt` (speaker "now") vs `createdAt` (server),
   `temporalAnchorSource` enum (~L157)
5. Insert `Memory` record (raw, layer, source, importance, confidence, tags,
   metadata) (~L163)
6. Emit temporal warnings (HISTORICAL without anchor) (~L186)
7. **HyPE generation** — fire-and-forget hypothetical-prompt-embedding (~L198)
8. **Async extraction + embedding** via `EmbeddingQueueProducer`, or sync via
   `MemoryPipelineService.extractAndEmbed()` (~L244)
9. Elasticsearch/BM25 index — fire-and-forget (~L308)
10. Contradiction detection via `CorrectionService` — fire-and-forget (~L297)

### Extraction (`extraction.service.ts`)
- Calls **`LLMService.json()`** with `EXTRACTION_PROMPT_TEMPLATE` (temp 0.2)
- Produces 5W1H: who/what/when/where/why/how + topics[], entities[], memoryType,
  per-field confidence
- Invoked inside `MemoryPipelineService.extractAndEmbed()` in parallel with
  embedding generation (~L67)

### Embedding generation
- `EmbedFacade.embedOne()` preferred (`memory/embedding.service.ts` ~L73);
  `LLMService.embed()` is the legacy fallback (can diverge if
  `EMBEDDING_PROVIDER` differs)
- Model ID via `resolveEmbeddingModelId()` (`embedding-model.util.ts` ~L14):
  `EMBEDDING_MODEL ?? VECTOR_SEARCH_MODEL ?? 'bge-base'`
- Dimension validation: 1536 (openai-small), 3072 (openai-large), 768 (bge-base),
  384 (minilm), 768 (nomic)
- **Circuit breaker** (~L26–106): 5 consecutive failures → 1-minute block;
  transient 503s (engram-embed backlog) don't count
- **Priority recall path** `generateForRecall()` (~L113): adds `X-Priority: recall`
  header to skip the batch queue, 5s timeout

### Vector storage
- Default **pgvector**: `memory_embeddings(memory_id, model_id, dimensions,
  embedding)`, unique `(memory_id, model_id)`
- Optional **Pinecone**
- Per-model tables (`feat/embed-per-model-tables`): `EmbeddingOpenaiSmall`,
  `EmbeddingBgeBase`, `EmbeddingMinilm`, `EmbeddingNomic`
  (`schema.prisma` ~L254)

---

## 2. Recall Path

### Recall endpoints (`memory-query.controller.ts`)
- `POST /v1/memories/query` — **canonical** (~L102); `response_format=structured`
  yields v2 shape
- `POST /v1/recall` — **deprecated** alias (~L264)
- `POST /v1/context` — session bootstrap (~L329)
- `POST /v1/recall/contextual` — mid-conversation w/ topic-shift detection (~L314)
- `POST /v1/memories/timeline` — chronological + temporal gap detection (~L417)

### Core algorithm (`memory-query.service.ts` `recall()` ~L67–430)
1. `TemporalParserService` parses temporal intent ("last week", "years ago") (~L115)
2. `EmbeddingService.generateForRecall()` — priority flag, 5s timeout (~L131)
3. **Candidate retrieval:**
   - **Temporal path** (~L155): adaptive window expansion (doubling span, 200ms
     timeout, min 5 results); blends semantic + temporal + importance; rerank
     pool of 120
   - **Standard path** (~L358): hybrid semantic + keyword.
     Vector via pgvector `embedding <=> query`, `score = 1 - distance`.
     BM25/tsvector rescue via `websearch_to_tsquery` (RRF k=60) + ILIKE fallback.
4. **Scoring composition** (~L350):
   `blendedScore = semanticScore × importanceScore` (× temporal factor on temporal
   path); `adjustedScore = blendedScore × recallWeight × importanceMultiplier`
   (`importanceMultiplier = 0.4` if `importanceScore < 0.35` else 1.0)
5. **Reranking** (`memory-query-ranking.service.ts` ~L224): cross-encoder (TEI
   reranker) normalizes to [0,1], then
   `finalScore = (rerankerScore × 0.85 + importanceScore × 0.15) × sentimentPenalty`;
   fallback blend uses cosine in place of reranker
6. **Graph recall merge** (~L71): `GraphRecallService` injects graph-traversed
   memories with **×1.2 boost** on dedup hits
7. **Insight surfacing** (~L112): INSIGHT-layer memories with sim > 0.3, boost
   `= semanticScore + importanceScore × 0.3`
8. **Deduplication** (SQL-level): `superseded_by_id IS NULL`,
   `searchable IS NOT FALSE`, `embedding_status != 'DUPLICATE'`,
   `is_duplicate_of IS NULL`

### Response shapes (`memory.types.ts`)
- Legacy `QueryResult`: `{recallId, memories[], queryTokens, latencyMs,
  multiQuery?, explanations?}` (~L78)
- Structured v2 `StructuredQueryResult`: typed `fact`, `source_session`,
  `confidence`, `timestamp`, `memory_type`, optional `ChainOfNotePrompt`

---

## 3. Score Semantics (⚠️ correctness smell)

- **Cosine** (`pgvector.provider.ts` ~L234): `score = 1 - (embedding <=> query)` →
  **[0,1]**, 1 = perfect match.
- **Keyword rescue** (`memory-query.service.ts` ~L446, ~L524): FTS-only hits are
  **hard-coded to 1.25**; ILIKE-only hits to **1.1** — deliberately above the
  [0,1] ceiling as penalty-free "exact-match agrees" overrides.
- **Graph recall** applies **×1.2**.
- **Net effect:** the 1.10/1.25 out-of-range scores the mnemon brief flagged, and
  wrong distractors tying correct memories at 1.25, come from these overrides.
  Scores are **relative sort ranks, not probabilities/thresholds.**
- **Client risk:** any consumer assuming a `[0,1]` threshold (e.g. a 0.5 cutoff)
  breaks on rescue hits. **Recommendation:** document scores as relative ranks;
  consider a separate calibrated confidence field. Worth a ticket regardless of
  the R&D outcome.

---

## 4. Data Model (what exists vs what formation needs)

### `Memory` (`schema.prisma` ~L134–287) — selected fields
- Identity: `id`, `userId`, `projectId?`, `sessionId?`
- Content: `raw`, `layer` (IDENTITY/SESSION/FACT/EVENT/INSIGHT/CONSTRAINT/LESSON)
- Extraction: `memoryType`, `typeConfidence`, `factKeys[]`
- Importance: `importanceScore`, `effectiveScore`, `importanceHint`
- Confidence: `confidence`, `source`
- Temporal: `observedAt`, `temporalAnchorSource`, `eventTimes[]`
- Embedding: `embeddingId`, `embeddingModel`, `embeddingStatus`
  (PENDING/EMBEDDED/DUPLICATE/FAILED), `isDuplicateOf?`, `parentMemoryId?`
- Lifecycle: `createdAt`, `updatedAt`, `deletedAt`, `ingestedAt`,
  `consolidatedAt`, `lastRetrievedAt`, `usedCount`, `retrievalCount`
- Consolidation: `supersededById`, `consolidatedInto`
- Classification: `durability`, `userPinned`, `userHidden`, `safetyCritical`
- Graph: `outgoingEdges[]`, `incomingEdges[]` (`MemoryEdge`)
- Visibility: `visibility` (PRIVATE/SHARED/ACCOUNT), `tags[]`, `metadata` (JSON)
- Dedup: `contentHash`

### Related
- `MemoryExtraction` — 5W1H + topics/factKeys/rawJson/memoryType/confidence
- `MemoryEmbedding` — `(memory_id, model_id, dimensions, embedding)`
- `MemoryEdge` (ENG-120) — `sourceMemoryId`, `targetMemoryId`, `edgeType`
  (RELATED_TO / CONTRADICTS / REINFORCES / SUPERSEDES …), `confidence`
- `MemoryEventTime` — resolved temporal references

### What formation would add

> **CORRECTION (2026-08-23, verified against source during prototype build).**
> An earlier revision of this document claimed `CreateMemoryDto` accepts `content`
> and `raw` as two independent fields, and that formed text could go in `content`
> with `raw` kept for provenance. **That is false.** `create-memory.dto.ts` (~L94)
> applies `@Transform(({ value, obj }) => value ?? obj.content)` to `raw`, and the
> adjacent comment reads *"Legacy alias: content -> raw (accepted but transformed
> to raw)"*. There is **no `content` column on `Memory`** — posting both discards
> `content`. Storing formed text in `content` would have been a **silent no-op**
> and would have invalidated intervention B.

- **Union must be realized inside the single embedded string.** The prototype
  stores `contextualPrefix + verbatimObservation` in `raw`, and records
  `prefixLength` in metadata so the original observation is recoverable
  **byte-for-byte** (`storedText.slice(prefixLength) === observation`, asserted at
  write time). This is precisely Anthropic's Contextual Retrieval shape and it
  preserves the raw-∪-derived property the CogCanvas result demands.
- Provenance rides in `metadata.formation = {promptVersion, model, prefixLength,
  constraintEchoes[]}`. A dedicated `MemoryFormation` table is the option if we
  later want it queryable — not needed for the MVP.

---

## 5. Likely Intervention Points

| Intervention | File / method | Anchor | Trigger |
|---|---|---|---|
| Formation (store) | `src/memory/formation.service.ts` (**new**) `formMemory()` | — | after `Memory.create`, before embedding enqueue |
| Formation (extract) | `MemoryPipelineService.extractAndEmbed()` | insert after ~L72 | post-extraction, pre-embedding (**preferred** — has extraction context) |
| Query transform (recall) | `src/memory/query-transform.service.ts` (**new**) `transformQuery()` | — | in `recall()` after temporal parse (~L115), before `generateForRecall()` |
| Query transform (expand) | `MemoryQueryService.recall()` | insert after ~L328 | post-vector-search, pre-rerank |

Both gate behind env flags (`ENABLE_MEMORY_FORMATION`, `ENABLE_QUERY_TRANSFORM`)
and follow the optional-`LLMService` injection pattern already used by
`InsightGeneratorService` / `ConsolidationService`. On flag=off or error, skip
the step and continue — no behavior change to the default path.

---

## 6. Existing LLM Usage (formation precedents)

1. **`ExtractionService.extract()`** — LLM 5W1H extraction (temp 0.2). This is
   the natural seam for a formation refinement pass.
2. **`InsightGeneratorService.synthesizeWithLlm()`**
   (`awareness/analysis/insight-generator.service.ts` ~L135) — pattern→INSIGHT
   synthesis, **budget-aware / maxLlmCalls-gated**. Reuse this gating pattern for
   formation cost control.
3. **`ConsolidationService.promoteRecurringPatterns()`** (~L68) — clustering +
   optional canonicalization; promotion chains via `supersededById`.
4. **`MemoryDedupService.findDuplicateV2()`** (~L61) — deterministic vector
   thresholds (0.93 auto-merge / 0.85 reinforce / 0.78 review); **no LLM**.

**Takeaway:** Engram already spends LLM calls at store time (extraction) and in
consolidation. Formation is a *second refinement pass*, not net-new plumbing, and
a clean feature-flag precedent already exists.

---

## 7. Infrastructure defects found during the prototype build

Both were surfaced by running the shims against live Engram + oMLX. Both are
**measurement hazards** — left unhandled they bias experimental results.

### 7.1 Local embedder 500s under parallel recall (biases intervention C downward)
Issuing sub-queries concurrently (which is exactly what query expansion does)
made the local embedder return 500 `non-finite value NaN/inf` from minilm. In the
first smoke run this forced arm C to fall back to baseline recall — i.e. **the
intervention silently degraded into the control**, which would have understated C
in the ablation. Mitigated in the harness with bounded retries + sub-query
concurrency limiting (second run: zero fall-backs). Any future arm that fans out
queries must keep this limiter or the comparison is invalid.

### 7.2 pgvector dimension mismatch on write (pre-existing, unrelated to this R&D)
Engram logs a dimension mismatch (**1536 vs 384**) on the write path — an
openai-small-shaped vector meeting a minilm-shaped column. This is independent of
the shims and predates them. It is the same *class* of failure as the known
`engram-embed` saturation bug (writes that silently end up with no usable
embedding → empty recall). **Recommend a ticket**; until resolved, pin and record
the embedder per run, and keep the `embedding-status` gate mandatory.

## Key implications for the R&D

- The binding constraint the mnemon data exposes is **ranking under noise** and
  **corpus hygiene** (duplicates/incompleteness), not representation poverty. The
  existing hybrid+rerank+RRF stack is where our actual bottleneck lives.
- **Query transformation (C)** has a ready seam: `StructuredQueryResult.multiQuery`
  + `explanations` + `X-Query-Id` already exist — instrument, don't rebuild.
- **Formation (B)** should follow **union storage** (raw ∪ derived), never replace
  `raw` — consistent with both the schema (retain `raw`, fill `content`) and the
  external negative result on artifact-replacement (see research memo §1, §3).
- The **1.25/1.10 score overrides** are a real correctness smell; file a ticket
  independent of this initiative.
