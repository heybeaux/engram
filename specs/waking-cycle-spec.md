# Waking Cycle — Awareness Module for Engram

**Author:** Kit 🦊  
**Status:** Draft v1  
**Date:** 2026-02-17  
**Linear:** TBD (epic ticket)

---

## 1. Vision

Engram gives agents memory. The Waking Cycle gives them awareness — the ability to notice patterns, connect dots, and surface insights that nobody asked for but everybody needs.

**Dream Cycle** = sleep. Consolidate, prune, forget.  
**Waking Cycle** = awareness. Observe, connect, surface.

---

## 2. Core Concepts

### 2.1 INSIGHT Layer

A new memory layer type. Insights are memories produced by the Waking Cycle, not by direct user/agent interaction.

```
INSIGHT memory = {
  content: "Beaux mentioned being stuck on dream cycle pruning (Feb 14) but hasn't committed to engram since. The consolidation threshold config was changed 3 days ago — might be related.",
  layer: "INSIGHT",
  metadata: {
    insightType: "pattern_connection",    // see types below
    confidence: 0.72,                      // how confident the cycle is in this insight
    sources: ["mem_abc123", "mem_def456"], // memory IDs that contributed
    signalSource: "github+conversation",   // what triggered the observation
    actionable: true,                      // does this suggest someone should do something?
    expiresAt: "2026-02-24T00:00:00Z",    // insights can expire (stale = noise)
    acknowledged: false                    // has an agent/user seen this?
  }
}
```

### 2.2 Insight Types

| Type | Description | Example |
|------|-------------|---------|
| `pattern_connection` | Links between seemingly unrelated memories | "The auth bug from last week maps to today's API discussion" |
| `velocity_shift` | Change in project activity patterns | "Commit frequency on engram dropped 60% this week" |
| `stale_thread` | Unresolved conversation/issue going cold | "HEY-98 has been open 14 days with no updates" |
| `knowledge_gap` | Something the agent should know but doesn't | "3 mentions of 'RLS policies' but no memory explaining what they are in this context" |
| `recurring_pattern` | Same topic/issue keeps coming up | "This is the 4th time auth token expiry has caused a production issue" |
| `team_signal` | Observation about team dynamics | "Beaux has context-switched between 3 projects in the last 2 hours" |

### 2.3 Signal Sources

Where the Waking Cycle gets its raw observations:

| Source | What it watches | Priority |
|--------|----------------|----------|
| **Engram memories** | New memories, pattern shifts in knowledge graph | MVP |
| **Conversations** | Recent agent↔human exchanges (via memory) | MVP |
| **GitHub** | Commits, PRs, issues, staleness, velocity | v2 |
| **Linear** | Ticket status, blockers, aging issues | v2 |
| **Calendar** | Upcoming events, schedule pressure | v2 |
| **Email** | Unread count trends, urgent threads | v2 |
| **Custom webhooks** | User-defined signal sources | v2 |

---

## 3. Architecture

### 3.1 Module Structure

```
src/
  awareness/
    awareness.module.ts           # NestJS module (optional, guards on AWARENESS_ENABLED)
    waking-cycle.service.ts       # Main cycle orchestrator
    waking-cycle.scheduler.ts     # Cron scheduling (@Cron decorator)
    signals/
      signal.interface.ts         # Base signal interface
      memory-signal.service.ts    # Watches Engram memories + knowledge graph
      github-signal.service.ts    # GitHub repo monitoring
      linear-signal.service.ts    # Linear ticket monitoring
    analysis/
      pattern-detector.service.ts # Finds connections between observations
      insight-generator.service.ts # Produces INSIGHT memories from patterns
      confidence-scorer.service.ts # Scores insight quality/confidence
    config/
      awareness.config.ts         # Configuration (budgets, thresholds, schedule)
```

### 3.2 Cycle Flow

```
┌─────────────┐
│  Scheduler   │  Every 2-4 hours (configurable)
└──────┬──────┘
       ▼
┌─────────────┐
│   Collect    │  Query each signal source for new observations
│   Signals    │  (respecting rate limits + query budgets)
└──────┬──────┘
       ▼
┌─────────────┐
│   Analyze    │  Pattern detection across observations + existing memories
│   Patterns   │  Knowledge graph traversal for connections
└──────┬──────┘
       ▼
┌─────────────┐
│  Generate    │  LLM call to synthesize patterns into natural-language insights
│  Insights    │  Confidence scoring + dedup against existing insights
└──────┬──────┘
       ▼
┌─────────────┐
│   Store &    │  Save as INSIGHT layer memories
│   Surface    │  Flag high-confidence actionable insights for next recall
└─────────────┘
```

### 3.3 Resource Budgets

The Waking Cycle runs during active hours. It must not compete with user-facing queries.

| Resource | Budget per cycle | Rationale |
|----------|-----------------|-----------|
| DB queries | Max 50 | Prevent recall latency impact |
| Embedding calls | Max 10 | Expensive on cloud (API models) |
| LLM calls | Max 3 | Insight generation + confidence scoring |
| Wall time | Max 60s | Kill the cycle if it hangs |
| Insights produced | Max 5 per cycle | Noise control — fewer, better insights |

### 3.4 Configuration

