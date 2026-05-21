# Engram Architecture

> Last updated: 2026-03-14 by architecture-watchdog agent

## Overview

Engram is a NestJS-based AI memory service that stores, retrieves, and manages long-term memory for AI agents and users. It provides semantic search, contradiction detection, memory consolidation, and multi-tenant account management.

**Stack:** NestJS · TypeScript · Prisma · PostgreSQL + pgvector · Redis

**Port:** 3001 (HTTP API)

---

## Module Map (55 modules)

### Core Memory

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `memory` | ~19,326 | Central memory CRUD, search, pipeline, recall, export, backfill, temporal parsing |
| `memory-access-log` | ~736 | Audit trail for memory reads/writes |
| `memory-pool` | ~588 | Memory grouping and pool management |
| `consolidation` | ~7,837 | Dream-cycle consolidation — merges and compresses memories overnight |
| `summarization` | ~731 | LLM-based summarization of memory clusters |
| `correction` | ~866 | Contradiction detection and memory supersession |
| `deduplication` | ~10,693 | Similarity detection, merge resolution, lineage tracking |
| `hierarchy` | ~2,518 | Memory hierarchy and segmentation |
| `contextual-recall` | (in memory) | Contextual memory retrieval strategies |

### Search & Retrieval

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `multi-query` | ~4,155 | Multi-variant query expansion, RRF fusion, result explanation |
| `ensemble` | ~7,696 | Multi-model embedding ensemble, drift detection, nightly re-embed |
| `embedding` | ~2,021 | Embedding generation and storage (local + cloud providers) |
| `reembedding` | ~2,004 | Batch re-embedding with context enrichment |
| `vector` | ~1,614 | pgvector storage and ANN search |
| `prefetch` | ~5,453 | Predictive memory prefetching, topic detection, taxonomy |
| `scoped-context` | ~1,037 | Scoped context windows for focused retrieval |
| `fog-index` | ~697 | Memory fog / decay scoring |

### Identity & Agents

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `identity` | ~11,480 | Agent identity profiles, portable identity export/import, delegation contracts, team profiles |
| `agent` | ~1,319 | Agent CRUD and session management |
| `agent-recall` | ~1,162 | Agent-specific memory recall |
| `agent-session` | ~675 | Agent session tracking |
| `entity-profile` | ~2,455 | Named entity extraction, attachment pipeline, semantic similarity |
| `delegation` | ~838 | Agent delegation and permission chains |
| `anticipatory` | ~2,720 | Proactive memory surfacing and feedback loops |

### Infrastructure

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `account` | ~1,749 | Multi-tenant accounts, plan limits, billing integration |
| `prisma` | ~630 | Prisma client, RLS context, connection pooling |
| `storage` | ~1,759 | Storage provider abstraction (Prisma/Postgres) |
| `llm` | ~1,900 | LLM service abstraction (OpenAI, Anthropic, etc.) |
| `common` | ~3,418 | Guards (ApiKeyOrJwt, ApiKey), decorators, DTOs, shared utilities |
| `health` | ~1,752 | Health checks and readiness probes |
| `monitoring` | ~485 | Metrics and observability |
| `rate-limit` | ~682 | Per-user and per-plan rate limiting |
| `queue` | ~283 | Background job queue management |
| `events` | ~285 | Internal event bus (MemoryCreated, MemoryDeleted) |
| `utils` | ~589 | Date parsing, HTML sanitization, shared helpers |

### Sync & Integration

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `cloud-sync` | ~4,750 | Cloud sync pipeline — push/pull/reconciliation |
| `cloud-link` | ~739 | Cloud provider link management |
| `import` | ~1,914 | Legacy memory import |
| `import-v2` | ~1,161 | V2 import pipeline |
| `inbound-email` | ~1,403 | Email-to-memory ingestion |
| `webhooks` | ~1,301 | Outbound webhook delivery |
| `session-indexing` | ~603 | Session-based memory indexing |

### Analytics & Insights

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `analytics` | ~967 | Usage analytics and reporting |
| `awareness` | ~6,221 | Behavioral consistency analysis, waking cycle, signals (Linear, etc.) |
| `dashboard` | ~916 | Dashboard aggregations |
| `auto` | ~2,123 | Importance detection, automatic classification |
| `graph` | ~4,624 | Knowledge graph — entity extraction, relationships |
| `clustering` | ~833 | Memory clustering |
| `eval` | ~658 | Evaluation harness for recall quality |

### Billing & Auth

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `billing` | ~1,051 | Stripe billing integration |
| `stripe` | ~745 | Stripe webhook handling |
| `challenge` | ~1,005 | Auth challenge flows |
| `teams` | ~601 | Team management |
| `feedback` | ~284 | User feedback collection |
| `instance` | ~313 | Instance configuration |
| `scripts` | ~337 | CLI and maintenance scripts |

---

## Cross-Cutting Patterns

### Authentication
- `ApiKeyOrJwtGuard` (common) — standard guard for user-facing endpoints
- `ApiKeyGuard` (common) — simpler key-only guard for agent endpoints
- Both imported directly from `../common/guards/` — this is intentional NestJS cross-module usage

### Database Access
- All modules import `PrismaService` from `../prisma/prisma.service` directly
- `PrismaModule` is re-exported for modules that need it via `imports`
- RLS context set via `rlsContext` helper for multi-tenant isolation

### Events
- Internal pub/sub via NestJS event emitter
- `MemoryCreatedEvent` and `MemoryDeletedEvent` are the primary internal events
- Consumers: `ensemble` (re-embeds on create/delete), `correction` (checks contradictions)

### Embedding Pipeline
```
Memory Created
  → EmbeddingService.generate(raw)
  → VectorService.store(id, embedding)
  → CorrectionService.checkForContradictions (async, best-effort)
  → EnsembleService notified via event
```

### Memory Lifecycle
```
INGEST (raw text)
  → auto/importance-detector → importanceScore
  → embedding → vector stored
  → deduplication check
  → correction check (contradiction detection)
  → STORED in SESSION layer

CONSOLIDATION (nightly)
  → dream-cycle pulls SESSION memories
  → summarization + clustering
  → promoted to CORE layer
  → originals soft-deleted or superseded
```

---

## File Size Hotspots

Files exceeding 500 lines (candidates for future refactor):

| File | Lines | Notes |
|------|-------|-------|
| `memory/memory-query.service.ts` | 1,178 | Primary search logic — consider splitting by strategy |
| `memory/memory.service.ts` | 1,105 | CRUD + pipeline — consider separating write/read paths |
| `memory/memory.controller.ts` | 1,062 | Many endpoints — consider sub-controllers by domain |
| `deduplication/deduplication.service.ts` | 910 | Core dedup — consider splitting detection/resolution |
| `prefetch/topic-taxonomy.ts` | 802 | Static taxonomy data — could be JSON |
| `ensemble/ensemble.service.ts` | 795 | Ensemble logic — consider splitting provider selection |
| `consolidation/dream-cycle.service.ts` | 779 | Dream cycle stages — consider stage-per-file pattern |

---

## No Circular Dependencies ✅

As of 2026-03-14, `madge` reports zero circular dependency cycles.

## All Modules Have Tests ✅

All 55 modules contain at least one test file.
