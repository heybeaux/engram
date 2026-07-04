# Arc Search — semantic + calendar recall of arcs

**Status:** Draft
**Branch:** TBD (API: new branch off `staging`, e.g. `feat/arc-search`; UI: new branch off dashboard default)
**Owner:** Nori
**Date:** 2026-07-04
**Linear:** ENG-165 (API), ENG-166 (dashboard UI); parent epic ENG-43

## Why

ENG-43 (Timeline + LOD Memory, Phase 1) shipped daily `Timeline` entities with three LOD tiers and a per-day `summaryEmbedding vector(768)`. The arc lifecycle now works end-to-end (commit `c16d0a3` on `staging`): a contiguous run of days can be stamped with a shared `arcId` ("close arc") and recalled together (`GET /v1/timelines/arc/:arcId`) or by date range.

But there is **no way to *find* an arc you don't already have the id for.** Today you can only recall an arc if you know its `arcId` or its exact dates. The intended user need — Beaux's own framing — is:

> "If I work on WhaleHawk for 3 weeks this year, next year I'd like to search for that arc to remind myself what I did. Searching arcs is easier than searching individual memories with related keywords."

An arc is a better retrieval unit than a single memory for "what was that stretch of work" questions: it is already summarized, already bounded in time, and already groups the relevant days. We have the embeddings to make it searchable; we just have not exposed a search entry point or a place to group-and-rank by arc.

## What Changes

### 1. Arc as a first-class, searchable unit

Today an arc is only an id shared across `Timeline` rows — it has no name, no aggregate summary, no embedding of its own. Searching "arcs" therefore means **aggregating over the member days**. Two viable shapes; design.md picks one and explains the tradeoff:

- **(A) Query-time aggregation (default recommendation):** no schema change. Rank days by similarity to the query embedding, then group the matched days by `arcId`, aggregate the score per arc (max or mean of member-day scores), and synthesize a representative summary + span from the member days at read time. Ungrouped days (`arcId = null`) optionally surface as single-day arcs.
- **(B) Materialized `Arc` entity:** a new `Arc` table (id, agentId, title, summary, summaryEmbedding, from/to, dayCount) written/refreshed when `closeArc` runs. Faster search, cleaner titles, but adds a schema migration and a write path to keep in sync.

Recommendation: ship **(A)** first (no migration, immediately useful), and spec **(B)** as a fast-follow if search latency or title quality demands it. The API contract below is identical for both, so the UI is unaffected by the choice.

### 2. New endpoint: `POST /v1/timelines/arc/search`

Request:

```jsonc
{
  "query": "WhaleHawk launch work",   // optional; semantic query text
  "from": "2026-01-01",                 // optional; calendar lower bound (agentLocalDate)
  "to":   "2026-12-31",                 // optional; calendar upper bound
  "limit": 10                            // optional; default 10, max 50
}
```

At least one of `query` / `from` / `to` must be present (reject empty search).

Response:

```jsonc
{
  "arcs": [
    {
      "arcId": "arc-whalehawk-launch",
      "title": "WhaleHawk launch",         // representative title (see design.md)
      "summary": "3-week push to ship...",   // representative summary at requested LOD
      "from": "2026-03-02",
      "to":   "2026-03-20",
      "dayCount": 15,
      "score": 0.82,
      "topDays": [ { "date": "2026-03-14", "score": 0.86 } ]  // optional evidence
    }
  ]
}
```

Behaviour:
- **Semantic:** when `query` is present, embed it with the same model used for `summaryEmbedding` (768-dim; reuse the existing embedding service / router) and rank member days by cosine similarity via pgvector, then group + aggregate by `arcId`.
- **Calendar:** when `from`/`to` are present, restrict candidate days to that window (works with or without `query`).
- **Hybrid:** when both are present, filter by window then rank by similarity. (Optional BM25/text blend over `summaryText` is a design.md stretch, not required for v1.)
- **Scoping + guards:** agent-scoped like the rest of `TimelineController`; reuse `ApiKeyOrJwtGuard` + `RateLimitGuard`.

### 3. Dashboard: Timelines / Arcs view (ENG-166)

engram-dashboard currently has **no awareness** of Timeline/arc entities. Its existing `analytics/memory-timeline.tsx` is an activity chart over `/v1/analytics/timeline` — unrelated. This change adds:

- `engram-client` methods for `GET /v1/timelines`, `GET /v1/timelines/arc/:arcId`, `POST /v1/timelines/arc/search`.
- A **Timelines / Arcs** route/page:
  - Arc search box (semantic text + optional date range) → ranked arc result cards (title, span, day count, representative summary, score).
  - Arc detail: the arc's day timelines in chronological order at a selectable LOD (index / summary / standard).
  - Browse-by-day fallback when no search is active.
- Matches the existing dashboard design system and data-fetching patterns.

## What's Out of Scope

- Cross-agent / team arc search (single-agent only for v1).
- Auto-naming arcs with an LLM at close time (v1 derives a title heuristically — see design.md; LLM titling is a fast-follow).
- Editing / merging / splitting arcs from the UI (recall + search only).
- Changing the embedding model or the `summaryEmbedding` dimensionality.
- The materialized `Arc` table (option B) unless option A proves insufficient.
