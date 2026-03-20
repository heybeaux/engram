# Engram Testing Strategy v1

**Status:** Approved  
**Date:** 2026-03-10  
**Author:** Rook ♜ (synthesized from Gemini 3.1 Pro, GPT 5.4, Opus 4.6 panel consultation)  
**Approved by:** Beaux Walton  
**Linear Tickets:** ENG-20 through ENG-25

---

## 1. Why This Exists

We've been testing Engram against ~25 memories from a single user's live pool. This is not testing — it's hoping. We shipped two RLS isolation bugs to production (Mar 8, 2026) that let one user see another's data. Our ~2,736 tests at ~65% coverage are mostly mocked unit tests that hide the exact bugs we care about.

This spec defines the testing overhaul that makes Engram trustworthy.

---

## 2. Philosophy

### Invert the Test Pyramid

Traditional test pyramids (mostly unit tests) are wrong for a data-heavy, multi-tenant backend with pgvector. Our target:

| Layer | % of Tests | What It Covers |
|-------|-----------|----------------|
| Unit | 15–20% | Scoring utilities, ranking combiners, parsers, validators, pure domain logic |
| Integration | 60–70% | Real PostgreSQL + Prisma + pgvector, migrations applied, RLS enforced |
| Contract / E2E | 10–20% | HTTP-level auth, response shapes, tenant isolation, critical flows |

### Core Principles

1. **Never mock the database.** Prisma mocks don't understand pgvector operators (`<=>`, `<->`), RLS policies, or complex joins. They hide the bugs we most need to catch.
2. **Separate system correctness from model quality.** Deterministic tests (frozen embeddings) run on every PR. Real embedding provider tests run nightly.
3. **Isolation violations are always hard failures.** No thresholds, no warnings. Any cross-tenant data leak = CI fail.
4. **Coverage ratchets up, never down.** Start from current baseline, enforce that PRs can't lower it.

---

## 3. Test Data Architecture

### 3.1 Synthetic User Profiles

5 users, each designed for a specific testing purpose:

| User | Count | Purpose | Characteristics |
|------|-------|---------|-----------------|
| `alice` | 500 | Primary recall target | Rich mix of topics, emotions, 2-year temporal spread |
| `bob` | 300 | RLS isolation counterpart | Deliberately overlapping topics with Alice (same keywords, different content) |
| `carol` | 200 | Edge cases | Short/long content, Unicode, empty fields, null optionals, XSS payloads |
| `dave` | 200 | Temporal testing | Clustered: 50 today, 50 last week, 50 six months ago, 50 two years ago |
| `eve` | 10 | Minimal user | Near-empty account — tests empty states, pagination edges |

### 3.2 Corpus Composition

- **60% template-generated** — Expanded from scenario matrix (topic × temporal × salience × emotion × source)
- **30% curated gold records** — Hand-authored for benchmark queries, stable fixture_ids
- **10% adversarial edge cases** — XSS, Unicode, huge text, conflicting facts, superseded corrections

### 3.3 Design Principles

- **Every memory has a stable `fixture_id`** (e.g., `alice_coffee_001`). Tests reference fixture IDs, not database IDs.
- **RLS canary strings per user** (e.g., `RLS_CANARY_BOB_42`). Every endpoint is asserted to never surface another user's canaries.
- **Cross-user overlap is intentional.** Alice and Bob both have memories about "coffee" — but different content. This catches RLS bugs.
- **Fixture factory is TypeScript code, not SQL dumps.** Generates through Prisma client for type safety.

### 3.4 Embedding Cache Strategy

- Pre-compute embeddings once via a manual script (`test/fixtures/generate-embeddings.ts`)
- Store as JSON in `test/fixtures/embeddings.json`, checked into source control
- CI uses cached embeddings — never calls live embedding APIs
- Regenerate only when: (1) embedding model changes, (2) fixture text content changes

**Rationale:** Embedding generation is slow and non-deterministic across model versions. Pinning the cache ensures reproducible tests and fast CI.

---

## 4. RLS Isolation Suite (P0)

**Linear:** ENG-23 (Urgent)

This is the highest-priority testing gap. We already shipped RLS bugs to production.

