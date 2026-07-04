# Design: Arc Search

## Core insight

An arc is already the right retrieval unit for "what was that stretch of work?" — it is bounded in time and pre-summarized. We do not need new intelligence to make arcs searchable; we need to **aggregate the signal that already exists on the member days** (`summaryEmbedding`, `summaryText`, `agentLocalDate`, `arcId`) and expose a search entry point.

## Data we already have (no migration for option A)

From `model Timeline` (`prisma/schema.prisma`):

| Field | Use in search |
|---|---|
| `arcId String?` | grouping key; indexed (`@@index([arcId])`) |
| `summaryEmbedding vector(768)` | semantic ranking (pgvector cosine) |
| `summaryText` | representative summary + optional BM25 blend |
| `agentLocalDate @db.Date` | calendar window filter + arc span |
| `chapter` | candidate for a human-readable title |
| `significance Float` | tie-breaker / title-day selection |

Only `summaryText` is embedded (per the schema comment "LOD content — only summary gets an embedding"), so semantic search operates at summary granularity. That is the right tier for arc-level recall.

## Option A — query-time aggregation (ship this first)

Pipeline for `POST /v1/timelines/arc/search`:

1. **Candidate day selection.**
   - If `from`/`to` present: `WHERE agentId = ? AND agentLocalDate BETWEEN ? AND ?`.
   - Always require `arcId IS NOT NULL` for arc results (ungrouped days handled separately, see below).
2. **Semantic rank (when `query` present).**
   - Embed `query` via the existing embedding service (same 768-dim model that wrote `summaryEmbedding`; do NOT hand-roll a second model — reuse `EmbeddingService` / the router so dimensions and model match).
   - Order candidate days by `summaryEmbedding <=> $queryVec` (pgvector cosine distance). Convert distance → similarity `score = 1 - distance`.
   - Use a raw pgvector query (the codebase already does this in the vector providers); parameterize the vector — **never string-interpolate** it (there are existing `*-injection.security.spec.ts` suites; match that rigor).
3. **Group + aggregate by arc.**
   - Group matched days by `arcId`.
   - `arcScore = max(memberDayScore)` (primary) with `mean` available as a tunable; max favors "the arc that contains the single most relevant day," which matches the recall intent. Constant behind config: `ARC_SCORE_AGG = 'max' | 'mean'`, default `max`.
   - `from = min(agentLocalDate)`, `to = max(agentLocalDate)`, `dayCount = count`.
4. **Representative title + summary (v1 heuristic, no LLM).**
   - **Title:** first non-empty of: a distinct `chapter` shared by the arc's days → else the `chapter` of the highest-`significance` day → else `"Arc {from}–{to}"`. (LLM titling is a fast-follow; keep the resolver in one function so it can be swapped.)
   - **Summary:** the `summaryText` (at requested LOD) of the top-scoring day, OR the highest-`significance` day when no `query`. Return at the LOD the caller asks for (default `summary`).
5. **Calendar-only search (no `query`).** Skip embedding; order arcs by recency (`to` desc) within the window. This makes "show me arcs from March" work without a query string.
6. **Limit** to `limit` arcs (default 10, max 50) after aggregation.

### Ungrouped days
Days with `arcId = null` are not arcs. For v1, **exclude them from arc results** to keep the contract clean; the browse-by-day UI already covers loose days. (A later option: surface them as synthetic single-day arcs behind a `includeLooseDays` flag. Out of scope for v1.)

### Why not embed the arc as a whole?
Averaging member-day embeddings into one arc vector loses the "one very relevant day" signal and needs a place to store the aggregate (→ option B). Max-over-days at query time is simpler, needs no migration, and ranks better for spiky arcs. Revisit if latency at scale is a problem.

## Option B — materialized `Arc` entity (fast-follow, only if needed)

If option A's per-query grouping is too slow (many arcs × many days) or titles are poor:

```prisma
model Arc {
  id               String   @id @default(uuid())
  agentId          String
  arcId            String   // the shared tag stamped on member timelines
  title            String
  summary          String
  summaryEmbedding Unsupported("vector(768)")?
  from             DateTime @db.Date
  to               DateTime @db.Date
  dayCount         Int
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@unique([agentId, arcId])
  @@index([agentId])
}
```

- Written/refreshed inside `closeArc` (transaction): compute span, dayCount, pick title, synthesize + embed a summary.
- Search becomes a single pgvector query over `Arc.summaryEmbedding` + a date filter — no per-query grouping.
- Cost: a migration (`prisma migrate deploy` only — no `migrate dev`/`reset` on cloud, per MEMORY.md), a keep-in-sync write path, and a backfill for arcs closed before the table existed.
- **Decision gate:** only build B if A's p95 search latency exceeds ~300ms on realistic data, or title quality blocks the UX. The API response contract is identical, so the dashboard does not change.

## API contract details

- Route: `POST /v1/timelines/arc/search` on the existing `TimelineController` (`@Controller('timelines')`, guards `ApiKeyOrJwtGuard`, `RateLimitGuard`; `@Agent()` decorator for scoping — mirror the sibling handlers exactly).
- DTO `ArcSearchDto`: `query?: string`, `from?: string` (IsDateString), `to?: string` (IsDateString), `limit?: number` (IsInt, Min 1, Max 50, default 10), `lod?: 'index'|'summary'|'standard'` (default 'summary'). Validation: reject when all of query/from/to are absent (`BadRequestException`).
- Errors: 400 on empty search / bad dates / `from > to`; 401 via guard; 200 otherwise.

## Validation & tests

- **Unit (service):** grouping + aggregation logic with a mocked prisma (mirror `timeline.service.spec.ts` patterns): max-vs-mean aggregation, span/dayCount, title resolver fallbacks, empty result, calendar-only path (no embed call), limit clamping.
- **e2e (against the real test DB, like `timeline-arc.e2e-spec.ts`):** seed ≥2 arcs with distinct topics across known date windows, then:
  - a `query` matching arc A ranks A first;
  - a `from`/`to` window returns only arcs overlapping it;
  - hybrid (query + window) intersects correctly;
  - empty search → 400.
  - Stub the query embedding deterministically (as the existing e2e stubs the LOD generator) so ranking is hermetic — do not call a live embedding model in CI.
- **Security:** the pgvector query must be parameterized; add/extend an injection spec consistent with the existing `*-injection.security.spec.ts` suites.

## Dashboard notes (ENG-166)

- Add client methods in the dashboard's `engram-client.ts` (it currently exposes only memories/context/stats/analytics — no `/v1/timelines*`). Keep types in sync with the API DTOs.
- Page composition: search bar (text + date range) → results list of arc cards → arc detail drawer/page that calls `GET /v1/timelines/arc/:arcId?lod=`.
- Reuse existing design-system components and the app's data-fetching convention (inspect the repo before introducing any new lib).
- Definition of done includes verifying against a **running** dashboard, not just a green build.
