# Engram Elasticsearch Integration — Scope

**Date:** 2026-05-20
**Status:** DRAFT
**Branch target:** `staging`
**Author:** Engineering

---

## Background

Engram's recall pipeline runs hybrid search: pgvector cosine similarity fused with PostgreSQL tsvector/pg_trgm BM25 via Reciprocal Rank Fusion (RRF). The text leg of that pipeline has compounding structural problems that tsvector cannot solve without significant query-preprocessing overhead. Elasticsearch replaces the tsvector/pg_trgm path with a purpose-built BM25 engine while leaving pgvector untouched.

---

## Architecture

### Current pipeline

```
Query text
  │
  ├─► embed (OpenAI text-embedding-3-small, 1536-dim)
  │     └─► pgvector cosine search → vector candidates
  │
  ├─► HybridSearchService.textSearch()
  │     ├─► plainto_tsquery + ts_rank_cd on search_vector → FTS candidates
  │     └─► pg_trgm similarity (fuzzy fallback)
  │
  ├─► [inline BM25 block in memory-query.service.ts]   ← DUPLICATE / INCONSISTENT
  │     └─► websearch_to_tsquery on raw column
  │
  └─► ILIKE fallback (short/gibberish queries)

All candidates → RRF fusion (HybridSearchService.fuseResults)
             → optional cross-encoder rerank (RerankService)
             → score blending (MemoryQueryRankingService)
             → results
```

### Target pipeline

```
Query text
  │
  ├─► embed (OpenAI text-embedding-3-small, 1536-dim)
  │     └─► pgvector cosine search → vector candidates
  │
  └─► ElasticsearchService.search()
        └─► multi_match BM25 (memory_analyzer) → ES candidates
              (pool filter: pre-fetch IDs from memory_pool_memberships)

Both candidate lists → RRF fusion (HybridSearchService.fuseResults)  [unchanged]
                   → optional cross-encoder rerank (RerankService)   [unchanged]
                   → score blending (MemoryQueryRankingService)       [unchanged]
                   → results

ILIKE fallback retained: fires only when ES returns 0 results
```

### Component boundaries

```
┌────────────────────────────────────────────────────────────────┐
│  src/elasticsearch/                                            │
│    elasticsearch.module.ts   — global NestJS module            │
│    elasticsearch.service.ts  — client wrapper + index logic    │
│    elasticsearch.listener.ts — OnEvent handlers                │
│    elasticsearch.controller.ts — admin reindex endpoint        │
└────────────────────────────────────────────────────────────────┘
         │ injected (Optional)
         ▼
┌────────────────────────────────────────────────────────────────┐
│  src/vector/hybrid-search.service.ts                           │
│    textSearch() delegates to ES when ELASTICSEARCH_ENABLED     │
│    falls back to tsvector path when ES not configured          │
└────────────────────────────────────────────────────────────────┘
         │ orchestrates
         ▼
┌────────────────────────────────────────────────────────────────┐
│  src/memory/memory-query.service.ts                            │
│    inline BM25 block removed (lines ~237–343)                  │
│    ILIKE fallback retained                                     │
└────────────────────────────────────────────────────────────────┘
```

---

## Known Weaknesses Fixed by This Change

| Problem | Root cause | ES fix |
|---|---|---|
| Misses proper nouns / acronyms ("WhaleHawk", "ENG-42") | English stemmer conflates or drops them | `memory_exact` keyword subfield; `asciifolding` filter preserves exact tokens |
| Quoted phrase search broken | `plainto_tsquery` treats quotes as literals | `multi_match` with `phrase` type on `raw.exact` subfield |
| Ticket IDs ("bge-base", "ENG-42") not matched | Hyphen splits into stop-word territory | `keyword` tokenizer on `raw.exact` + `minimum_should_match` |
| No field-level boosting | pg tsvector is single-column | `raw^3, tags^2` field weighting in multi_match |
| Duplicate BM25 blocks with different query parsers | Organic growth; `plainto_tsquery` vs `websearch_to_tsquery` | Single ES call replaces both; one query parser |
| No aggregation/faceting without extra DB queries | Postgres lacks native search aggregations | ES aggregation bucket queries for future facet API |

---

## Task 1: Elasticsearch Client Module

### Goal

Establish the ES client as an injectable NestJS service. All other tasks depend on this.

