# Engram — Deep

Loaded when designing in or debugging Engram. Token budget ~2500.

## Embedding ensemble

Cloud-ensemble writes use **openai-small (1536-dim)** as the anchor. `memory_embeddings` table holds per-model embeddings keyed by `(memory_id, model)`. Legacy `m.embedding` column on memories table is dim-mixed and dim-incompatible — gated behind `DISABLE_LEGACY_EMBEDDING_FALLBACK=true` since 2026-05-13.

Active model coverage (production at 2026-05-13 snapshot, ~23k memories):
- bge-base: 35275 rows (legacy, when local engram-embed was active)
- openai-small: 10456 — the current search target
- openai-large: 10456, cohere-v3: 10454, gte-base/minilm/nomic: 670 each, kalm-v2: 506

The 13k bge-base-only memories cannot be returned by openai-small search until reembed lands.

## Layers

`IDENTITY` (durable facts about the user/world), `PROJECT` (work context per project), `SESSION` (current conversation), `TASK` (ephemeral). Query API accepts `layers` array filter.

## Key decisions / recent incidents

- **2026-05-13** — Recall 500 fix. VECTOR_SEARCH_MODEL was unset → defaulted to bge-base (768-dim) → pgvector dim mismatch (22000 different vector dimensions 768 and 1536). Set on Railway prod env. Decorative env vars (`ENSEMBLE_ANCHOR_MODEL`, `ENSEMBLE_ACTIVE_MODELS`, `ENSEMBLE_MODELS`) are set but unread by code — don't trust as evidence.
- **2026-05-13** — Engram bootstrap hook orphaned by harness migration. claude-cli's settings.json has no SessionStart hook for engram; openclaw.json entries are dead. Port stalled on sensitive-file gate.
- **Earlier** — main/staging divergence. Main has 27 commits ahead incl. GIN-37/38/42/43 hotfixes + Prisma v6 marker. Staging has 287 ahead on Prisma v7. PRs against staging until reconciled.
- **Ingest pipeline tx-closed bug** — fresh `/v1/sessions/index` leaves memories with no embeddings; whole pipeline fails on closed transaction. Only batch reembed currently writes vectors.

## Internal vocabulary

- **Layer** = memory namespace (IDENTITY/PROJECT/SESSION/TASK)
- **Importance score** = numeric (0–1ish) used in ranking
- **Ensemble** = the multi-model embedding write path
- **Anchor model** = the dimension/model used as search target (openai-small currently)
- **Legacy embedding** = the deprecated single-column embedding on the memories table

## Boundaries

- Engram **does** store, embed, query, rank, mark-used, expire memories.
- Engram **does not** make decisions, run agents, sign events (that's Sonder), or render UIs.
- Engram **is** the memory faculty Inos uses for dedup (replacing Levenshtein); local mode works without network.

## Open questions / parked work

- **TOON retrieval-pack experiment (deferred):** A/B TOON-encoded retrieval packs vs JSON for token/accuracy delta. Idea filed; not active.
- **Reembed pipeline pickup:** fix cloud-ensemble tx-closed bug first, then backfill 13k bge-base-only memories. Rotate compromised Railway tokens.
- **PR #238 + benchmark regression follow-up:** post-dream missed-count drifted 1-2 → 3 (2026-05-16); needs investigation.
- **engram-embed saturation:** 4-model ensemble reembed at 10k+ memories bails repeatedly; restart doesn't fix. Needs fewer models or higher poll tolerance.