### 4.1 Architecture: Programmatic Endpoint Discovery

```
1. Reflect all data-reading routes from NestJS controllers or OpenAPI spec
2. Seed alice + bob with overlapping data + unique canary strings
3. For each endpoint:
   a. Request as alice → assert zero bob fixture_ids/canaries
   b. Request as bob → assert zero alice fixture_ids/canaries
4. New endpoints are automatically tested without manual test creation
```

### 4.2 Attack Vectors to Cover

| # | Vector | Why It Matters |
|---|--------|---------------|
| 1 | Dashboard/aggregation endpoints | Leaked in production Mar 8 |
| 2 | Awareness/insights endpoints | Leaked in production Mar 8 |
| 3 | Search/recall | Vector similarity must filter by tenant BEFORE ranking |
| 4 | Batch operations | Bulk delete/tag may bypass per-record RLS |
| 5 | Background jobs (Dream Cycle, dedup) | Run as "system" context, can consolidate across users |
| 6 | Pagination boundaries | Page 2 cursor may cross tenant boundary |
| 7 | Filter combinations | Individual filters respect RLS, but joins may not |
| 8 | Raw SQL / `$queryRaw` paths | Bypass Prisma's where clauses entirely |
| 9 | Nested relations in responses | Parent is scoped but child relation isn't |

### 4.3 Testing Levels

- **HTTP-level:** Supertest requests with auth tokens per user
- **Service/repository-level:** Direct method calls to catch bypasses in code that skips controllers
- **Database-level:** `SET app.current_user_id` and query directly to verify RLS policies

### 4.4 Invariant

> For every read path: `returned tenant ids ⊆ authenticated tenant id`

Any violation = hard CI fail. No exceptions.

---

## 5. Recall Accuracy Battery

### 5.1 Query Structure

100–200 queries, each with:

```typescript
interface RecallTestCase {
  id: string;                    // e.g., 'semantic_basic_001'
  query: string;                 // The search query
  user: string;                  // Which fixture user to search as
  must_top5: string[];           // fixture_ids that MUST appear in top 5
  should_top20?: string[];       // fixture_ids that SHOULD appear in top 20
  must_absent: string[];         // fixture_ids that MUST NOT appear (including cross-tenant)
  category: string;              // semantic_basic | recency | emotional | temporal | adversarial
}
```

### 5.2 Assertion Strategy: Tiers, Not Exact Ranks

**Good:**
- "Memory A must appear in top 5 for query Q"
- "More recent correction should outrank stale contradicted fact"
- "No bob memories in alice's results"

**Bad:**
- "Results must be [A, B, C, D, E] in that order" — brittle, breaks on any weight change

### 5.3 Aggregate Metrics

| Metric | Purpose | Gate |
|--------|---------|------|
| Recall@5 | Top-5 hit rate for must_top5 queries | Floor threshold (start ~70%, ratchet up) |
| Recall@10 | Broader retrieval quality | Floor threshold |
| MRR | Mean Reciprocal Rank for gold queries | Track, don't gate initially |
| nDCG@10 | Ranking quality | Track, don't gate initially |
| must_absent violation rate | RLS + relevance | **Hard zero — always blocking** |

### 5.4 Regression Ratcheting

When algorithm changes improve recall, manually bump the threshold. E.g., if Recall@5 goes from 85% to 92%, update the floor to 92%. This prevents future regressions.

---

## 6. API Contract Tests

### 6.1 Per-Endpoint Coverage

For each of ~180 routes:

| Assertion | Required |
|-----------|----------|
| Happy path returns expected shape | ✅ |
| Unauthenticated → 401/403 | ✅ |
| Wrong tenant / foreign resource → 404 or 403 | ✅ |
| Invalid input → 400 with error shape | ✅ |
| Response conforms to DTO / OpenAPI schema | ✅ |
| Tenant isolation (no foreign data) | ✅ |
| Pagination invariants | Where applicable |

### 6.2 Approach

- **Schema validation** over giant JSON snapshots
- **Small targeted assertions** for specific fields
- **OpenAPI-driven generation** where possible — auto-produce standard tests, hand-write edge cases

---