### Solution

Install `@elastic/elasticsearch` v8 (peer with Node 18+, current Railway Node version). Create `src/elasticsearch/` as a global module so it is injectable across `VectorModule` and `MemoryModule` without circular imports.

```
src/elasticsearch/
  elasticsearch.module.ts
  elasticsearch.service.ts
  elasticsearch.listener.ts     (Task 3)
  elasticsearch.controller.ts   (Task 6)
  index.ts
```

`elasticsearch.module.ts` — registers `ElasticsearchService` and `ElasticsearchController`, marks itself `@Global()`. Client is constructed via `useFactory` from `ConfigService`.

`elasticsearch.service.ts` — public API surface:

```typescript
indexMemory(memory: MemoryDocument): Promise<void>
deleteMemory(id: string): Promise<void>
search(query: string, filters: EsSearchFilters, limit: number): Promise<Array<{ id: string; score: number }>>
bulkIndex(memories: MemoryDocument[]): Promise<BulkIndexResult>
healthCheck(): Promise<{ status: 'green' | 'yellow' | 'red' | 'unreachable' }>
isEnabled(): boolean
```

`isEnabled()` returns false when `ELASTICSEARCH_ENABLED !== 'true'` or when `ELASTICSEARCH_URL` is unset. All callers must check this before calling ES.

Startup: `onModuleInit()` calls `ensureIndex()` which creates the index with the mapping below if it does not exist. Uses `indices.exists` + `indices.create`. If ES is unreachable at startup, logs a warning and continues — the service is optional infrastructure.

### Files Changed

- `package.json` — add `@elastic/elasticsearch@^8`
- `src/elasticsearch/elasticsearch.module.ts` — new
- `src/elasticsearch/elasticsearch.service.ts` — new
- `src/elasticsearch/index.ts` — re-exports
- `src/app.module.ts` — import `ElasticsearchModule`

### Acceptance Criteria

- `ElasticsearchService` is injectable in any module
- When `ELASTICSEARCH_ENABLED=false` or URL is absent, all methods no-op and log a debug line
- `healthCheck()` returns `{ status: 'unreachable' }` (not throws) when ES is down
- Unit test: mock client, verify `ensureIndex` is called on init and skipped when index exists

---

## Task 2: Index Mapping

### Goal

Define the `engram_memories` index mapping so ES can score `raw` content, filter by tenant fields, and support exact-match subfields for proper nouns and IDs.

### Solution

Mapping defined as a constant in `elasticsearch.service.ts`, applied via `indices.create` on startup. Index name defaults to `engram_memories`, overridable via `ELASTICSEARCH_INDEX`.

```json
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 1,
    "analysis": {
      "analyzer": {
        "memory_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "english_stop", "english_stemmer"]
        },
        "memory_exact": {
          "type": "custom",
          "tokenizer": "keyword",
          "filter": ["lowercase"]
        }
      },
      "filter": {
        "english_stop": { "type": "stop", "stopwords": "_english_" },
        "english_stemmer": { "type": "stemmer", "language": "english" }
      }
    }
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "id":              { "type": "keyword" },
      "raw": {
        "type": "text",
        "analyzer": "memory_analyzer",
        "fields": {
          "exact": { "type": "keyword", "ignore_above": 8191 }
        }
      },
      "tags":            { "type": "keyword" },
      "layer":           { "type": "keyword" },
      "userId":          { "type": "keyword" },
      "agentId":         { "type": "keyword" },
      "accountId":       { "type": "keyword" },
      "importanceScore": { "type": "float" },
      "createdAt":       { "type": "date" },
      "metadata": {
        "type": "object",
        "dynamic": true,
        "enabled": false
      }
    }
  }
}
```

Design notes:
- `metadata` is stored (`enabled: false`) for retrieval but not analyzed — avoids mapping explosion from arbitrary agent metadata keys.
- `dynamic: strict` on root prevents accidental field mapping from bad payloads.
- `raw.exact` keyword subfield handles ticket IDs and proper nouns without stemming.
- Single shard is correct for the expected scale (10k–500k memories per instance). Adjust via env if needed.

### Mapping Evolution

When the mapping needs changes: create a new index (`engram_memories_v2`), run the backfill endpoint against it, then use the alias API to cut over. Do not mutate a live index. Document the alias approach in `elasticsearch.service.ts` comments for the next engineer.

