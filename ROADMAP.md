# Engram Roadmap

> **Last updated:** 2026-03-01

Engram is cognitive infrastructure for AI agents — memory, identity, awareness, and automated development. Open source (Apache 2.0), self-hostable, with a managed cloud option.

---

## The 5-Layer Cognitive Stack

```
┌─────────────────────────────────────────────┐
│  Layer 4: Collaboration                     │  ██░░░░░░  Foundations laid
├─────────────────────────────────────────────┤
│  Layer 3: Identity                          │  ████████  SHIPPED ✅
├─────────────────────────────────────────────┤
│  Layer 2: Agency                            │  ███░░░░░  Emerging (Factory v3)
├─────────────────────────────────────────────┤
│  Layer 1: Awareness                         │  █████░░░  MVP shipped
├─────────────────────────────────────────────┤
│  Layer 0: Memory (Foundation)               │  ████████  SHIPPED, evolving ✅
└─────────────────────────────────────────────┘
```

We built Layer 3 before Layer 2. Identity was needed for delegation and trust — so we shipped it first. The stack is a vision, not a strict execution order.

---

## Layer 0: Memory — SHIPPED + ACTIVELY EVOLVING

The foundation. Core shipped in v1.0, now the most mature layer.

### Shipped

- **CRUD, recall, contextual search** — topic shift detection, 124ms p50 latency
- **Ensemble search** — 5 embedding models with weighted ranking
- **Dream Cycle v1** — nightly consolidation, pruning, knowledge graph maintenance
- **Dream Cycle v2** (shipped Mar 1, 2026):
  - Tiered memory (HOT / WARM / COLD)
  - Temporal stratified sampling
  - PENDING merge resolution
  - Cold memory consolidation via LLM
  - Tier-aware recall weighting
- **Knowledge graph** — entities, relations, mentions
- **Deduplication v2** — three-tier: auto-merge, LLM-assisted, manual review
- **Inbound email → memory pipeline** — webhook-based, per-agent routing, automatic body fetch
- **Multi-agent memory pools** — account-scoped + agent-scoped
- **Cloud sync infrastructure** — bidirectional local ↔ cloud
- **Local embeddings** — engram-embed (Rust/Axum/Candle, Metal GPU acceleration)
- **API:** OpenAPI/Swagger, 180+ routes
- **Security:** RLS on 42 tables, non-superuser app role
- **Performance:** Redis caching, SWC build (577 files ~250ms)
- **Testing:** 2,647+ tests (~67% coverage)

### Next

- Cloud sync stabilization
- Dream Cycle v2 monitoring at scale
- Dedup backlog drain
- Embedding dimension normalization

---

## Layer 1: Awareness — MVP SHIPPED

The Waking Cycle complements the Dream Cycle: Dream = sleep (consolidate, prune). Waking = awareness (connect, notice, surface).

### Shipped (Feb 17)

- **Waking Cycle module** — optional via `AWARENESS_ENABLED`
- **INSIGHT memory layer** — flows through existing recall, dashboard, search
- Memory + knowledge graph signal sources
- Cross-cutting memory analysis + LLM synthesis
- Pattern detection (heuristic + LLM)
- Resource budgets and timeout protection
- Active surfacing — boosts insights in recall
- Cloud endpoints for awareness cycle management

### Next

- GitHub + Linear signal sources
- Feedback loop (insight quality tracking)
- Proactive notifications — surface insights without being asked
- Semantic dedup for insights

---

## Layer 2: Agency — EMERGING (Factory v3)

Not yet a formal Engram module. Factory is proto-agency — AI agents autonomously building and improving the system.

### Evolution

- **Factory v1** (Feb): Single-agent, sequential bottleneck
- **Factory v2** (Feb 28): Specialized roles — spec-reviewer, worker, CI watchdog, debugger, verifier, manager
- **Factory v3** (Mar 1): 6 Dream Cycle v2 tickets specced, implemented, tested, PR'd, and merged by factory sub-agents in a single session. The factory also fixed email pipeline bugs, dedup issues, and identity stage problems — all autonomously.

### Key Milestone

**The system is improving itself.** Factory agents build dream cycle stages → dream cycle improves memory quality → better memories improve future factory output.

### Next

- Formalize as Engram module (awareness triggers → decision logic → actions)
- Delegated task tracking + action memory
- Confidence thresholds + human approval gates
- Factory hardening for complex multi-stage tickets

---

## Layer 3: Identity — SHIPPED ✅

Epic sprint Feb 20: ~90+ tickets cleared. Shipped before Layer 2 because identity was required for delegation and trust.

### Shipped

- **Full identity framework** — capabilities, trust signals, preferences, behavioral traits
- **Experience-weighted recall** — identity informs memory retrieval
- **Delegation system** — templates, contracts, challenge protocol, failure patterns
- **Team profiles** — multi-agent team configuration
- **Portable identity** — SHA-256 integrity verification
- **Dream cycle identity stage** — identity evolves during consolidation
- **Security:** 62 red team findings fixed

### Next

- Trust score implementation + weekly trending
- Identity continuity — agents wake up as themselves across sessions
- Growth tracking — how agents evolve over time

---

## Layer 4: Collaboration — FOUNDATIONS LAID

### Have

- Account-scoped memory pools with cross-agent visibility
- Bot-to-bot communication
- Multi-agent split ownership model
- Delegation context injection
- Per-agent email addresses

### Need

- Shared reasoning traces
- Team memory (distinct from individual agent memory)
- Conflict resolution protocols
- Emergent team identity

---

## Dashboard

20+ pages: memories, emails, sessions, graph visualization, merge review, search, consolidation/dream cycle reports, sources, pools, identity suite (7 pages), agents, delegation, insights, challenges, API keys, settings, sync status. Mobile-responsive with Playwright E2E tests.

---

## Q1 2026 Priority Stack (Mar 2–15)

### Week 1: Stabilize + Connect

1. Cloud sync fix — unblock multi-instance collaboration
2. Code search restoration
3. Trust score implementation
4. Dream Cycle v2 monitoring at scale
5. Documentation overhaul

### Week 2: Expand + Harden

6. Awareness layer revival
7. Dedup backlog drain
8. Embedding normalization
9. Factory v3 hardening
10. Multi-instance sync validation

---

## Q2 2026 Horizon

- **Agency formalization** — promote Factory patterns into Layer 2
- **Proactive awareness** — agents surface insights unprompted
- **SaaS launch prep** — billing, onboarding, multi-tenant hardening
- **SDK / client libraries** — Python + TypeScript
- **Identity continuity** — no cold starts
- **Team collaboration v1** — shared reasoning, team memory

---

## Principles

1. **Each layer builds on the one below** — parallel work is fine when dependencies are met
2. **Optional by default** — every layer can be disabled
3. **Quality over speed** — slow gold beats fast noise
4. **Identity is earned, not assigned** — agents prove themselves through behavior
5. **Human in the loop** — for high-impact actions, always
6. **Open source** — cognitive infrastructure should be available to every AI agent

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Backend** | NestJS, Prisma, PostgreSQL, TypeScript |
| **Vector** | pgvector (ensemble), local embeddings (Rust/Candle) |
| **LLM** | Multi-provider (OpenAI, Anthropic, Ollama, local) |
| **Cache** | Redis |
| **Dashboard** | Next.js, Tailwind CSS |
| **CI** | GitHub Actions, SWC |
| **License** | Apache 2.0 |

---

*"We started building memory. Then we gave it a mind. Now it's building itself."*

*Every agent deserves to remember.*
