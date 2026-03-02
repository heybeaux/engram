# Fog Index Continuous Improvement Plan

**Status:** Proposed
**Date:** 2026-03-02
**Authors:** Rook (diagnosis & implementation lead), Kit (intelligence layer & anticipatory memory lead)
**Goal:** Sustain Fog Index score of 75+ ("Clear"), targeting 90+ ("Crystal") long-term

---

## 1. Current State

| Component | Score | Weight | Detail |
|---|---|---|---|
| **Overall** | **57.2/100 "Mist"** | — | — |
| Memory Freshness | 23.3/100 | 25 | 696/5,966 memories accessed in 7 days (11.7%) |
| Embedding Coverage | 100/100 ✅ | 20 | Perfect |
| Dedup Health | 0/100 | 15 | 4,846 pending merge candidates |
| Consolidation Health | 100/100 ✅ | 20 | Perfect |
| Memory Vitality | 1.7/100 | 10 | 2,874 archived + 602 low-score (58.3% of total¹) |
| Coverage Breadth | 100/100 ✅ | 10 | Perfect |

¹ *Vitality decay percentage: (2,874 + 602) / 5,966 = 58.3%. The implementation code uses `(decayed + lowScore) / (total + decayed)` which can differ when archived memories inflate the denominator — the 58.3% figure uses total memory count as denominator for clarity.*

Three components are dragging the score: **Dedup Health** (0), **Memory Freshness** (23.3), and **Memory Vitality** (1.7). All three are addressable without architectural changes.

---

## 2. Immediate Fix: Snapshot Consistency

**Problem:** Fog index snapshots resolve to inconsistent scopes between calls, producing score jumps (31–48 range observed within the same hour).

**Fix:** Pin all fog index snapshot calculations to account-wide scope. The snapshot function must always resolve to the full account scope regardless of the calling context.

**Priority:** Immediate — without this, trending data is unreliable and all improvement measurement is compromised.

---

## 3. Phase 1: Quick Wins (This Week)

Target: **75+ "Clear"** within 2 weeks.

### 3.1 Dedup Drain Cron Job

**Problem:** 4,846 pending merge candidates. The Dream Cycle handles consolidation but doesn't drain dedup fast enough.

**Solution:** Dedicated dedup drainage job, separate from the Dream Cycle.

- **Schedule:** Every 4 hours
- **Batch size:** 500 candidates per run for the first week (aggressive backlog clearance), then 100–200 per run for ongoing maintenance
- **Backlog target:** Clear 4,846 within ~6 days at aggressive rate, then maintain near-zero
- **Safeguards:** Log all merges, dry-run mode for first 24 hours, skip candidates where confidence is below threshold (require human review)

**Impact:** Dedup Health 0 → 80+ (+12 weighted points)

### 3.2 Contextual Rehearsal Engine

**Problem:** Only 11.7% of memories accessed in the last 7 days. Most memories are going cold.

**Solution:** Scheduled recall queries that mirror actual agent usage patterns — not random recall.

- Analyze recent agent sessions to extract common query patterns (entities, topics, question types)
- Run those patterns as recall queries on a schedule to keep relevant memories warm
- Rotate query patterns weekly based on actual usage
- **Key principle (Kit):** Queries must mirror real usage, not game the metric. This is spaced repetition for memory pathways, not synthetic traffic.

**Implementation:**
1. Extract top query patterns from last 7 days of agent sessions
2. Build a query template pool (refreshed daily)
3. Run 50–100 recall queries every 6 hours from the pool
4. Track which memories get retrieved — feed into vitality scoring

**Impact:** Freshness 23.3 → 60+ (+9.2 weighted points)

#### Goodhart Mitigation

