# Engram

**Purpose:** Persistent memory for AI agents. Memories are typed (identity facts, project context, session work, ephemeral tasks), time-stamped, importance-scored, and embedded across a multi-model ensemble. The query API ranks results by combined embedding similarity + importance + recency. Open source so any external developer can run it locally.
**Repo:** https://github.com/heybeaux/engram
**Status:** active
**Phase:** main↔staging reconciliation pending; PR #238 open; benchmark regression follow-up
**Last verified:** 2026-05-18

## Runtime

- **Local code:** /Users/beauxwalton/projects/engram (canonical) — `~/engram` is a stale checkout, do not read from it
- **Default branch:** `staging` (main is 27 commits behind on substantive hotfixes; do not PR against main yet)
- **Local instances (launchd):**
  - port 3002 — `com.engram.api`, db `engram` (default dev/bench target)
  - port 3101 — `com.engram.endeavour`, db `engram_endeavour`
  - port 3005 — `com.engram.code`, db `engram_code`
- **Cloud prod:** Railway service `proud-purpose` in project `open-engram`. DB: `engram-prod-db-v2` (queried via `crossover.proxy.rlwy.net:35594`)
- **Tech:** NestJS + Prisma + Postgres + pgvector + multi-model embedding ensemble (openai-small anchor, 1536-dim)

## Dependencies

- **Depends on:** Postgres + pgvector, OpenAI/Cohere/local embedding models
- **Used by:** Inos (memory + dedup), Sonder adapters, Ginnung cockpit
- **External:** Railway (cloud), `crossover.proxy.rlwy.net:35594` (db proxy)

## Key contacts

- **Owner:** @beauxwalton
- **Recent contributors:** @beauxwalton

## Quick gotchas

- **Read code from `/Users/beauxwalton/projects/engram`** — not `~/engram`. The launchd `com.engram.api` plist points at projects/.
- **PRs against `staging`** until main↔staging is reconciled (see `engram-main-staging-divergence.md`).
- **Search model must match write model.** `VECTOR_SEARCH_MODEL=openai-small` + `DISABLE_LEGACY_EMBEDDING_FALLBACK=true` on Railway prod. If recall 500s with "different vector dimensions," it's this.
- **~13k memories are bge-base-only** — invisible to openai-small search until reembed pipeline is fixed (parked; `engram-reembed-pipeline-next.md`).
- **No bulk delete endpoint** — enumerate IDs via diverse `/v1/memories/query` calls, then DELETE per ID.
- **Family memory lives in cloud IDENTITY layer, not local** — local DB is bench-polluted.
- **Engram bootstrap hook orphaned** — claude-cli ~/.claude/settings.json has no SessionStart wiring for engram; openclaw.json entries are dead.

## Where to learn more

- `deep.md` — embedding ensemble, layer semantics, tx-closed bug, reembed pipeline
- Memory files: `engram-running-tree.md`, `engram-search-model-fix.md`, `engram-main-staging-divergence.md`, `engram-ingest-pipeline-bug.md`, `engram-reembed-pipeline-next.md`, `engram-no-family-memory.md`
- engram.ginnung.ai (marketing), openengram.ai (live app)