### Files Changed

- `src/elasticsearch/elasticsearch.service.ts` — `INDEX_MAPPING` constant + `ensureIndex()`

### Acceptance Criteria

- On fresh startup against empty ES, index is created with correct mapping
- On subsequent startups, `indices.exists` returns true and `indices.create` is skipped
- Mapping rejects unknown root-level fields (strict dynamic mode)

---

## Task 3: Event-Driven Indexing

### Goal

Keep the ES index in sync with the `memories` table in near-real-time by subscribing to the existing NestJS event bus.

### Problem

Engram already emits `MemoryCreatedEvent` (`memory.created`) and `MemoryDeletedEvent` (`memory.deleted`) from `EventEmitterModule` (see `src/events/event-types.ts`). The ensemble embedding service (`src/ensemble/ensemble.service.ts`) subscribes to these with `@OnEvent('memory.created', { async: true })`. The ES listener follows the same pattern.

`MemoryCreatedEvent` carries: `memoryId`, `layer`, `importance`, `tags`, `userId`, `preview`. The listener must fetch the full memory record (specifically `raw`, `agentId`, `accountId`, `metadata`, `createdAt`, `importanceScore`) from Prisma to build the ES document.

### Solution

`src/elasticsearch/elasticsearch.listener.ts`:

```typescript
@Injectable()
export class ElasticsearchListener {
  @OnEvent('memory.created', { async: true })
  async handleMemoryCreated(event: MemoryCreatedEvent): Promise<void> {
    if (!this.es.isEnabled()) return;
    try {
      const memory = await this.prisma.memory.findUnique({
        where: { id: event.memoryId },
        select: { id, raw, tags, layer, userId, agentId, accountId,
                  metadata, createdAt, importanceScore, deletedAt }
      });
      if (!memory || memory.deletedAt) return;
      await this.es.indexMemory(toDocument(memory));
    } catch (err) {
      this.logger.error(`[ES] index on created failed for ${event.memoryId}`, err);
      // never rethrow — event bus failures must not affect the write path
    }
  }

  @OnEvent('memory.deleted', { async: true })
  async handleMemoryDeleted(event: MemoryDeletedEvent): Promise<void> {
    if (!this.es.isEnabled()) return;
    try {
      await this.es.deleteMemory(event.memoryId);
    } catch (err) {
      this.logger.error(`[ES] delete failed for ${event.memoryId}`, err);
    }
  }
}
```

The `toDocument()` helper maps a Prisma `memory` row to the ES document shape. Keep it pure and tested separately.

`MemoryUpdatedEvent` is intentionally not handled in v1. Memories in Engram are predominantly append-only (superseded via `superseded_by_id`, not mutated). If update sync becomes necessary, add it in a follow-up — the backfill endpoint covers the gap.

### Files Changed

- `src/elasticsearch/elasticsearch.listener.ts` — new
- `src/elasticsearch/elasticsearch.module.ts` — add `ElasticsearchListener` to providers

### Acceptance Criteria

- `memory.created` causes a document to appear in ES within 500ms (integration test, local ES)
- `memory.deleted` causes document to be removed from ES
- If ES is unreachable, the event handler logs and returns — it does not propagate the error to the caller
- Handler is a no-op when `ELASTICSEARCH_ENABLED=false`

---

## Task 4: Replace tsvector Text Search in HybridSearchService

### Goal

Route `textSearch()` through ES when available. Fall back to the existing tsvector path when ES is disabled or unreachable. Remove the split query-parser problem and gain field-level boosting.

### Solution

Inject `ElasticsearchService` into `HybridSearchService` via `@Optional()`. `textSearch()` branches at runtime:

```typescript
async textSearch(
  query: string,
  options: VectorSearchOptions,
): Promise<Array<{ id: string; score: number }>> {
  if (this.es?.isEnabled()) {
    return this.esTextSearch(query, options);
  }
  return this.pgTextSearch(query, options); // existing implementation, renamed
}
```

`esTextSearch()` builds the ES bool query:

