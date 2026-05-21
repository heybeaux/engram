# Architecture

## Stack
- **Runtime**: NestJS (Node.js)
- **ORM**: Prisma
- **Database**: PostgreSQL + pgvector extension
- **Embeddings**: OpenAI, local models via ensemble system
- **Testing**: Jest

## Module Map

> 56 modules total. Sizes from architecture watchdog (2026-03-19).

### Core
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `memory` | CRUD, embedding generation, recall, temporal parsing, search | 72 | 19,696 |
| `prisma` | PrismaService singleton (wraps @prisma/client) | 9 | 630 |
| `storage` | Unified storage interface (Prisma-Postgres, SQLite providers) | 7 | 1,759 |
| `vector` | pgvector provider for similarity search | 10 | 1,614 |
| `embedding` | Unified embedding interface (local/cloud/ensemble providers) | 17 | 2,021 |
| `llm` | LLM abstraction layer (OpenAI, structured output) | 12 | 1,900 |
| `events` | Global event emitter module (NestJS EventEmitter) | 4 | 285 |
| `common` | Shared decorators, pipes, guards, utilities | 27 | 3,418 |
| `utils` | Utility functions (date parser, etc.) | 3 | 589 |

### Intelligence
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `ensemble` | Multi-model RRF fusion, drift detection, nightly re-embed, model registry | 17 | 7,696 |
| `correction` | Contradiction detection, memory superseding chains | 5 | 866 |
| `consolidation` | Merge duplicate/related memories, dream cycle | 34 | 7,837 |
| `deduplication` | Exact/near-duplicate detection, merge, lineage | 38 | 11,368 |
| `clustering` | Memory clustering | 5 | 833 |
| `hierarchy` | Hierarchical memory organization | 11 | 2,518 |
| `summarization` | Memory summarization | 6 | 731 |
| `fog-index` | Memory fog/decay scoring | 5 | 697 |
| `reembedding` | Re-embed memories with updated models | 9 | 2,004 |

### Awareness & Anticipation
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `awareness` | Waking cycle, behavioral analysis, insight generation, proactive notifications | 29 | 6,221 |
| `anticipatory` | Predictive context injection, strategy selection, circuit breaker | 19 | 2,720 |
| `auto` | Automated maintenance tasks, importance scoring | 10 | 2,123 |
| `prefetch` | Predictive cache (topic taxonomy, detection, metrics) | 13 | 5,453 |

### Access & Context
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `scoped-context` | Task-adaptive context budget allocation for agents | 5 | 1,037 |
| `multi-query` | Multi-query retrieval with result fusion and expansion rules | 13 | 4,155 |
| `memory-access-log` | Track memory access patterns | 6 | 736 |
| `memory-pool` | Memory pooling for agents and sessions | 5 | 588 |
| `graph` | Relationship graph between memories (entities, extraction) | 17 | 4,624 |
| `session-indexing` | Session-level memory indexing | 5 | 603 |
| `retrieval-signals` | Signal scoring for search ranking | 6 | 582 |

### Identity & Delegation
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `identity` | User identity profiles, portable identity, team profiles, delegation contracts, capability deltas | 66 | 11,480 |
| `entity-profile` | Entity profile management (attachments, semantic enrichment) | 15 | 2,455 |
| `delegation` | Agent delegation tasks, templates, recall | 17 | 838 |
| `challenge` | Challenge-response for identity verification | 7 | 1,005 |

### Platform
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `account` | Account management, JWT auth, admin endpoints, plan limits | 12 | 1,749 |
| `agent` | Agent profiles and config | 10 | 1,319 |
| `agent-recall` | Agent-scoped recall service | 6 | 1,162 |
| `agent-session` | Session management | 5 | 675 |
| `billing` | Billing plans and entitlement management | 9 | 1,051 |
| `teams` | Team management | 5 | 601 |
| `instance` | Instance/node management | 5 | 313 |
| `queue` | Background job queue | 3 | 283 |
| `stripe` | Stripe billing, subscriptions, webhook handling | 7 | 745 |
| `scripts` | CLI/maintenance scripts | 5 | 1,108 |

### Import
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `import` | Legacy data import pipeline | 12 | 1,914 |
| `import-v2` | Revised import pipeline (v2) | 9 | 1,161 |

### Cloud & Sync
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `cloud-link` | Cloud provider linking and credential management | 4 | 739 |
| `cloud-sync` | Bidirectional cloud sync, reconciliation, pull/ingest | 18 | 4,750 |
| `inbound-email` | Inbound email ingestion for memory creation | 9 | 1,403 |
| `webhooks` | Webhook registration, delivery with HMAC signing | 9 | 1,301 |

### Ops
| Module | Purpose | Files | Lines |
|---|---|---|---|
| `analytics` | Usage analytics | 9 | 967 |
| `monitoring` | Health/perf monitoring snapshots | 5 | 485 |
| `health` | Health check endpoints | 11 | 1,752 |
| `dashboard` | Admin dashboard UI and API | 6 | 916 |
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
- `memory-query.service.ts` (1,214 lines), `memory.service.ts` (1,105), `memory.controller.ts` (1,088), `deduplication.service.ts` (910) — top candidates for future file splitting
- `identity` module (67 files, 11.7k lines) is the largest module; consider sub-module breakdown
- `deduplication` module grew significantly (7.1k→11.4k lines) — review for splitting opportunity
- `topic-taxonomy.ts` (802 lines) — static data file, large but acceptable
- `scripts` module has no `.spec.ts` files (shell scripts, no TS tests needed)
- Cross-module direct imports are used for `PrismaService` and shared guards — acceptable NestJS pattern for infrastructure concerns

## Entry Point
`src/main.ts` → `src/app.module.ts` imports all feature modules.

---

## Deployment Modes & Cloud Link

For details on mode detection, feature gating, cloud link architecture, and backup sync protocol, see [Deployment Architecture](./architecture-deployment.md).
