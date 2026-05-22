# S2 — Key Expansion with Extracted Facts

## Summary

At write time, LLM-extracted facts from `MemoryExtraction` should be embedded as additional vector keys for each memory record — not just the raw text. This gives the vector index multiple entry points per memory, surfacing relevant records for queries that would miss the raw wording but match the extracted fact. LongMemEval shows +4% Recall@k and +5% downstream QA accuracy over raw-key-only baselines.

## Motivation

**Paper finding:** Using LLM-extracted atomic facts as *additional* vector keys (alongside the raw text key) is the highest-leverage single improvement for recall quality. The extracted fact is a distilled, declarative statement that matches recall queries more directly than a verbose conversational passage.

**Current Engram state:**
- `ExtractionService` (`src/memory/extraction.service.ts`) already runs 5W1H extraction at write time and stores results in `MemoryExtraction` (`prisma/schema.prisma:291`).
- `MemoryExtraction` stores `who`, `what`, `when`, `whereCtx`, `why`, `how`, `topics` — these are queryable facts but are **not embedded**.
- `EmbeddingService` (`src/memory/embedding.service.ts`) embeds only the raw `Memory.raw` field.
- The consolidation / dream-cycle path marks derivative memories as `searchable=false` (ENG-94), so consolidated facts are invisible to recall.
- Result: retrieval relies entirely on embedding similarity to the raw passage.

## Proposed Change

### 1. Add `factKeys` column to `MemoryExtraction`

```prisma
// prisma/schema.prisma — MemoryExtraction model
factKeys       String[]   @default([]) @map("fact_keys")    // LLM-distilled atomic facts
factKeyVectors Json?      @map("fact_key_vectors")          // optional: store embedding IDs per fact
```

Migration file: `prisma/migrations/YYYYMMDD_add_fact_keys_to_memory_extractions/migration.sql`

```sql
ALTER TABLE "memory_extractions" ADD COLUMN "fact_keys" TEXT[] NOT NULL DEFAULT '{}';
```

### 2. Generate fact keys in `ExtractionService`

Extend the extraction prompt (`src/memory/extraction-prompt.ts`) to return a `fact_keys` array: 2–5 declarative sentences each <20 words derived from the raw text. Example output:
```json
{ "fact_keys": ["User prefers dark mode.", "Project deadline is 2026-06-01."] }
```

Parse and persist into `MemoryExtraction.factKeys`.

### 3. Embed fact keys alongside raw text

In `EmbeddingQueueProcessor` (`src/memory/embedding-queue.processor.ts`), after embedding `raw`, iterate `extraction.factKeys` and embed each. Store embedding IDs in `factKeyVectors` (JSON map `{ factKey: embeddingId }`).

For multi-key search: use pgvector's `ORDER BY embedding <-> $query LIMIT k` union pattern or insert each fact key as a sibling row with `searchable=true` and a FK back to the parent memory via a new `parentMemoryId` field.

**Simpler alternative (recommended for v1):** Insert each fact key as a `MemoryType=FACT_KEY` child memory row with `searchable=true` and `parentMemoryId` pointing to the original. This reuses the entire existing embedding + recall pipeline with zero new query-path changes.

### 4. De-duplicate fact-key children on re-ingestion

Gate on `contentHash` (already computed at write time) to prevent duplicate fact-key rows when the same memory is re-indexed.

## Acceptance Criteria

- Each memory with a successful extraction produces 2–5 `FACT_KEY` child rows with `searchable=true` and `parentMemoryId` set.
- Recall query for a distilled fact (e.g. "deadline June 2026") surfaces the parent memory with score >= the raw-key baseline.
- Benchmark: LongMemEval Recall@20 must increase >= 1% vs. raw-key-only baseline; target +3–4%.
- No regression on P@5 (must stay >= 98.1%).
- Unit tests: extraction prompt returns non-empty `fact_keys`; embedding processor creates child rows; dedup prevents re-insertion on duplicate content hash.

## Migration / Rollout Plan

- `factKeys` defaults to `[]` — no behavioural change until extraction prompt is updated.
- Feature flag: `ENABLE_FACT_KEY_EXPANSION=true` gates the child-row insertion step.
- Backfill: can replay `MemoryExtraction` rows through the updated extraction prompt as a background job (existing `BackfillService` pattern).
- No changes to recall query path for v1 — child rows are first-class memories and surface naturally.

## Open Questions / Risks

- **Extraction cost:** Each memory already pays one LLM call for 5W1H. Adding `fact_keys` extends the prompt output but not call count. Watch token costs on high-volume accounts.
- **Fact hallucination:** LLM-extracted facts can be slightly wrong or over-generalised. Consider storing `typeConfidence` on child rows and filtering below 0.6.
- **Child-row inflation:** 5 fact keys × 1M memories = 5M new rows. Ensure pgvector HNSW index is sized appropriately and monitor storage.

## References

- LongMemEval (ICLR 2025), §3.2 Key Expansion ablation (+4% Recall@k)
- `src/memory/extraction.service.ts` — `extract()` method
- `src/memory/extraction-prompt.ts` — prompt template to extend
- `src/memory/embedding-queue.processor.ts` — embedding pipeline
- `prisma/schema.prisma` — `MemoryExtraction` model (line 291)
- ENG-94: `searchable=false` for dream-cycle derivatives (pattern to follow)