```json
{
  "size": <limit>,
  "query": {
    "bool": {
      "must": {
        "multi_match": {
          "query": "<searchQuery>",
          "fields": ["raw^3", "tags^2"],
          "type": "best_fields",
          "fuzziness": "AUTO",
          "minimum_should_match": "75%"
        }
      },
      "filter": [
        { "terms": { "userId": [<userIds>] } }
      ]
    }
  }
}
```

Additional filters appended to `filter` array:
- Layer filter: `{ "terms": { "layer": [<layers>] } }` when `options.filter.layers` is set
- Pool filter: see Pool Filtering section below

Normalization: divide each hit `_score` by the maximum `_score` in the result set to produce values in [0, 1]. If the result set is empty, return `[]`. This keeps scores comparable to the tsvector path that `fuseResults()` consumes.

ES errors (network timeout, index not ready): catch, log at warn level, return `[]`. `fuseResults()` handles empty text results gracefully — it produces `fusionMethod: 'vector_only'` results.

### Pool Filtering (Option A)

When `options.filter.poolIds` is set, ES does not have visibility into `memory_pool_memberships`. Pre-fetch the allowed memory IDs from Postgres before calling ES:

```typescript
const poolMemoryIds = await this.prisma.memoryPoolMembership.findMany({
  where: { poolId: { in: options.filter.poolIds } },
  select: { memoryId: true },
});
const allowedIds = poolMemoryIds.map(r => r.memoryId);
// then add to ES filter:
{ "ids": { "values": allowedIds } }
```