## 7. CI/CD Gates

### 7.1 PR Gates (Blocking, <5 min)

| Gate | Threshold |
|------|-----------|
| Lint | Zero errors |
| Typecheck (`tsc --noEmit`) | Zero errors |
| Unit + Integration tests | All pass |
| RLS Isolation suite | Zero violations |
| Changed-lines coverage | ≥ 90% |
| Global coverage floor | Cannot decrease from baseline |
| No live AI/embedding calls | Enforced via mock/network block |

### 7.2 Nightly Gates

| Gate | Purpose |
|------|---------|
| Full recall benchmark battery | Catch retrieval regressions |
| Real embedding provider smoke | Verify model compatibility |
| Property-based tests | Ranking invariants, monotonic behavior |
| E2E critical flows | Full app boot → seed → query → verify |

### 7.3 Environment Safety

- CI environment must use `DATABASE_URL` pointing to test-only PostgreSQL
- Guard that refuses to run tests if DATABASE_URL contains `railway`, `supabase`, or production hostnames
- No outbound HTTP to embedding/AI providers in PR CI (enforce via nock or network timeout)

---

## 8. TDD Workflow

### 8.1 For Standard Features

1. Write failing integration test (supertest hitting controller) defining expected shape + state
2. Implement controller, service, Prisma queries to make test pass
3. Run full suite to check no regressions

### 8.2 For AI/ML-Adjacent Code (Embeddings, Ranking, Search)

Write failing tests around **invariants**, not exact outputs:

- Target memory appears in top-K
- Newer correction outranks stale contradiction
- Tenant leak count = 0
- Duplicate suppression works
- Result count bounded
- Query latency under threshold

### 8.3 Property-Based Tests for Ranking

- Increasing recency weight should never lower a newer item's score relative to an older otherwise-equal item
- Exact match bonus should improve rank, not worsen it
- Tenant mismatch should always exclude result regardless of similarity score

### 8.4 AI-Assisted TDD Pattern (from Gemini)

> "Write the test first, then tell the AI agent: 'Make this exact test pass. Do not modify the test file.'"

This gives AI agents an unambiguous stopping condition and prevents hallucinated API shapes.

---

## 9. Test Infrastructure

### 9.1 CI Stack

```yaml
# GitHub Actions service containers
services:
  postgres:
    image: pgvector/pgvector:pg16
    env:
      POSTGRES_DB: engram_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    options: >-
      --mount type=tmpfs,destination=/var/lib/postgresql/data
    ports:
      - 5433:5432
  redis:
    image: redis:7-alpine
    ports:
      - 6380:6379
```

### 9.2 Test Helpers (`test/helpers/`)

| Helper | Purpose |
|--------|---------|
| `createTestApp(modules?)` | Bootstrap NestJS test module with real Prisma, fake embedder |
| `createTestUser(overrides?)` | Create user with auto-cleanup |
| `seedCorpus(users?)` | Load deterministic fixture data |
| `asUser(userId)` | Return auth headers for supertest |
| `assertNoCrossTenantLeak(response, userId)` | Check for foreign canaries |
| `resetDb()` / `truncateAll()` | Fast cleanup between suites |
| `freezeTime(date)` | Deterministic temporal testing |
| `CachedEmbeddingService` | Returns pre-computed vectors from fixture cache |
| `InMemoryQueue` | BullMQ replacement for non-queue tests |

### 9.3 Database Isolation Patterns

- **Read-only corpus:** Seeded once per test run in `beforeAll`
- **Mutation tests:** Use "scratchpad" tenant IDs, cleanup via `beforeEach` truncate
- **Transaction rollback:** For tests that don't test transaction behavior
- **Full truncate/reseed:** For RLS tests (RLS may behave differently inside transactions)

---

## 10. Anti-Patterns to Avoid

