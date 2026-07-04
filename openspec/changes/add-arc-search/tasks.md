# Tasks: Arc Search

Sequencing: Phase 1 ships the arc-search API (option A, no migration) — this is the enabling piece. Phase 2 builds the dashboard view (depends on Phase 1). Phase 3 is the optional materialized `Arc` entity, only if the decision gate in design.md is tripped.

Two workstreams map to two Linear tickets: **ENG-165** (Phase 1, engram repo) and **ENG-166** (Phase 2, engram-dashboard repo). ENG-165 blocks ENG-166's search feature.

## Phase 1 — Arc search API (ENG-165, repo: `engram`, branch off `staging`)

- **T1.** Add `ArcSearchDto` in `src/timeline/dto/` — `query?`, `from?`, `to?` (IsDateString), `limit?` (IsInt, Min 1, Max 50, default 10), `lod?` (enum, default 'summary'). Reject when query/from/to all absent.
- **T2.** `TimelineService.searchArcs(agentId, dto)`:
  - candidate day selection (agent scope + optional date window, `arcId IS NOT NULL`);
  - semantic path: embed `query` via the existing `EmbeddingService`/router (same 768-dim model as `summaryEmbedding` — do not introduce a second model), pgvector cosine rank, **parameterized** vector (no string interpolation);
  - group by `arcId`, aggregate score (`max` default, `mean` behind `ARC_SCORE_AGG` config), compute `from`/`to`/`dayCount`;
  - title resolver (shared `chapter` → highest-significance day's `chapter` → `"Arc {from}–{to}"`) in its own swappable function;
  - representative summary at requested LOD from the top day;
  - calendar-only path (no `query`): skip embedding, order by `to` desc;
  - clamp to `limit`.
- **T3.** `POST /v1/timelines/arc/search` on `TimelineController` — mirror sibling handlers' guards (`ApiKeyOrJwtGuard`, `RateLimitGuard`) and `@Agent()` scoping. Swagger `@ApiOperation`/`@ApiResponse`.
- **T4.** Unit tests (`timeline.service.spec.ts` style, mocked prisma): max-vs-mean aggregation, span/dayCount, title fallbacks, empty-result, calendar-only path asserts no embed call, limit clamp, empty-search → BadRequest.
- **T5.** e2e test `test/timeline-arc-search.e2e-spec.ts` against the real test DB: seed ≥2 distinct-topic arcs across known windows; assert query ranks the right arc first, window filters correctly, hybrid intersects, empty search → 400. Stub the query embedding deterministically (like the LOD stub in `timeline-arc.e2e-spec.ts`) — no live model in CI.
- **T6.** Security: ensure the pgvector query is parameterized; add/extend an injection spec consistent with the existing `*-injection.security.spec.ts` suites.
- **T7.** Update `api-spec.json` / OpenAPI so the dashboard client and docs pick up the new endpoint.
- **T8.** Verify: `npx jest src/timeline` green; `npx jest --config ./test/jest-e2e.json test/timeline-arc-search.e2e-spec.ts` green against the local test DB. `npm run build` clean.

## Phase 2 — Dashboard Timelines/Arcs view (ENG-166, repo: `engram-dashboard`, branch off default)

- **T9.** Add `engram-client` methods: `getTimelines(params)`, `getArc(arcId, lod)`, `searchArcs(body)`. Keep types in sync with the Phase 1 DTOs.
- **T10.** New route/page "Timelines / Arcs" registered in the dashboard nav, matching existing routing patterns.
- **T11.** Arc search UI: text query + optional date-range picker → ranked arc cards (title, span, dayCount, summary, score). Loading/empty/error states.
- **T12.** Arc detail: chronological day timelines via `GET /v1/timelines/arc/:arcId?lod=`, with an LOD switch (index/summary/standard).
- **T13.** Browse-by-day fallback when no search is active (uses `GET /v1/timelines`).
- **T14.** Component tests for the search flow (mock client). Reuse the existing design system — no new heavy deps without justification.
- **T15.** Verify against a **running** dashboard (dev server) — golden path (search → open arc → switch LOD) plus empty/error states — not just a green build. Capture a screenshot for the PR.

## Phase 3 — Materialized `Arc` entity (OPTIONAL, only if design.md decision gate trips)

- **T16.** Decision check: measure Phase 1 search p95 latency + title quality on realistic data. Only proceed if p95 > ~300ms or titles block UX. Record the finding on ENG-165.
- **T17.** If proceeding: add `Arc` model (see design.md), migrate via `prisma migrate deploy` only (no `migrate dev`/`reset` on cloud DB — MEMORY.md hard rule).
- **T18.** Write/refresh `Arc` inside `closeArc` (transaction): span, dayCount, title, synthesized + embedded summary. Backfill arcs closed before the table existed.
- **T19.** Switch `searchArcs` to query `Arc.summaryEmbedding` directly; keep the response contract identical so the dashboard is unaffected.

## Cross-cutting notes for implementing agents

- The arc lifecycle (`closeArc`, `findByArc`, arcId filter) already exists in `src/timeline/` as of commit `c16d0a3` on `staging` — build on it, do not re-create it.
- Match repo conventions: NestJS controllers/services, class-validator DTOs, Prettier (the repo has a house style — run the formatter, but keep your feature commit free of unrelated repo-wide reformatting).
- Truth-first: a task is done only when the stated tests actually run and pass. Report real results.