Option B (skip ES text search for pool-only queries, rely solely on pgvector's pool JOIN SQL) is acceptable when `allowedIds` would be very large (>10k). Add a threshold: if `allowedIds.length > 5000`, fall back to pgTextSearch for pool-scoped queries only and log a metric.

### Files Changed

- `src/vector/hybrid-search.service.ts` — inject `ElasticsearchService` (Optional), rename existing `textSearch` to `pgTextSearch`, add `esTextSearch`, update constructor signature
- `src/vector/vector.module.ts` — ensure `ElasticsearchModule` is accessible (it is Global so no explicit import needed, but verify)

### Acceptance Criteria

- With ES enabled, `textSearch()` calls ES, not Postgres tsvector
- With `ELASTICSEARCH_ENABLED=false`, `textSearch()` calls the existing `pgTextSearch()` path — no behavior change for the tsvector path
- "WhaleHawk" and "ENG-42" style queries return relevant results via ES that tsvector missed (verified in integration test against seeded data)
- Pool-scoped queries pre-fetch IDs and apply `ids` filter in ES query
- ES timeout or 5xx response returns `[]` without throwing

---

## Task 5: Remove the Duplicate Inline BM25 Block

### Goal

Delete the redundant `websearch_to_tsquery` safety net in `memory-query.service.ts` (approximately lines 237–343). Once ES is wired into `HybridSearchService.textSearch()`, this block is superseded.

### Problem

The inline block uses `websearch_to_tsquery` (slightly better parser than `plainto_tsquery` used in `HybridSearchService`), runs against the raw `raw` column without the stored `search_vector`, and injects results with a flat score of `0.75`. It is inconsistent with the RRF fusion model and creates candidates that bypass the ranking pipeline for IDs not in the vector result set.

The ILIKE fallback block (immediately below the BM25 block, approximately lines 282–337) catches zero-result scenarios for very short or gibberish queries and should be retained — it is not replaced by ES.

### Solution

Remove the block beginning with the comment `// BM25/tsvector hybrid: safety net for exact-keyword queries` through the closing `} catch (ftsError)` block. The `ftsResultIds` set and the `forcedFts` merge below it are also removed. The `ILIKE fallback` block and its `ftsResultIds` usage can be simplified — it no longer needs to union with BM25 results, only track its own candidate IDs.

Verify: `singleUserId` and `searchQuery` variables are still used downstream (they are — passed to `embedding.search()` and to the ILIKE block). No other cleanup required.

### Files Changed

- `src/memory/memory-query.service.ts` — remove inline BM25 block, clean up `ftsResultIds` / `forcedFts` logic

### Acceptance Criteria

- `memory-query.service.ts` no longer calls `$queryRawUnsafe` with `websearch_to_tsquery`
- ILIKE fallback still fires when ES + vector produce 0 results for short queries
- All existing `memory-query.service.spec.ts` tests pass (mock ES in test setup)
- No regression in recall benchmarks (run eval suite before merging)

---

## Task 6: Admin Reindex Endpoint

### Goal

Populate the ES index from the existing Postgres `memories` table. Required on first deployment and after any mapping migration.

### Solution

`POST /v1/admin/elasticsearch/reindex`

Guards: `ApiKeyOrJwtGuard` + `AdminGuard` (same pattern as existing admin endpoints in `MemoryAdminController`).

Implementation in `ElasticsearchController`:

1. Count total non-deleted memories: `prisma.memory.count({ where: { deletedAt: null } })`
2. Stream in batches of 500 using cursor pagination (`skip` / `take` or `cursor` on `id`)
3. For each batch, call `elasticsearchService.bulkIndex(batch)`
4. Accumulate `{ total, indexed, errors }` counters
5. Return the counters when complete

`bulkIndex()` in `ElasticsearchService` uses the ES `helpers.bulk()` API (streaming helper from `@elastic/elasticsearch/helpers`) which handles retry on transient 429 responses.

Response shape:

```json
{
  "total": 14823,
  "indexed": 14820,
  "errors": 3,
  "errorDetails": [
    { "id": "clxxx", "error": "document too large" }
  ]
}
```

The endpoint is synchronous and blocking for the duration of the reindex. For instances with >100k memories, operators should run this during low-traffic windows. A streaming/SSE version is out of scope.

Rate: 500 docs/batch, up to 50 concurrent ES operations via `helpers.bulk()`. Expect ~2–5 minutes for 100k memories on Railway standard plan.

### Files Changed

- `src/elasticsearch/elasticsearch.controller.ts` — new, `POST /v1/admin/elasticsearch/reindex`
- `src/elasticsearch/elasticsearch.service.ts` — add `bulkIndex()` using `@elastic/elasticsearch/helpers`
- `src/elasticsearch/elasticsearch.module.ts` — add controller

### Acceptance Criteria

- Endpoint requires admin auth; returns 403 without it
- Processes all non-deleted memories and returns correct counts
- Individual document errors do not abort the batch — logged and counted
- `{ total, indexed, errors }` in response body
- Idempotent: re-running reindex over an existing populated index overwrites documents (ES upsert semantics via `index` action in bulk)

---

## Environment Variables

Add to `.env.example` and Railway variable set:

```
# Elasticsearch
ELASTICSEARCH_URL=http://localhost:9200
ELASTICSEARCH_API_KEY=                   # cloud auth (Elastic Cloud / self-hosted with security)
ELASTICSEARCH_USERNAME=                  # basic auth (alternative to API key)
ELASTICSEARCH_PASSWORD=
ELASTICSEARCH_INDEX=engram_memories      # override if running multiple Engram instances
ELASTICSEARCH_ENABLED=true               # kill switch — false disables all ES code paths
```

Auth priority in `ElasticsearchService` factory: API key > username+password > unauthenticated (local dev).

Railway deployment: add `ELASTICSEARCH_URL` pointing to the chosen ES provider. Elastic Cloud (Serverless tier) is the recommended path — no cluster management, usage-based pricing, compatible with `@elastic/elasticsearch` v8 client.

---

## Migration / Backfill Plan

### First deployment

1. Provision ES (Elastic Cloud Serverless or self-hosted on Railway with the `elasticsearch` Docker image).
2. Set `ELASTICSEARCH_ENABLED=true` and connection env vars in Railway.
3. Deploy new code. On startup, `ensureIndex()` creates the index. Event listeners begin indexing new memories immediately.
4. Call `POST /v1/admin/elasticsearch/reindex` to backfill existing memories.
5. Monitor `GET /_cat/count/engram_memories` to confirm document count approaches Postgres count.
6. Remove `HYBRID_FUZZY_ENABLED=false` override if previously set (tsvector trigram no longer in hot path).

### Rollback

Set `ELASTICSEARCH_ENABLED=false`. The tsvector fallback path in `HybridSearchService.textSearch()` reactivates automatically. No data loss — pgvector and Postgres are untouched.

### Mapping migration (future)

1. Create `engram_memories_v2` index with updated mapping.
2. Run reindex to `v2` (add `?index=engram_memories_v2` query param — extend endpoint to accept target index name).
3. Switch alias: `POST /_aliases` to remove `engram_memories` alias from `v1`, add to `v2`.
4. Update `ELASTICSEARCH_INDEX` env var.

---

## Local Development

### Docker

No docker-compose file exists in the repo yet. Add `docker-compose.yml` at the project root with an `elasticsearch` service alongside the existing `postgres` service:

```yaml
version: "3.9"
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: engram
      POSTGRES_PASSWORD: engram
      POSTGRES_DB: engram
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.14.0
    environment:
      discovery.type: single-node
      xpack.security.enabled: "false"   # disable TLS/auth for local dev
      ES_JAVA_OPTS: "-Xms512m -Xmx512m"
    ports:
      - "9200:9200"
    volumes:
      - esdata:/usr/share/elasticsearch/data

volumes:
  pgdata:
  esdata:
```

`xpack.security.enabled: false` means no auth is needed locally — `ELASTICSEARCH_API_KEY` and `ELASTICSEARCH_USERNAME`/`ELASTICSEARCH_PASSWORD` can be left blank. The `ELASTICSEARCH_URL=http://localhost:9200` env var is sufficient.

Memory requirement: ES 8 needs at least 1GB RAM. The 512MB heap (`-Xms512m -Xmx512m`) fits within a 1.5GB Docker VM. On machines with constrained Docker memory, raise to 1GB or lower to `-Xms256m -Xmx256m` with reduced performance.

### Local .env additions

Add to `.env.local` (or equivalent dev override):

```
ELASTICSEARCH_URL=http://localhost:9200
ELASTICSEARCH_ENABLED=true
ELASTICSEARCH_INDEX=engram_memories_dev
```

Use a separate index name (`engram_memories_dev`) so local experiments don't pollute a shared instance.

### Verifying the ES service is running

```bash
curl http://localhost:9200/_cluster/health?pretty
# expected: "status": "green" or "yellow" (single-node is always yellow)
```

After seeding memories, verify document count:

```bash
curl http://localhost:9200/engram_memories/_count
```

---

## Testing Strategy

### Unit Tests

Each new file in `src/elasticsearch/` gets a `.spec.ts` counterpart. Use Jest + `@nestjs/testing` with the ES client mocked via `jest.mock('@elastic/elasticsearch')` or a manual mock factory.

**`elasticsearch.service.spec.ts`**
- `ensureIndex()`: asserts `indices.exists` called on init; asserts `indices.create` called with correct mapping when index is absent; skips create when index exists.
- `indexMemory()`: verifies the `index` call shape — correct index name, document fields (`id`, `raw`, `userId`, `layer`, `tags`, `agentId`, `accountId`, `importanceScore`, `createdAt`).
- `deleteMemory()`: verifies `delete` called with correct `id`.
- `search()`: mock hit list with `_score` values; assert normalization produces max score of 1.0; assert empty result on ES error (not throw).
- `bulkIndex()`: assert `helpers.bulk` invoked with correct operations; count error documents correctly.
- `isEnabled()`: returns false when env var absent; returns false when `ELASTICSEARCH_ENABLED=false`; returns true otherwise.

**`elasticsearch.listener.spec.ts`**
- `handleMemoryCreated`: mock `PrismaService.memory.findUnique`; assert `ElasticsearchService.indexMemory` called with result; assert no-op when `isEnabled()` returns false; assert no-op when memory has `deletedAt` set; assert error is swallowed (does not propagate).
- `handleMemoryDeleted`: assert `ElasticsearchService.deleteMemory` called with `event.memoryId`; assert error is swallowed.

**`hybrid-search.service.spec.ts`** (extend existing)
- With ES mock returning results: `textSearch()` calls `esTextSearch()`, not `pgTextSearch()`.
- With `isEnabled()` returning false: `textSearch()` calls `pgTextSearch()`.
- Pool filter: when `options.filter.poolIds` is set, `prisma.memoryPoolMembership.findMany` is called and result IDs appear in ES query filter.
- ES error path: mock ES to throw; `textSearch()` returns `[]`.

### Integration Tests

Run against a real ES instance (local Docker) via a Jest test setup file that:
1. Clears the `engram_memories_test` index before each test suite.
2. Seeds known memory documents via `elasticsearchService.bulkIndex()`.
3. Asserts search results match expected document IDs.

Key integration test cases:
- Exact-match proper noun ("WhaleHawk") returns the seeded document; the tsvector path (tested separately) does not.
- Ticket ID pattern ("ENG-42") found via `raw.exact` keyword subfield.
- Pool-scoped query: only documents with IDs in the `ids` filter are returned.
- Empty query: returns `[]` without error.
- Reindex endpoint (`POST /v1/admin/elasticsearch/reindex`): seeded Postgres memories appear in ES after call; total/indexed counts match.

Integration tests are gated behind `ELASTICSEARCH_ENABLED=true` and `ELASTICSEARCH_URL` being set — they are skipped in CI unless those vars are present. In CI, add an `elasticsearch` service to the GitHub Actions job:

```yaml
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.14.0
    env:
      discovery.type: single-node
      xpack.security.enabled: "false"
      ES_JAVA_OPTS: -Xms512m -Xmx512m
    ports:
      - 9200:9200
    options: >-
      --health-cmd "curl -f http://localhost:9200/_cluster/health"
      --health-interval 10s
      --health-timeout 5s
      --health-retries 10
```

### Regression Testing

Before merging, run `npm test -- --testPathPattern=hybrid-search` and `npm test -- --testPathPattern=memory-query` to confirm no regressions in the existing suites. The BM25 inline block removal in `memory-query.service.ts` must not break the ILIKE fallback path — validate with a test seeding a memory that uses a short unusual word that would only be found via ILIKE.

---

## Out of Scope

- **Dense vector search in ES** — pgvector owns semantic similarity. ES kNN (`dense_vector` field) is not added. Adding it would require storing 1536-dim embeddings in ES (significant storage duplication) and would not improve over pgvector's IVFFlat/HNSW indexes for this scale.
- **Multi-language support** — `memory_analyzer` uses English stemmer. Non-English content falls back to standard tokenization which still works for BM25 scoring; dedicated language analyzers are a future concern.
- **Synonym expansion** — not added in v1. The existing `classifyQuery()` heuristic in `HybridSearchService` adjusts vector/text weights for keyword-heavy queries; synonym dictionaries can be added to the ES analyzer config later without code changes.
- **Real-time aggregation/faceting API** — ES supports this but exposing a facet endpoint is a separate feature.
- **MemoryUpdatedEvent sync** — memories are predominantly append-only in Engram. Update sync is deferred; the reindex endpoint covers drift.
- **Pinecone provider integration** — ES text search is a separate concern from the vector provider abstraction. Pinecone users still benefit from ES text search via RRF fusion.
- **SSE/streaming reindex** — the backfill endpoint is synchronous. Async job queue approach is out of scope.

---

## File Inventory

| File | Action |
|---|---|
| `package.json` | add `@elastic/elasticsearch@^8` |
| `src/elasticsearch/elasticsearch.module.ts` | create |
| `src/elasticsearch/elasticsearch.service.ts` | create |
| `src/elasticsearch/elasticsearch.listener.ts` | create |
| `src/elasticsearch/elasticsearch.controller.ts` | create |
| `src/elasticsearch/index.ts` | create |
| `src/app.module.ts` | add `ElasticsearchModule` import |
| `src/vector/hybrid-search.service.ts` | inject ES, route `textSearch()` |
| `src/vector/vector.module.ts` | verify ES module visibility (global) |
| `src/memory/memory-query.service.ts` | remove inline BM25 block |
| `.env.example` | add ES env vars |

---

## Open Questions

1. **Railway ES hosting**: Elastic Cloud Serverless vs. a Railway-deployed `elasticsearch:8` container. Serverless eliminates ops burden but adds egress latency (~10–30ms vs local). Recommend Elastic Cloud for production, local container for development.

2. **Index size**: Each `raw` field document averages ~500–2000 chars. At 100k memories, the index is roughly 200–800MB including inverted index structures. Acceptable for Elastic Cloud Serverless; verify Railway volume limits if self-hosting.

3. **`classifyQuery()` weight adjustment**: The existing `HybridSearchService.classifyQuery()` shifts vector/text weights for keyword-heavy queries. This logic remains valid and applies equally to ES scores in `fuseResults()`. No changes needed.

4. **`MemoryUpdatedEvent` coverage**: If memory content is editable (corrections, extraction updates), the ES document will drift until the next reindex. Confirm with product whether content mutation is a live feature before skipping update sync.

---

## Implementation Task Breakdown

Numbered in dependency order. Tasks 1–2 are blocking for all others. Tasks 3–6 can be parallelized after 1–2 land.

1. **Install ES client + scaffold module** — `npm install @elastic/elasticsearch@^8`; create `src/elasticsearch/` directory; write `elasticsearch.module.ts` (global, `@Global()`); write stub `elasticsearch.service.ts` with `isEnabled()` returning false when env vars absent; register in `src/app.module.ts`. Acceptance: `npm run build` passes.

2. **Implement index mapping + `ensureIndex()`** — add `INDEX_MAPPING` constant to `elasticsearch.service.ts`; implement `onModuleInit()` calling `ensureIndex()`; handle `indices.exists` / `indices.create` flow; graceful no-op when ES is unreachable at startup. Acceptance: unit test verifies index is created on fresh start and skipped when already exists.

3. **Implement `ElasticsearchListener`** — create `src/elasticsearch/elasticsearch.listener.ts`; subscribe to `memory.created` and `memory.deleted` events via `@OnEvent`; fetch full memory from Prisma (`raw`, `userId`, `agentId`, `accountId`, `tags`, `layer`, `importanceScore`, `createdAt`, `deletedAt`) in the created handler; call `indexMemory()` / `deleteMemory()`; swallow all errors. Acceptance: unit tests for both handlers; no-op when disabled.

4. **Implement `search()` in `ElasticsearchService`** — build the `bool` / `multi_match` query with `raw^3, tags^2`; accept `EsSearchFilters` (userIds, layers, poolIds); apply normalization (divide by max `_score`); return `Array<{ id: string; score: number }>`. Acceptance: unit test with mocked client; integration test on seeded data for proper-noun and ticket-ID queries.

5. **Route `HybridSearchService.textSearch()` through ES** — inject `ElasticsearchService` as `@Optional()` in `hybrid-search.service.ts`; rename existing implementation to `pgTextSearch()`; add `esTextSearch()` calling `ElasticsearchService.search()` with pool pre-fetch logic; update `textSearch()` to branch on `this.es?.isEnabled()`. Acceptance: unit tests for both branches; ES timeout returns `[]`.

6. **Remove inline BM25 block from `memory-query.service.ts`** — delete the block starting at the comment `// BM25/tsvector hybrid: safety net for exact-keyword queries` (approximately lines 237–343 on staging); clean up `ftsResultIds` / `forcedFts` merge logic; simplify ILIKE block to track only its own IDs. Acceptance: no `websearch_to_tsquery` calls remain; ILIKE path still fires on zero-result queries; all existing `memory-query.service.spec.ts` tests pass.

7. **Implement `bulkIndex()` in `ElasticsearchService`** — use `@elastic/elasticsearch/helpers` `bulk()` helper; accept `MemoryDocument[]`; return `{ indexed, errors, errorDetails }`. Acceptance: unit test verifying bulk shape; errors counted but do not abort batch.

8. **Implement admin reindex endpoint** — create `src/elasticsearch/elasticsearch.controller.ts` with `POST /v1/admin/elasticsearch/reindex`; guard with `ApiKeyOrJwtGuard` + `AdminGuard`; paginate `memories` in batches of 500 using cursor on `id`; call `bulkIndex()`; return `{ total, indexed, errors, errorDetails }`. Acceptance: requires admin auth; idempotent (re-run overwrites); returns correct counts.

9. **Add docker-compose.yml** — add `elasticsearch:8.14.0` service alongside postgres; set `xpack.security.enabled: false`; configure volumes. Acceptance: `docker compose up` brings up both services; `curl localhost:9200/_cluster/health` returns healthy.

10. **Update `.env.example`** — add `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY`, `ELASTICSEARCH_USERNAME`, `ELASTICSEARCH_PASSWORD`, `ELASTICSEARCH_INDEX`, `ELASTICSEARCH_ENABLED` with comments. Acceptance: `.env.example` matches the Environment Variables section of this spec.

11. **Write integration tests** — add Jest integration test suite gated on `ELASTICSEARCH_ENABLED=true`; add ES service container to GitHub Actions CI; test proper-noun recall, ticket ID, pool filtering, reindex endpoint. Acceptance: all integration tests pass in CI with the ES service running.
