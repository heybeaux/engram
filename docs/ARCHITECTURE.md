# Architecture

## Stack
- **Runtime**: NestJS (Node.js)
- **ORM**: Prisma
- **Database**: PostgreSQL + pgvector extension
- **Embeddings**: OpenAI, local models via ensemble system
- **Testing**: Jest

## Module Map

> 50 modules total. Sizes from architecture watchdog (2026-03-04).

### Core
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `memory` | CRUD, embedding generation, recall, temporal parsing, search | 58 | 15,307 |
| `prisma` | PrismaService singleton (wraps @prisma/client) | 6 | 554 |
| `storage` | Unified storage interface (Prisma-Postgres, SQLite providers) | 7 | 1,759 |
| `vector` | pgvector provider for similarity search | 8 | 1,149 |
| `embedding` | Unified embedding interface (local/cloud/ensemble providers) | 15 | 1,530 |
| `llm` | LLM abstraction layer (OpenAI, structured output) | 11 | 1,551 |
| `events` | Global event emitter module (NestJS EventEmitter) | 4 | 285 |
| `common` | Shared decorators, pipes, guards, utilities | 27 | 3,418 |
| `utils` | Utility functions (date parser, etc.) | 3 | 589 |

### Intelligence
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `ensemble` | Multi-model RRF fusion, drift detection, nightly re-embed, model registry | 17 | 7,594 |
| `correction` | Contradiction detection, memory superseding chains | 4 | 697 |
| `consolidation` | Merge duplicate/related memories, dream cycle | 24 | 5,664 |
| `deduplication` | Exact/near-duplicate detection, merge, lineage | 17 | 7,103 |
| `clustering` | Memory clustering | 5 | 833 |
| `hierarchy` | Hierarchical memory organization | 10 | 2,269 |
| `summarization` | Memory summarization | 6 | 731 |
| `fog-index` | Memory fog/decay scoring | 5 | 697 |
| `reembedding` | Re-embed memories with updated models | 9 | 1,999 |

### Awareness & Anticipation
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `awareness` | Waking cycle, behavioral analysis, insight generation, proactive notifications | 29 | 6,203 |
| `anticipatory` | Predictive context injection, strategy selection, circuit breaker | 18 | 2,300 |
| `auto` | Automated maintenance tasks, importance scoring | 10 | 2,123 |
| `prefetch` | Predictive cache (topic taxonomy, detection, metrics) | 13 | 5,453 |

### Access & Context
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `scoped-context` | Task-adaptive context budget allocation for agents | 5 | 1,037 |
| `multi-query` | Multi-query retrieval with result fusion and expansion rules | 12 | 3,952 |
| `memory-access-log` | Track memory access patterns | 6 | 736 |
| `memory-pool` | Memory pooling for agents and sessions | 5 | 588 |
| `graph` | Relationship graph between memories (entities, extraction) | 17 | 4,624 |
| `session-indexing` | Session-level memory indexing | 5 | 603 |

### Identity & Delegation
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `identity` | User identity profiles, portable identity, team profiles, delegation contracts, capability deltas | 65 | 11,109 |
| `delegation` | Agent delegation tasks, templates, recall | 17 | 838 |
| `challenge` | Challenge-response for identity verification | 6 | 706 |

### Platform
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `account` | Account management, JWT auth, admin endpoints, plan limits | 12 | 1,749 |
| `agent` | Agent profiles and config | 10 | 1,319 |
| `agent-session` | Session management | 5 | 675 |
| `teams` | Team management | 5 | 601 |
| `instance` | Instance/node management | 5 | 313 |
| `queue` | Background job queue | 3 | 283 |
| `stripe` | Stripe billing, subscriptions, webhook handling | 7 | 745 |
| `scripts` | CLI/maintenance scripts | 1 | 99 |

### Cloud & Sync
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `cloud-link` | Cloud provider linking and credential management | 4 | 737 |
| `cloud-sync` | Bidirectional cloud sync, reconciliation, pull/ingest | 17 | 4,432 |
| `inbound-email` | Inbound email ingestion for memory creation | 9 | 1,372 |
| `webhooks` | Webhook registration, delivery with HMAC signing | 9 | 1,301 |

### Ops
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `analytics` | Usage analytics | 9 | 967 |
| `monitoring` | Health/perf monitoring snapshots | 5 | 485 |
| `health` | Health check endpoints | 6 | 667 |
| `dashboard` | Admin dashboard UI and API | 6 | 905 |
| `rate-limit` | Rate limiting | 7 | 682 |
| `eval` | Evaluation framework | 5 | 658 |
| `feedback` | User feedback on recall quality | 6 | 284 |

## Layer Rules
1. **Controllers** handle HTTP, validate DTOs, delegate to services
2. **Services** contain business logic, call Prisma/providers
3. **Providers** wrap external systems (pgvector, OpenAI)
4. Controllers never call Prisma directly
5. Services don't import from other module's internals — use NestJS DI

## Known Architecture Notes
- `memory.controller.ts` (934 lines), `memory-query.service.ts` (913), `deduplication.service.ts` (910) — candidates for future file splitting
- `identity` module (65 files, 11k lines) is the largest module; consider sub-module breakdown
- `scripts` module has no `.spec.ts` files (shell scripts, no TS tests needed)
- Cross-module direct imports are used for `PrismaService` and shared guards — acceptable NestJS pattern for infrastructure concerns

## Entry Point
`src/main.ts` → `src/app.module.ts` imports all feature modules.

---

## Deployment Modes & Cloud Link

For details on mode detection, feature gating, cloud link architecture, and backup sync protocol, see [Deployment Architecture](./architecture-deployment.md).