Rehearsal queries risk inflating the freshness metric (Goodhart's Law — optimizing the metric rather than the underlying goal). To prevent this:

- **Track organic freshness vs rehearsal-boosted freshness as separate metrics.**
  - *Organic freshness:* memories accessed through real agent sessions and user-initiated queries only
  - *Rehearsal-boosted freshness:* includes rehearsal-triggered accesses
- **The fog index must use organic freshness only.** Rehearsal-boosted freshness is a secondary monitoring metric to confirm the rehearsal engine is working, but it must not inflate the fog score.
- If the gap between organic and rehearsal-boosted freshness grows beyond a threshold (e.g., >15%), it signals the rehearsal engine is warming memories that aren't organically useful — review and adjust query patterns.

### 3.3 Vitality Formula Fix

**Problem:** The vitality metric penalizes archival equally with low-score decay. Archiving memories is the system working correctly — it shouldn't count against health.

**Solution:** Split the decay metric into two categories:

| Category | Treatment |
|---|---|
| **Intentional archival** (archived via consolidation, user action, or Dream Cycle) | Neutral — does not reduce vitality score |
| **Low-score zombies** (effectiveScore < 0.2, never archived, never accessed) | Penalized — these are the actual problem |

**Zombie triage process:**
- Identify memories with `effectiveScore < 0.2`
- If never accessed and older than 30 days → auto-archive
- If accessed but score decayed → flag for review (may be valuable but neglected)
- Run triage weekly as part of Dream Cycle

**Impact:** Vitality 1.7 → 50+ (+4.8 weighted points)

### Phase 1 Projected Score

| Component | Current | Projected | Δ Weighted |
|---|---|---|---|
| Memory Freshness | 23.3 | 60+ | +9.2 |
| Dedup Health | 0 | 80+ | +12.0 |
| Memory Vitality | 1.7 | 50+ | +4.8 |
| **Total** | **57.2** | **~83** | **+26** |

---

## 4. Phase 2: Intelligence Layer (Next 2 Weeks)

Target: **85+ sustained "Clear"** within 1 month.

### 4.1 Recall Precision Scoring

Wire `usedCount` into the fog index as a new component: **Recall Precision**.

- Track not just "was it retrieved" but "was it useful" — the retrieved-to-used ratio
- Memories with high retrieval count but low usage are noise candidates
- Flag high-retrieval/low-usage memories for review or re-embedding
- **New fog index component:** Recall Precision (weight: **8**, borrowed from Memory Freshness)

**Weight Rebalancing:**

| Component | Before | After | Δ |
|---|---|---|---|
| Memory Freshness | 25 | 22 | −3 |
| Embedding Coverage | 20 | 20 | — |
| Dedup Health | 15 | 15 | — |
| Consolidation Health | 20 | 20 | — |
| Memory Vitality | 10 | 10 | — |
| Coverage Breadth | 10 | 5 | −5 |
| **Recall Precision** | **—** | **8** | **+8** |
| **Total** | **100** | **100** | **0** |

> Freshness drops from 25 → 22 (rehearsal will inflate it anyway), Coverage Breadth from 10 → 5 (already at 100%, low signal). Recall Precision at 8 reflects that *quality* of recall matters more than raw access counts.

### 4.2 Contradiction Detection

When new memories conflict with existing ones on the same entity or topic, surface the conflict.

**V1 implementation:**
1. On memory creation, check for existing memories with the same entity tags
2. Compare values — if conflicting (e.g., "X uses PostgreSQL" vs "X uses MySQL"), flag
3. Apply temporal ordering: newer memory wins by default
4. If confidence scores are within 10% of each other, surface for human review

**Cross-Agent Contradiction Escalation:**

Cross-agent contradictions — where different agents' memories conflict on the same entity — must be flagged with **higher urgency** than single-agent temporal drift. Single-agent contradictions are typically outdated info (temporal drift), but cross-agent contradictions represent a **consensus failure**: multiple agents are operating on conflicting beliefs about the same fact. These should be surfaced immediately for human review, not deferred to the next Dream Cycle.

**Why this matters:** No other memory system handles contradictions well. Most silently accumulate conflicting facts. This is a competitive differentiator for Engram.

### 4.3 Forgetting Curves (Non-Linear Decay)

Replace the current linear decay model with exponential decay modified by access frequency.

**Model:**
- Base decay: exponential (half-life ~60 days for unaccessed memories)
- Access modifier: each access extends half-life by a multiplier
- Asymptotic floor: frequently accessed memories approach a minimum decay rate (near-permanent)
- Acceleration: memories never accessed after 90 days decay at 2x base rate

**Result:** More brain-like behavior. Important memories stabilize; forgotten ones fade faster. Current flat aging treats all memories equally, which doesn't match how memory actually works.

---

## 5. Phase 3: Anticipatory Memory (Future)

Target: **90+ "Crystal"** — aspirational.

### 5.0 Video Codec Architecture for Memory (HEY-431)

**Lead:** Kit

Apply video codec concepts (I-frame/P-frame/B-frame) to memory structure. The GOP (Group of Pictures) model maps to memory clusters:

- **I-frames (Anchors):** Self-contained core memories that provide full context on their own — identity facts, key decisions, foundational knowledge
- **P-frames (Dependents):** Memories that reference and build upon an anchor — deltas, updates, follow-ups
- **B-frames (Ephemeral Bridges):** Transient memories that bridge between anchors — session context, intermediate reasoning, working memory

**Applications:**
- **Recall context assembly:** When retrieving a P-frame, automatically include its anchor I-frame for full context
- **Dream Cycle optimization:** Consolidation can operate on GOP clusters — merge P-frames into updated I-frames, discard stale B-frames
- **Storage efficiency:** B-frames can be aggressively pruned; I-frames are protected from decay

**Schema: Memory Reference Graph (not single FK)**

Kit's original spec uses `referenceMemoryId` (single FK) for frame dependencies. This works for simple I→P chains but breaks for memories that bridge multiple GOPs — e.g., *"Decided to apply codec architecture to fog index improvement"* belongs to both the codec GOP and the fog index GOP.

**Use a many-to-many reference table from day one:**

```prisma
model MemoryReference {
  id               String         @id @default(uuid())
  sourceMemoryId   String         @map("source_memory_id")
  targetMemoryId   String         @map("target_memory_id")
  referenceType    ReferenceType  @default(DEPENDS_ON)

  sourceMemory     Memory   @relation("MemoryRefsOut", fields: [sourceMemoryId], references: [id])
  targetMemory     Memory   @relation("MemoryRefsIn", fields: [targetMemoryId], references: [id])

  @@unique([sourceMemoryId, targetMemoryId, referenceType])
  @@map("memory_references")
}

enum ReferenceType {
  DEPENDS_ON    // P-frame → I-frame anchor dependency
  BRIDGES       // B-frame connecting two GOPs
  SUPERSEDES    // Contradiction resolution (newer wins)
  DERIVED_FROM  // Consolidation lineage
}
```

**Why this matters:**
- `DEPENDS_ON` replaces single FK — same behavior, supports multiple anchors
- `BRIDGES` solves cross-GOP memories from day one (no v1→v2 migration later)
- `SUPERSEDES` gives contradiction detection (Phase 2) a schema to live in now
- `DERIVED_FROM` preserves consolidation lineage the dream cycle currently loses
- Recall logic stays clean: retrieve P-frame → follow DEPENDS_ON edges → auto-include I-frames

This is the same pattern as the existing knowledge graph entity relationships, applied to memory-to-memory links.

See full codec spec: `heybeaux/ops/specs/engram-codec-architecture.md`

> *Credit: Kit proposed the codec architecture mapping (HEY-431). Rook proposed the many-to-many reference graph refinement.*

### 5.1 Predictive Pre-Loading

**Lead:** Kit (Awareness/Waking Cycle domain)

Use external signals to predict what context an agent will need before a session starts:

- **Calendar events** → pre-warm memories related to meeting participants, topics
- **Git activity** → recent commits on a project → load that project's memory context
- **Linear tickets** → assigned/in-progress tickets → relevant technical context
- **Time patterns** → morning sessions tend to need X, evening sessions need Y

**The difference between a filing cabinet and a brain:** A filing cabinet waits for you to open the drawer. A brain has the relevant context ready before you ask.

### 5.2 Memory Confidence Decay on External Change

Memories about volatile subjects should lose confidence over time, independent of access patterns.

**Volatility tiers:**

| Tier | Examples | Confidence Half-Life |
|---|---|---|
| High volatility | Code implementations, API endpoints, config values | 30 days |
| Medium volatility | Project status, team structure, tool versions | 90 days |
| Low volatility | Personal identity, relationships, preferences | 365+ days |

- Tag memories with volatility ratings based on subject (auto-classify via entity type)
- When confidence drops below threshold → trigger re-verification prompt
- Prevents stale technical facts from being served with false confidence

### 5.3 ImageBind / Multi-Modal Embeddings (Research)

If Engram expands to ingest screenshots, voice notes, or video, [ImageBind](https://github.com/facebookresearch/ImageBind) enables cross-modal semantic search — a single query matching text, audio, and image memories simultaneously.

**Status:** Research phase. Evaluate when multi-modal ingestion becomes a concrete use case. No implementation work until then.

---

## 6. Fog Index Formula Improvements

Independent of the phased work above, the formula itself needs adjustments:

| Issue | Fix |
|---|---|
| Coverage Breadth returns 112.5 (more layers than expected) | Cap at 100 |
| Vitality penalizes healthy archival | Separate intentional archival from zombie decay (Phase 1) |
| No recall quality signal | Add Recall Precision component (Phase 2) |

---

## 7. Success Metrics

| Milestone | Target Score | Timeline |
|---|---|---|
| Phase 1 complete | 75+ "Clear" | 2 weeks |
| Phase 2 complete | 85+ sustained "Clear" | 1 month |
| Phase 3 (aspirational) | 90+ "Crystal" | 3–6 months |

**Measurement:** Weekly fog index snapshots (post-consistency fix), tracked in a time series. Score must sustain at target for 7+ consecutive days to count.

---

## 8. Philosophy

> Most AI memory systems are just vector stores with recall. Engram already has consolidation, dream cycles, and knowledge graphs. The next leap is making memory **active** instead of passive — a system that maintains itself, questions its own accuracy, and anticipates what you'll need. That's what separates a brain from a database.
>
> — Kit

---

## Contributors

- **Rook** — Diagnosis, Phase 1 proposals, implementation lead
- **Kit** — Contextual rehearsal refinement, vitality formula critique, Phase 2–3 proposals, predictive pre-loading lead