```env
# Feature flag
AWARENESS_ENABLED=true

# Schedule (six-field cron expression, default every 4 hours during waking hours)
AWARENESS_SCHEDULE=0 0 8,12,16,20 * * *

# Resource budgets
AWARENESS_MAX_DB_QUERIES=50
AWARENESS_MAX_EMBEDDING_CALLS=10
AWARENESS_MAX_LLM_CALLS=3
AWARENESS_CYCLE_TIMEOUT_MS=60000
AWARENESS_MAX_INSIGHTS_PER_CYCLE=5

# Confidence threshold (insights below this are discarded)
AWARENESS_MIN_CONFIDENCE=0.5

# Insight TTL (days before an unacknowledged insight expires)
AWARENESS_INSIGHT_TTL_DAYS=14

# Signal sources (comma-separated)
AWARENESS_SIGNALS=memory,github,linear

# GitHub config
AWARENESS_GITHUB_REPOS=heybeaux/engram,heybeaux/engram-dashboard
AWARENESS_GITHUB_TOKEN=${GITHUB_TOKEN}

# Linear config  
AWARENESS_LINEAR_TEAM=HEY
AWARENESS_LINEAR_TOKEN=${LINEAR_TOKEN}
```

---

## 4. MVP Scope

**Goal:** One working cycle that produces useful insights from Engram memories alone.

### MVP Includes:
- [x] `awareness.module.ts` with `AWARENESS_ENABLED` guard
- [ ] `INSIGHT` layer type added to Prisma schema
- [ ] Memory signal source (query recent memories + knowledge graph)
- [ ] Pattern detector (basic: recurring topics, stale threads, knowledge gaps)
- [ ] Insight generator (single LLM call to synthesize)
- [ ] Confidence scorer (simple heuristic-based, not ML)
- [ ] Waking Cycle scheduler (configurable cron)
- [ ] Resource budget enforcement
- [ ] Insight dedup (don't regenerate the same insight)
- [ ] Source validation (verify referenced memory IDs exist before storing)
- [ ] Dashboard: insights visible in memories list with INSIGHT badge

### MVP Excludes (v2):
- GitHub/Linear signal sources (move to v2 — memory-only is complex enough for MVP)
- Calendar/email integration
- Custom webhooks
- ML-based confidence scoring
- Insight acknowledgement/feedback loop
- Push notifications for high-confidence insights
- Cross-agent insight sharing (Kit's insight visible to Rook)

### MVP Success Criteria:
1. Waking Cycle runs on schedule without impacting recall latency
2. Produces at least 1 useful, non-obvious insight per day
3. Confidence scoring filters out noise (>80% of surfaced insights rated useful by Beaux)
4. Insights appear in dashboard with proper filtering
5. Can be fully disabled with one env var

---

## 5. Insight Surfacing

How agents actually *see* insights during recall:

### 5.1 Passive Surfacing
Insights are memories. They appear in recall results naturally when relevant to the query. No special handling needed — ensemble search handles it.

### 5.2 Active Surfacing (v2)
High-confidence, actionable, unacknowledged insights get boosted in recall ranking. When an agent does a recall and there's a relevant insight with `confidence > 0.8` and `acknowledged: false`, it gets priority positioning.

### 5.3 Dashboard
- `INSIGHT` badge in Layer column (new color — suggest amber/gold)
- Filter by layer includes INSIGHT option
- Insight detail view shows source memories (clickable links)
- Confidence score visible
- "Acknowledge" button to mark as seen

---

## 6. Database Changes

### New enum value:
```prisma
enum MemoryLayer {
  SESSION
  IDENTITY
  PROJECT
  WORLD
  INSIGHT    // new
}
```

### New table (observation state):
```prisma
model AwarenessState {
  id            String   @id @default(cuid())
  signalSource  String   // "memory", "github", "linear"
  lastCheckedAt DateTime
  checkpoint    Json?    // source-specific cursor/state
  accountId     String
  account       Account  @relation(fields: [accountId], references: [id])
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([accountId, signalSource])
}
```

### Insight metadata stored in existing Memory.metadata JSON field
No new columns on the memories table. The insight-specific fields (confidence, sources, insightType, etc.) go in the existing `metadata` JSONB column.

---

## 7. Open Questions

1. **Should insights be agent-scoped or account-scoped?** If Kit generates an insight, should Rook see it on recall? (Leaning: account-scoped — insights benefit everyone.)

2. **LLM model for insight generation?** Needs to be good at synthesis but budget-friendly. Could use a smaller model (Claude Haiku / GPT-4o-mini) since it's background work.

3. **How aggressive should the confidence threshold be at launch?** Too low = noise. Too high = never surfaces anything. Start at 0.5 and tune?

4. **Should the Waking Cycle run on cloud, local, or both?** Cloud has API model access. Local has more compute freedom. Both?

5. **Feedback loop:** When Beaux dismisses a bad insight, should that train future confidence scoring? (Yes, but v2.)

---

## 8. Timeline

| Phase | What | When |
|-------|------|------|
| Spec review | This document | Now |
| Schema changes | INSIGHT enum + AwarenessState table | Week 1 |
| Memory signal source | Query recent memories + knowledge graph | Week 1-2 |
| Pattern detector + insight generator | Core analysis pipeline | Week 2-3 |
| Waking Cycle scheduler + budgets | Orchestration | Week 3 |
| Dashboard integration | INSIGHT badge, filter, detail view | Week 3-4 |
| Testing + tuning | Quality of insights, confidence calibration | Week 4 |
| **MVP ship** | | **~4 weeks** |

---

*Rook built the memory. This is the mind that uses it.* 🦊
