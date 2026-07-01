# Changelog

All notable changes to the Engram project will be documented in this file.

## [1.5.0] — 2026-02-16

### Release published

Engram v1.5.0 is published as a GitHub Release and npm package:

- GitHub Release: [`v1.5.0`](https://github.com/heybeaux/engram/releases/tag/v1.5.0)
- npm package: [`@openengram/engram@1.5.0`](https://www.npmjs.com/package/@openengram/engram/v/1.5.0)
- Release-note packet: [`docs/RELEASE_NOTES_v1.5.0_DRAFT.md`](./docs/RELEASE_NOTES_v1.5.0_DRAFT.md)

The release notes summarize the local/cloud edition split, first-run setup, cloud backup/sync foundations, instance keys, RLS hardening, dashboard/API reliability fixes, and CI/test coverage work since v1.0.0.

### Provenance note

The `v1.5.0` Git tag was created earlier at commit `be41d6e37e12f2b8f6784cf4ebfd2c53622e4ac2`. Production was subsequently promoted through PR #307 and package-publication metadata was finalized in PR #308. The npm artifact `@openengram/engram@1.5.0` was published from the protected `production` branch after that metadata hardening, with package name `@openengram/engram`, `private: false`, and `publishConfig.access: public`.

Do not move or recreate the existing `v1.5.0` tag just to align it with the later packaging commit; document the provenance instead.

---

## [1.0.0] — 2026-02-12

### 🎉 First Public Release

Engram is production-ready agent memory. 2,700+ memories, 88% recall accuracy, Fog Index 92.5 Crystal.

### Added (since 0.5.0)

#### v0.6 — Memory Quality
- Automatic memory correction — facts update/supersede old memories
- Memory clustering — group related memories for richer context
- Conversation summarization — extract key facts, not every turn
- Embedding drift monitoring — track quality over time
- Dashboard: MergeCandidate review UI (bulk approve/reject/skip)
- Multi-agent sessions (AgentSession model, pools, grants)
- Dashboard: Sessions page, Pools page, Memory attribution tab

#### v0.7 — Attribution & Access
- Memory attribution — track which agent created/used memories
- Dashboard rebuilt on 0.0.0.0:3000 for LAN access
- Full re-embed after completion

#### v0.8 — Production Hardening
- Dream Cycle mutex — PostgreSQL advisory lock prevents concurrent runs
- Fog Index — 6-component cognitive health score with Crystal→Dense Fog spectrum
- Route cleanup — `/v1/` prefix on all controllers, deduplicated endpoints
- Backup strategy — daily 2am backups via LaunchAgent, restore script
- Migration safety — `safe-migrate.sh` blocks `prisma migrate dev` on production
- Rate limiting — token bucket per API key (100/min global, 30/min observe, 60/min query)
- Monitoring & alerts — embedding failures, memory anomalies, 5xx, Dream Cycle health
- API documentation — Swagger UI at `/v1/docs`, 116 endpoints, 8 controller groups
- Test fixes — 4 spec files fixed (102 tests passing)

#### v0.9 — Multi-Agent Intelligence
- Pool APIs — Full CRUD at /v1/pools, grant management, auto-pool creation
- Per-session context budget — contextTokenBudget on AgentSession, main=4000/sub-agent=2000
- OpenClaw hook integration — sub-agent bootstrap, message capture, memory promotion
- Generate-context tuning — staleness detection, section prioritization, embedding dedup
- Eval module — eval_runs table, 25 recall + 30 latency fixtures, regression detection
- Multi-query expansion — automatic query reformulation for better recall
- Prefetch cache — topic-based predictive memory loading
- Scoped context — per-conversation memory windows

#### v1.0 — Open Source Prep
- Apache 2.0 license
- README rewrite with architecture diagram and 5-minute quickstart
- CONTRIBUTING.md with dev environment setup and PR process
- GitHub Actions CI (lint, build, test with pgvector service container)
- Docker Compose — one-command setup (Engram + PostgreSQL + engram-embed)
- `.env.example` with all 28 required vars documented
- Hardcoded values removed — all config via environment variables
- Health endpoint consolidation (`/health` → 301 redirect to `/v1/health`)
- 3 broken test suites fixed (pgvector, analytics, backfill)

---

## [0.5.0] — 2026-02-09

### Added

#### Health & Resilience
- `/health` endpoint returns system status (`healthy | degraded | unhealthy`), quality metrics, and detected issues — no auth required
- Graceful degradation when `engram-embed` is down: memories saved without embeddings, auto-retry every 5 minutes via `EmbeddingRetryService`
- `EmbedHealthService` with 30s cache, state-change logging, and `isAvailable()` check

#### Retrieval-Aware Decay
- Decay anchor uses `lastRetrievedAt` when available (falls back to `createdAt`)
- Adjusted half-lives: SESSION 30d (was 14d), TASK 7d (was 3d)

#### Generate Context Improvements
- Recent-first categorization with staleness filtering
- Current project detection from recent memory patterns
- Better token budget allocation across categories

#### Eval Framework
- 22 semantic recall scenarios covering temporal, safety-critical, type classification, and dedup
- Automated scoring with recall, F1, and latency metrics

#### Dedup & Quality v2
- Three-tier deduplication with configurable similarity thresholds:
  - **Auto-merge** (≥0.93) — silently merges near-identical memories
  - **Reinforce** (≥0.85) — boosts existing memory's confidence instead of creating a duplicate
  - **Flag** (≥0.78) — marks for human review
- Confidence scoring by source type (observed conversation vs explicit statement vs inferred)
- Reinforcement-aware decay — memories that get reinforced decay slower

#### Contextual Recall API
- New endpoint: `POST /v1/recall/contextual`
- Automatic topic shift detection via cosine distance between consecutive messages
- 30-second cooldown to prevent recall flooding
- Per-session rate limiting
- Returns relevant memories when conversation topic changes significantly

#### Dream Cycle
- New endpoint: `POST /v1/consolidation/dream-cycle`
- 4-stage consolidation pipeline:
  1. **Dedup** — finds and merges duplicate memories
  2. **Staleness** — identifies and soft-deletes stale, low-value memories
  3. **Patterns** — extracts recurring themes into higher-order memories
  4. **Report** — generates a summary of all consolidation actions
- Soft-delete only (no permanent data loss)
- Protected memory types (CONSTRAINT, pinned) are never touched

#### Generate Context (Dream Cycle Stage 5)
- New endpoint: `POST /v1/consolidation/generate-context`
- Auto-curates top memories into a `MEMORY_CONTEXT.md` file
- Configurable token budget for output size control
- Groups memories by category (User Identity, Current Project, Recent Context, etc.)
- Designed to run as Stage 5 after Dream Cycle completion

#### Ensemble Search Improvements
- PgVector provider updated to search `memory_embeddings` table (multi-model embeddings)
- Configurable search model via `VECTOR_SEARCH_MODEL` environment variable
- Automatic fallback to inline `embedding` column when `memory_embeddings` has no match
- Dual-write on upsert: writes to both inline column and `memory_embeddings` table

### Fixed

- **ImportanceScorerService DI** — Added `@Optional()` and `@Inject()` decorators for `SCORING_CONFIG` token to prevent startup crashes when config is not provided
- **minScore threshold** — DTO default (0.75) was silently overriding the service default, causing relevant memories to be missed. Changed default to 0.65
- **Data integrity** — Reassigned 1,289 memories from null/rook `agentId` to `clawd-agent-001`
- **Embedding backfill** — Backfilled 229 missing inline embeddings from the `memory_embeddings` table
- **Full re-embed** — All 1,539 active memories now have ensemble embeddings (previously only 757)

### Eval Results

| Metric | Result | Grade |
|--------|--------|-------|
| Recall | 23/25 (92%) | A |
| F1 Score | 0.577 | — |
| Context Relevance | 7/8 topics | B |
| Latency (p50) | 124ms | A |
| Latency (p95) | 132ms | A |
| Dedup Density | 2.15% | — |

---

### Related Changes

#### OpenClaw Fork (`openclaw-fork`)
- Cherry-picked 3 Engram hook commits for `message:sent` / `message:received` event hooks
- Updated `copy-hook-metadata.ts` to transpile `handler.ts` → `handler.js` (fixes hook loading)
- New `engram-recall` workspace hook at `hooks/engram-recall/` — triggers contextual recall on incoming messages

#### Engram Dashboard (`engram-dashboard`)
- Added **Consolidation** page at `/consolidation` — UI for Dream Cycle and Generate Context
- Fixed mobile navigation (Code page was missing from mobile nav)
- Fixed CORS issue — `Authorization` header was not included in allowed headers