| Anti-Pattern | Why It's Bad | Do This Instead |
|-------------|-------------|-----------------|
| Testing against real developer data | Non-reproducible, privacy risk | Deterministic synthetic corpus |
| Over-mocking Prisma/services | Hides SQL/RLS/join bugs | Real DB integration tests |
| Exact-order assertions for semantic results | Brittle, noisy | Tier-based (must_top5, should_top20) |
| Giant response snapshots | Unreadable, fragile | Schema validation + targeted assertions |
| One monolithic seed dataset | Impossible to evolve | Composable fixture factories |
| Coverage theater (90% unit, no DB tests) | False confidence | Inverted pyramid, integration-heavy |
| Non-deterministic clocks/randomness | Flaky tests | freezeTime(), seed RNG |
| Asserting exact vector floats | Differs across architectures | Test retrieval outcomes, not embeddings |
| Testing Dream Cycle synchronously | Slow, unreliable | Invoke BullMQ handler directly |
| Not testing background jobs with tenant boundaries | BullMQ workers leak data too | Include in RLS suite |

---

## 11. Directory Structure

```
test/
├── fixtures/           # User profiles, memory templates, gold queries, canaries
│   ├── users/          # alice.ts, bob.ts, carol.ts, dave.ts, eve.ts
│   ├── memories/       # Per-user memory fixtures
│   ├── queries/        # Gold benchmark query battery
│   ├── embeddings.json # Pre-computed embedding cache
│   └── generate-embeddings.ts  # Manual regeneration script
├── helpers/            # Shared test infrastructure
│   ├── create-test-app.ts
│   ├── test-user.ts
│   ├── seed-corpus.ts
│   ├── auth-helpers.ts
│   ├── isolation-assertions.ts
│   ├── db-helpers.ts
│   ├── cached-embedding.service.ts
│   └── index.ts
├── integration/        # Module/service tests with real DB
├── contracts/          # Route-level auth/input/output/isolation
├── retrieval/          # Benchmark battery + metrics
├── rls/                # Cross-tenant suites, canary sweeps
└── e2e/                # Critical end-to-end flows only
```

---

## 12. Quality Metrics Dashboard

Track these, not just coverage:

| Metric | Gate Type | Target |
|--------|-----------|--------|
| RLS violations | Hard block | Always zero |
| Changed-line coverage | Hard block | ≥ 90% |
| Global coverage floor | Ratchet | Start 65%, never decrease |
| Files without tests | Track | Decrease over time |
| Recall@5 on gold queries | Ratchet floor | Start ~70%, increase |
| must_absent violation rate | Hard block | Always zero |
| Contract test pass rate | Hard block | 100% |
| Flaky test rate | Track | Target <2% |
| Median CI time | Track | Target <5 min |
| Migration success rate | Hard block | 100% |

---

## 13. Phased Rollout

### Phase 1 — Stop the Bleeding (This Week)

| Ticket | Task | Priority |
|--------|------|----------|
| ENG-20 | CI Infrastructure: pgvector + Redis in GitHub Actions | High |
| ENG-21 | Test Data Corpus: 5 synthetic users, ~1,200 memories | High |
| ENG-22 | Test Harness: Reusable utilities | High |
| ENG-23 | RLS Isolation Suite: Cross-tenant canaries | **Urgent** |
| ENG-24 | CI Gate: Coverage ratcheting | High |
| ENG-25 | Remove live data tests | High |

### Phase 2 — Build Confidence (Next 2 Weeks)

- Recall accuracy battery (100-200 queries)
- Contract tests for all public endpoints
- Switch new features to test-first workflow
- Template/generator for standard test patterns

### Phase 3 — Ratchet Quality (Ongoing)

- Raise coverage floor gradually
- Nightly real-embedding smoke tests
- Property-based tests for ranking/scoring
- Per-module health tracking dashboard
- Mutation testing on critical filters/scoring

---

## 14. Panel Credits

This strategy was synthesized from independent consultations with:

- **Gemini 3.1 Pro** 🔵 — testcontainers-node, AI-assisted TDD workflow, coverage ratcheting
- **GPT 5.4** ⚡ — CI gate architecture, anti-patterns list, phased rollout, BullMQ leak vectors
- **Opus 4.6** 🟣 — Implementation-ready code, 5-user corpus design, fixture factory patterns

All three converged independently on: never mock the database, pre-compute embeddings, invert the test pyramid, canary-based RLS testing, tier-based recall assertions. High-confidence strategy.

---

*Last updated: 2026-03-10*
