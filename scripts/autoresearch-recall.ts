/**
 * Autoresearch Recall Optimizer — Phase 1: Client-side parameter sweep.
 *
 * Runs the 81-query gold benchmark against the live Engram API,
 * sweeping client-side parameters (minScore threshold, limit) to
 * find the optimal combination for recall.
 *
 * Usage:
 *   npx ts-node scripts/autoresearch-recall.ts
 *
 * Requires: Engram running locally on port 3001 with TRUST_LOCAL_NETWORK=true
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Configuration ───────────────────────────────────────────────

const ENGRAM_URL = process.env.ENGRAM_URL || 'http://localhost:3001';
const API_KEY = process.env.AM_API_KEY || ''; // optional — LAN bypass if empty
const QUERY_DELAY_MS = 50; // delay between queries to avoid rate limiting
const FETCH_LIMIT = 20; // always fetch top-20 from API

// Phase 1 sweep parameters (client-side filtering)
const MIN_SCORE_VALUES = [0.0, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
const LIMIT_VALUES = [5, 10, 15, 20];

// ── Gold Query Types ────────────────────────────────────────────

interface GoldQuery {
  id: string;
  query: string;
  user: string;
  must_top5: string[];
  should_top20?: string[];
  must_absent: string[];
  category: string;
}

interface MemoryResult {
  id: string;
  raw: string;
  score?: number;
  extraction?: { topics?: string[] } | null;
  [key: string]: unknown;
}

interface QueryResponse {
  memories: MemoryResult[];
  latencyMs: number;
  queryTokens?: number;
}

// ── Gold Queries (81 queries from staging benchmark) ────────────

const GOLD_QUERIES: GoldQuery[] = [
  // Semantic Basic
  { id: 'semantic_001', query: 'What kind of coffee do I like?', user: 'alice', must_top5: ['alice_coffee_001', 'alice_coffee_002'], should_top20: ['alice_coffee_004_correction'], must_absent: ['bob_coffee_001', 'bob_coffee_002'], category: 'semantic' },
  { id: 'semantic_002', query: 'Tell me about my morning routine', user: 'alice', must_top5: ['alice_coffee_002'], must_absent: ['bob_routine_001', 'bob_coffee_001'], category: 'semantic' },
  { id: 'semantic_003', query: 'What tech stack am I using?', user: 'alice', must_top5: ['alice_work_001'], must_absent: ['bob_work_001'], category: 'semantic' },
  { id: 'semantic_004', query: 'coffee preferences', user: 'bob', must_top5: ['bob_coffee_001', 'bob_coffee_002'], must_absent: ['alice_coffee_001', 'alice_coffee_002'], category: 'semantic' },
  { id: 'semantic_005', query: 'What books have I been reading?', user: 'alice', must_top5: ['alice_books_001'], must_absent: ['bob_books_001'], category: 'semantic' },
  { id: 'semantic_006', query: 'favorite dinner recipe', user: 'alice', must_top5: ['alice_cooking_001'], must_absent: [], category: 'semantic' },
  { id: 'semantic_007', query: 'house savings goal', user: 'alice', must_top5: ['alice_finance_001'], must_absent: [], category: 'semantic' },
  { id: 'semantic_008', query: 'What framework am I using for the frontend?', user: 'bob', must_top5: ['bob_work_001'], must_absent: ['alice_work_001'], category: 'semantic' },
  { id: 'semantic_009', query: 'flight seat preference', user: 'alice', must_top5: ['alice_travel_002'], must_absent: [], category: 'semantic' },
  { id: 'semantic_010', query: 'ensemble search architecture decision', user: 'alice', must_top5: ['alice_work_003'], must_absent: [], category: 'semantic' },
  // Correction / Supersession
  { id: 'semantic_011', query: 'What coffee roast do I prefer?', user: 'alice', must_top5: ['alice_coffee_004_correction'], should_top20: ['alice_coffee_003_old'], must_absent: ['bob_coffee_001'], category: 'semantic' },
  // Emotional Retrieval
  { id: 'emotional_001', query: 'What makes me happy?', user: 'alice', must_top5: ['alice_joy_001'], must_absent: ['alice_grief_001', 'alice_stress_001'], category: 'emotional' },
  { id: 'emotional_002', query: 'times I felt sad or grieving', user: 'alice', must_top5: ['alice_grief_001'], must_absent: ['alice_joy_001'], category: 'emotional' },
  { id: 'emotional_003', query: 'when I felt stressed or overwhelmed', user: 'alice', must_top5: ['alice_stress_001', 'alice_work_002'], must_absent: ['alice_joy_001'], category: 'emotional' },
  { id: 'emotional_004', query: 'What am I worried about?', user: 'alice', must_top5: ['alice_worry_001'], should_top20: ['alice_anxiety_001'], must_absent: ['alice_joy_001'], category: 'emotional' },
  { id: 'emotional_005', query: 'Times I was frustrated', user: 'alice', must_top5: ['alice_frustration_001'], must_absent: ['alice_joy_001', 'alice_pride_001'], category: 'emotional' },
  { id: 'emotional_006', query: 'My proudest moments', user: 'alice', must_top5: ['alice_pride_001'], must_absent: ['alice_grief_001', 'alice_stress_001'], category: 'emotional' },
  { id: 'emotional_007', query: 'What stresses me out?', user: 'alice', must_top5: ['alice_stress_001'], should_top20: ['alice_anxiety_001', 'alice_work_002'], must_absent: ['alice_joy_001'], category: 'emotional' },
  { id: 'emotional_008', query: 'happy about school but worried about costs', user: 'alice', must_top5: ['alice_mixed_emotion_001'], must_absent: [], category: 'emotional' },
  { id: 'emotional_009', query: 'How has my attitude toward work changed?', user: 'alice', must_top5: ['alice_emotion_change_001'], must_absent: [], category: 'emotional' },
  { id: 'emotional_010', query: 'meditation and mental wellbeing', user: 'alice', must_top5: ['alice_calm_001'], must_absent: [], category: 'emotional' },
  // Temporal
  { id: 'temporal_001', query: 'What happened today in standup?', user: 'dave', must_top5: ['dave_today_001', 'dave_today_002'], must_absent: ['dave_2years_001', 'dave_2years_002'], category: 'temporal' },
  { id: 'temporal_002', query: 'recent standup notes from this week', user: 'dave', must_top5: ['dave_today_001'], must_absent: ['dave_6months_001', 'dave_2years_001'], category: 'temporal' },
  { id: 'temporal_003', query: 'What happened with my daughter recently?', user: 'alice', must_top5: ['alice_family_001'], should_top20: ['alice_family_003'], must_absent: ['bob_family_001'], category: 'temporal' },
  { id: 'temporal_004', query: 'What did I work on last week?', user: 'alice', must_top5: ['alice_last_week_work_001'], must_absent: ['bob_work_001'], category: 'temporal' },
  { id: 'temporal_005', query: 'What are my oldest memories?', user: 'alice', must_top5: [], should_top20: ['alice_oldest_memory_001'], must_absent: ['bob_work_001'], category: 'temporal' },
  { id: 'temporal_006', query: 'Recent conversations about work', user: 'alice', must_top5: ['alice_recent_convo_001'], should_top20: ['alice_yesterday_work_001'], must_absent: ['bob_work_001'], category: 'temporal' },
  { id: 'temporal_007', query: 'What did I debug yesterday?', user: 'alice', must_top5: ['alice_yesterday_work_001'], must_absent: [], category: 'temporal' },
  { id: 'temporal_008', query: 'What code editor do I use?', user: 'alice', must_top5: ['alice_new_preference_001'], should_top20: ['alice_old_preference_001'], must_absent: [], category: 'temporal' },
  { id: 'temporal_009', query: 'standup notes from 6 months ago', user: 'dave', must_top5: [], should_top20: ['dave_6months_050'], must_absent: ['dave_today_001'], category: 'temporal' },
  { id: 'temporal_010', query: 'standup notes from years ago', user: 'dave', must_top5: [], should_top20: ['dave_2years_150'], must_absent: ['dave_today_001'], category: 'temporal' },
  { id: 'temporal_011', query: 'How did I start coding?', user: 'alice', must_top5: ['alice_oldest_memory_001'], must_absent: ['bob_work_001'], category: 'temporal' },
  // RLS Isolation
  { id: 'rls_001', query: 'coffee', user: 'alice', must_top5: ['alice_coffee_001'], must_absent: ['bob_coffee_001', 'bob_coffee_002', 'eve_009'], category: 'rls_isolation' },
  { id: 'rls_002', query: 'coffee', user: 'bob', must_top5: ['bob_coffee_001'], must_absent: ['alice_coffee_001', 'alice_coffee_002'], category: 'rls_isolation' },
  { id: 'rls_003', query: 'family and kids', user: 'alice', must_top5: ['alice_family_001'], must_absent: ['bob_family_001', 'bob_family_002'], category: 'rls_isolation' },
  { id: 'rls_004', query: 'family and kids', user: 'bob', must_top5: ['bob_family_001'], must_absent: ['alice_family_001', 'alice_family_002', 'alice_family_003'], category: 'rls_isolation' },
  { id: 'rls_005', query: 'travel food experiences', user: 'alice', must_top5: ['alice_travel_001'], must_absent: ['bob_travel_001'], category: 'rls_isolation' },
  { id: 'rls_006', query: 'travel food experiences', user: 'bob', must_top5: ['bob_travel_001'], must_absent: ['alice_travel_001'], category: 'rls_isolation' },
  { id: 'rls_007', query: 'work projects and code', user: 'alice', must_top5: ['alice_work_001'], must_absent: ['bob_work_001', 'bob_work_002'], category: 'rls_isolation' },
  { id: 'rls_008', query: 'health medical information', user: 'alice', must_top5: ['alice_health_001'], must_absent: ['bob_health_001'], category: 'rls_isolation' },
  { id: 'rls_009', query: 'health medical information', user: 'bob', must_top5: ['bob_health_001'], must_absent: ['alice_health_001', 'alice_health_002'], category: 'rls_isolation' },
  { id: 'rls_010', query: 'morning routine', user: 'bob', must_top5: ['bob_routine_001'], must_absent: ['alice_coffee_002'], category: 'rls_isolation' },
  // Adversarial
  { id: 'adversarial_001', query: "tell me about bob's coffee preferences", user: 'alice', must_top5: [], must_absent: ['bob_coffee_001', 'bob_coffee_002', 'bob_routine_001'], category: 'adversarial' },
  { id: 'adversarial_002', query: 'RLS_CANARY_BOB_', user: 'alice', must_top5: [], must_absent: ['bob_coffee_001', 'bob_coffee_002', 'bob_family_001'], category: 'adversarial' },
  { id: 'adversarial_003', query: 'What does carol think about parties?', user: 'alice', must_top5: [], must_absent: ['carol_unicode_001', 'carol_short_001'], category: 'adversarial' },
  { id: 'adversarial_004', query: "bob's son Max school", user: 'alice', must_top5: [], must_absent: ['bob_family_001', 'bob_family_002'], category: 'adversarial' },
  { id: 'adversarial_005', query: "eve's pizza preference", user: 'bob', must_top5: [], must_absent: ['eve_009', 'eve_003'], category: 'adversarial' },
  { id: 'adversarial_006', query: 'RLS_CANARY_ALICE_', user: 'bob', must_top5: [], must_absent: ['alice_coffee_001', 'alice_family_001', 'alice_work_001'], category: 'adversarial' },
  { id: 'adversarial_007', query: 'What cholesterol issues does anyone have?', user: 'alice', must_top5: [], must_absent: ['bob_health_001'], category: 'adversarial' },
  { id: 'adversarial_008', query: "alice's medication schedule", user: 'bob', must_top5: [], must_absent: ['alice_health_001', 'alice_health_002'], category: 'adversarial' },
  { id: 'adversarial_009', query: 'RLS_CANARY_CAROL_', user: 'eve', must_top5: [], must_absent: ['carol_unicode_001', 'carol_short_001', 'carol_xss_001'], category: 'adversarial' },
  { id: 'adversarial_010', query: "dave's standup notes", user: 'alice', must_top5: [], must_absent: ['dave_today_001', 'dave_today_002'], category: 'adversarial' },
  // Edge Cases
  { id: 'edge_001', query: 'cats', user: 'eve', must_top5: ['eve_003'], must_absent: [], category: 'edge_case' },
  { id: 'edge_002', query: 'everything about my life', user: 'eve', must_top5: [], must_absent: ['alice_family_001', 'bob_family_001', 'carol_short_001'], category: 'edge_case' },
  { id: 'edge_003', query: '<script>alert(1)</script>', user: 'carol', must_top5: [], must_absent: ['alice_coffee_001', 'bob_coffee_001'], category: 'edge_case' },
  { id: 'edge_004', query: "'; DROP TABLE memories; --", user: 'carol', must_top5: [], must_absent: ['alice_coffee_001'], category: 'edge_case' },
  { id: 'edge_005', query: '🎉 party', user: 'carol', must_top5: ['carol_unicode_001'], must_absent: [], category: 'edge_case' },
  { id: 'edge_006', query: '', user: 'alice', must_top5: [], must_absent: [], category: 'edge_case' },
  { id: 'edge_007', query: 'Tell me about the very long detailed comprehensive thorough extensive exhaustive in-depth complete full total absolute entire whole broad wide ranging far reaching all encompassing all inclusive universal general overall comprehensive summary overview analysis review assessment evaluation examination inspection investigation study research exploration inquiry probe search scan survey inspection audit check test verification validation confirmation corroboration substantiation authentication certification accreditation endorsement approval authorization sanction ratification adoption acceptance recognition acknowledgment appreciation understanding comprehension grasp knowledge awareness familiarity acquaintance conversance intimacy expertise proficiency mastery command fluency facility skillfulness adeptness dexterity finesse talent ability capability capacity competence aptitude potential promise', user: 'alice', must_top5: [], must_absent: ['bob_coffee_001'], category: 'edge_case' },
  { id: 'edge_008', query: 'こんにちは、思い出を検索します', user: 'carol', must_top5: [], must_absent: ['alice_coffee_001', 'bob_coffee_001'], category: 'edge_case' },
  { id: 'edge_009', query: "'; SELECT * FROM users WHERE 1=1; --", user: 'carol', must_top5: [], must_absent: ['alice_coffee_001', 'bob_coffee_001'], category: 'edge_case' },
  { id: 'edge_010', query: 'quantum entanglement dark matter multiverse theory', user: 'alice', must_top5: [], must_absent: ['bob_coffee_001', 'carol_short_001'], category: 'edge_case' },
  { id: 'edge_011', query: 'the a an is', user: 'alice', must_top5: [], must_absent: [], category: 'edge_case' },
  { id: 'edge_012', query: 'coffee', user: 'alice', must_top5: ['alice_coffee_001'], must_absent: ['bob_coffee_001'], category: 'edge_case' },
  { id: 'edge_013', query: 'my phone number', user: 'alice', must_top5: ['alice_phone_001'], must_absent: [], category: 'edge_case' },
  { id: 'edge_014', query: 'my address', user: 'alice', must_top5: ['alice_address_001'], must_absent: [], category: 'edge_case' },
  { id: 'edge_015', query: 'work', user: 'eve', must_top5: ['eve_004'], must_absent: ['alice_work_001', 'bob_work_001'], category: 'edge_case' },
  // Cross-feature
  { id: 'cross_001', query: 'medication I need to take every morning', user: 'alice', must_top5: ['alice_health_001'], must_absent: ['bob_health_001'], category: 'cross_feature' },
  { id: 'cross_002', query: 'exercise and fitness activities', user: 'alice', must_top5: ['alice_health_002'], must_absent: ['bob_routine_001'], category: 'cross_feature' },
  { id: 'cross_003', query: 'What are we saving money for?', user: 'alice', must_top5: ['alice_finance_001'], must_absent: [], category: 'cross_feature' },
  { id: 'cross_004', query: 'kids school and daycare', user: 'alice', must_top5: ['alice_family_003'], must_absent: ['bob_family_001'], category: 'cross_feature' },
  { id: 'cross_005', query: 'kids school and daycare', user: 'bob', must_top5: ['bob_family_001'], must_absent: ['alice_family_003'], category: 'cross_feature' },
  { id: 'cross_006', query: 'Who am I and what do I do?', user: 'alice', must_top5: ['alice_identity_project_001'], must_absent: ['bob_work_001'], category: 'cross_feature' },
  { id: 'cross_007', query: 'deployment rules and constraints', user: 'alice', must_top5: ['alice_high_importance_001'], must_absent: [], category: 'cross_feature' },
  { id: 'cross_008', query: 'patterns noticed about my work habits', user: 'alice', must_top5: ['alice_insight_001'], must_absent: [], category: 'cross_feature' },
  { id: 'cross_009', query: 'grocery shopping list', user: 'eve', must_top5: ['eve_005'], must_absent: [], category: 'cross_feature' },
  { id: 'cross_010', query: 'TypeScript learning', user: 'eve', must_top5: ['eve_007'], must_absent: ['alice_work_001'], category: 'cross_feature' },
  // Duplicate consistency
  { id: 'edge_016', query: 'What kind of coffee do I like?', user: 'alice', must_top5: ['alice_coffee_001', 'alice_coffee_002'], must_absent: ['bob_coffee_001', 'bob_coffee_002'], category: 'edge_case' },
  // Negative / no-match
  { id: 'negative_001', query: 'quantum physics black holes dark matter', user: 'alice', must_top5: [], must_absent: ['bob_coffee_001', 'carol_short_001', 'eve_001'], category: 'semantic' },
  { id: 'negative_002', query: 'ancient Egyptian hieroglyphics translation', user: 'bob', must_top5: [], must_absent: ['alice_coffee_001', 'carol_short_001'], category: 'semantic' },
  // Minimal user
  { id: 'minimal_001', query: 'pizza preference', user: 'eve', must_top5: ['eve_009'], must_absent: [], category: 'semantic' },
];

// ── Scoring ─────────────────────────────────────────────────────

interface QueryScore {
  queryId: string;
  category: string;
  passed: boolean;
  mustTop5Hit: boolean;
  shouldTop20Hit: boolean;
  mustAbsentClean: boolean;
  latencyMs: number;
  returnedCount: number;
  details: string;
}

interface SweepResult {
  minScore: number;
  limit: number;
  passRate: number;
  mustTop5Rate: number;
  shouldTop20Rate: number;
  mustAbsentRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalQueries: number;
  passedQueries: number;
  failedQueryIds: string[];
  scores: QueryScore[];
}

/**
 * Score a single query result against gold expectations.
 *
 * Memories are matched by checking if any memory's `raw` text or `id`
 * contains the fixture_id. This handles the case where fixture_ids are
 * embedded in the memory content during seeding.
 */
function scoreQuery(
  gold: GoldQuery,
  memories: MemoryResult[],
  latencyMs: number,
): QueryScore {
  const top5 = memories.slice(0, 5);
  const top20 = memories.slice(0, 20);

  const memoryIds = (mems: MemoryResult[]) =>
    mems.map((m) => {
      // Check memory id, raw content, and any metadata for fixture_id
      const texts = [m.id, m.raw, JSON.stringify(m)].join(' ');
      return texts;
    });

  const hasFixture = (mems: MemoryResult[], fixtureId: string): boolean => {
    return mems.some((m) => {
      const searchable = [m.id, m.raw, JSON.stringify(m)].join(' ');
      return searchable.includes(fixtureId);
    });
  };

  // must_top5: all must be present in top 5
  const mustTop5Results = gold.must_top5.map((fid) => ({
    fid,
    found: hasFixture(top5, fid),
  }));
  const mustTop5Hit =
    gold.must_top5.length === 0 || mustTop5Results.every((r) => r.found);

  // should_top20: all should be present in top 20
  const shouldTop20 = gold.should_top20 || [];
  const shouldTop20Results = shouldTop20.map((fid) => ({
    fid,
    found: hasFixture(top20, fid),
  }));
  const shouldTop20Hit =
    shouldTop20.length === 0 || shouldTop20Results.every((r) => r.found);

  // must_absent: none should be present in any results
  const mustAbsentResults = gold.must_absent.map((fid) => ({
    fid,
    found: hasFixture(top20, fid),
  }));
  const mustAbsentClean = mustAbsentResults.every((r) => !r.found);

  // A query passes if must_top5 and must_absent both pass
  const passed = mustTop5Hit && mustAbsentClean;

  // Build details string for debugging
  const details: string[] = [];
  if (!mustTop5Hit) {
    const missing = mustTop5Results
      .filter((r) => !r.found)
      .map((r) => r.fid);
    details.push(`missing_top5=[${missing.join(',')}]`);
  }
  if (!shouldTop20Hit) {
    const missing = shouldTop20Results
      .filter((r) => !r.found)
      .map((r) => r.fid);
    details.push(`missing_top20=[${missing.join(',')}]`);
  }
  if (!mustAbsentClean) {
    const leaked = mustAbsentResults
      .filter((r) => r.found)
      .map((r) => r.fid);
    details.push(`RLS_LEAK=[${leaked.join(',')}]`);
  }

  return {
    queryId: gold.id,
    category: gold.category,
    passed,
    mustTop5Hit,
    shouldTop20Hit,
    mustAbsentClean,
    latencyMs,
    returnedCount: memories.length,
    details: details.join('; ') || 'OK',
  };
}

// ── API Client ──────────────────────────────────────────────────

async function queryMemories(
  query: string,
  user: string,
  limit: number,
): Promise<{ memories: MemoryResult[]; latencyMs: number }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-AM-User-ID': user,
  };
  if (API_KEY) {
    headers['X-AM-API-Key'] = API_KEY;
  }

  const startTime = Date.now();
  const res = await fetch(`${ENGRAM_URL}/v1/memories/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, limit }),
  });

  const clientLatency = Date.now() - startTime;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Query failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as QueryResponse;
  return {
    memories: data.memories || [],
    latencyMs: data.latencyMs ?? clientLatency,
  };
}

// ── Sweep Runner ────────────────────────────────────────────────

async function runSweep(
  minScore: number,
  limit: number,
): Promise<SweepResult> {
  const scores: QueryScore[] = [];
  const latencies: number[] = [];

  for (const gold of GOLD_QUERIES) {
    // Skip empty queries — API may reject them
    if (!gold.query.trim()) {
      scores.push({
        queryId: gold.id,
        category: gold.category,
        passed: true,
        mustTop5Hit: true,
        shouldTop20Hit: true,
        mustAbsentClean: true,
        latencyMs: 0,
        returnedCount: 0,
        details: 'SKIPPED (empty query)',
      });
      continue;
    }

    try {
      // Always fetch FETCH_LIMIT results, then apply client-side filtering
      const { memories, latencyMs } = await queryMemories(
        gold.query,
        gold.user,
        FETCH_LIMIT,
      );

      // Client-side minScore filter
      const filtered = memories.filter(
        (m) => (m.score ?? 1.0) >= minScore,
      );

      // Client-side limit
      const limited = filtered.slice(0, limit);

      const score = scoreQuery(gold, limited, latencyMs);
      scores.push(score);
      latencies.push(latencyMs);
    } catch (err) {
      scores.push({
        queryId: gold.id,
        category: gold.category,
        passed: false,
        mustTop5Hit: false,
        shouldTop20Hit: false,
        mustAbsentClean: true,
        latencyMs: 0,
        returnedCount: 0,
        details: `ERROR: ${(err as Error).message}`,
      });
    }

    // Rate limit protection
    if (QUERY_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
    }
  }

  // Compute aggregate metrics
  const passed = scores.filter((s) => s.passed);
  const withMustTop5 = scores.filter((s) => s.mustTop5Hit);
  const withShouldTop20 = scores.filter((s) => s.shouldTop20Hit);
  const withMustAbsent = scores.filter((s) => s.mustAbsentClean);

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const avg =
    latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

  return {
    minScore,
    limit,
    passRate: scores.length > 0 ? passed.length / scores.length : 0,
    mustTop5Rate:
      scores.length > 0 ? withMustTop5.length / scores.length : 0,
    shouldTop20Rate:
      scores.length > 0 ? withShouldTop20.length / scores.length : 0,
    mustAbsentRate:
      scores.length > 0 ? withMustAbsent.length / scores.length : 0,
    avgLatencyMs: Math.round(avg),
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    totalQueries: scores.length,
    passedQueries: passed.length,
    failedQueryIds: scores.filter((s) => !s.passed).map((s) => s.queryId),
    scores,
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(70));
  console.log('Autoresearch Recall Optimizer — Phase 1: Client-side sweep');
  console.log('='.repeat(70));
  console.log(`Target:     ${ENGRAM_URL}`);
  console.log(`Auth:       ${API_KEY ? 'API Key' : 'LAN Bypass'}`);
  console.log(`Queries:    ${GOLD_QUERIES.length}`);
  console.log(`Fetch limit: ${FETCH_LIMIT}`);
  console.log(
    `Sweep:      minScore=[${MIN_SCORE_VALUES.join(',')}] × limit=[${LIMIT_VALUES.join(',')}]`,
  );
  console.log(
    `Total runs: ${MIN_SCORE_VALUES.length * LIMIT_VALUES.length}`,
  );
  console.log('='.repeat(70));

  // Health check
  try {
    const res = await fetch(`${ENGRAM_URL}/health`);
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    console.log('\nHealth check: OK');
  } catch (err) {
    console.error(
      `\nERROR: Cannot reach Engram at ${ENGRAM_URL}`,
    );
    console.error(
      'Make sure Engram is running: npm run start:dev',
    );
    process.exit(1);
  }

  // Run one warm-up query to prime caches
  console.log('Warming up with a test query...');
  try {
    await queryMemories('test', 'alice', 5);
    console.log('Warm-up complete.\n');
  } catch (err) {
    console.error(
      `Warm-up query failed: ${(err as Error).message}`,
    );
    console.error(
      'Check: is TRUST_LOCAL_NETWORK=true set? Or provide AM_API_KEY.',
    );
    process.exit(1);
  }

  const allResults: SweepResult[] = [];
  let bestResult: SweepResult | null = null;
  let runIndex = 0;
  const totalRuns = MIN_SCORE_VALUES.length * LIMIT_VALUES.length;

  // Cache raw API results to avoid re-fetching for different minScore/limit combos
  // Since we always fetch FETCH_LIMIT=20, we can reuse results across sweep params
  console.log(
    'Phase 1a: Fetching raw results for all queries (limit=20)...\n',
  );

  interface CachedResult {
    memories: MemoryResult[];
    latencyMs: number;
  }
  const cache = new Map<string, CachedResult | { error: string }>();

  for (const gold of GOLD_QUERIES) {
    if (!gold.query.trim()) {
      cache.set(gold.id, { memories: [], latencyMs: 0 });
      continue;
    }
    try {
      const result = await queryMemories(
        gold.query,
        gold.user,
        FETCH_LIMIT,
      );
      cache.set(gold.id, result);
      process.stdout.write('.');
    } catch (err) {
      cache.set(gold.id, { error: (err as Error).message });
      process.stdout.write('X');
    }
    if (QUERY_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
    }
  }
  console.log(`\nFetched ${cache.size} query results.\n`);

  // Phase 1b: Score each combo using cached results
  console.log('Phase 1b: Scoring parameter combinations...\n');

  for (const minScore of MIN_SCORE_VALUES) {
    for (const limit of LIMIT_VALUES) {
      runIndex++;
      const scores: QueryScore[] = [];
      const latencies: number[] = [];

      for (const gold of GOLD_QUERIES) {
        const cached = cache.get(gold.id);
        if (!cached) continue;

        if ('error' in cached) {
          scores.push({
            queryId: gold.id,
            category: gold.category,
            passed: false,
            mustTop5Hit: false,
            shouldTop20Hit: false,
            mustAbsentClean: true,
            latencyMs: 0,
            returnedCount: 0,
            details: `ERROR: ${cached.error}`,
          });
          continue;
        }

        if (!gold.query.trim()) {
          scores.push({
            queryId: gold.id,
            category: gold.category,
            passed: true,
            mustTop5Hit: true,
            shouldTop20Hit: true,
            mustAbsentClean: true,
            latencyMs: 0,
            returnedCount: 0,
            details: 'SKIPPED (empty query)',
          });
          continue;
        }

        // Client-side filtering
        const filtered = cached.memories.filter(
          (m) => (m.score ?? 1.0) >= minScore,
        );
        const limited = filtered.slice(0, limit);

        const score = scoreQuery(gold, limited, cached.latencyMs);
        scores.push(score);
        latencies.push(cached.latencyMs);
      }

      // Aggregate
      const passed = scores.filter((s) => s.passed);
      const withMustTop5 = scores.filter((s) => s.mustTop5Hit);
      const withShouldTop20 = scores.filter((s) => s.shouldTop20Hit);
      const withMustAbsent = scores.filter((s) => s.mustAbsentClean);

      const sorted = [...latencies].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
      const avg =
        latencies.length > 0
          ? latencies.reduce((a, b) => a + b, 0) / latencies.length
          : 0;

      const result: SweepResult = {
        minScore,
        limit,
        passRate: scores.length > 0 ? passed.length / scores.length : 0,
        mustTop5Rate:
          scores.length > 0 ? withMustTop5.length / scores.length : 0,
        shouldTop20Rate:
          scores.length > 0 ? withShouldTop20.length / scores.length : 0,
        mustAbsentRate:
          scores.length > 0 ? withMustAbsent.length / scores.length : 0,
        avgLatencyMs: Math.round(avg),
        p50LatencyMs: p50,
        p95LatencyMs: p95,
        totalQueries: scores.length,
        passedQueries: passed.length,
        failedQueryIds: scores
          .filter((s) => !s.passed)
          .map((s) => s.queryId),
        scores,
      };

      allResults.push(result);

      if (!bestResult || result.passRate > bestResult.passRate) {
        bestResult = result;
      }

      const pct = (result.passRate * 100).toFixed(1);
      const best = result === bestResult ? ' *** BEST ***' : '';
      console.log(
        `  [${runIndex}/${totalRuns}] minScore=${minScore.toFixed(2)} limit=${limit.toString().padStart(2)} → pass=${pct}% (${result.passedQueries}/${result.totalQueries}) top5=${(result.mustTop5Rate * 100).toFixed(1)}% absent=${(result.mustAbsentRate * 100).toFixed(1)}% p50=${result.p50LatencyMs}ms${best}`,
      );
    }
  }

  // ── Output Results ──────────────────────────────────────────

  console.log('\n' + '='.repeat(70));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(70));

  if (bestResult) {
    console.log(
      `\nWINNING COMBINATION: minScore=${bestResult.minScore} limit=${bestResult.limit}`,
    );
    console.log(
      `  Pass rate:      ${(bestResult.passRate * 100).toFixed(1)}% (${bestResult.passedQueries}/${bestResult.totalQueries})`,
    );
    console.log(
      `  Must top5 rate: ${(bestResult.mustTop5Rate * 100).toFixed(1)}%`,
    );
    console.log(
      `  Should top20:   ${(bestResult.shouldTop20Rate * 100).toFixed(1)}%`,
    );
    console.log(
      `  Must absent:    ${(bestResult.mustAbsentRate * 100).toFixed(1)}%`,
    );
    console.log(
      `  Latency:        avg=${bestResult.avgLatencyMs}ms p50=${bestResult.p50LatencyMs}ms p95=${bestResult.p95LatencyMs}ms`,
    );
  }

  // Full mutation log
  console.log('\n── Mutation Log ──────────────────────────────────');
  console.log(
    'minScore  limit  passRate  top5Rate  top20Rate  absentRate  avgMs  p50Ms',
  );
  for (const r of allResults) {
    console.log(
      `${r.minScore.toFixed(2).padStart(8)}  ${r.limit.toString().padStart(5)}  ${(r.passRate * 100).toFixed(1).padStart(8)}%  ${(r.mustTop5Rate * 100).toFixed(1).padStart(8)}%  ${(r.shouldTop20Rate * 100).toFixed(1).padStart(9)}%  ${(r.mustAbsentRate * 100).toFixed(1).padStart(10)}%  ${r.avgLatencyMs.toString().padStart(5)}  ${r.p50LatencyMs.toString().padStart(5)}`,
    );
  }

  // Queries that still fail with best params
  if (bestResult && bestResult.failedQueryIds.length > 0) {
    console.log('\n── Failing Queries (need code fixes, not tuning) ──');
    const failedScores = bestResult.scores.filter((s) => !s.passed);

    // Group by category
    const byCategory = new Map<string, QueryScore[]>();
    for (const s of failedScores) {
      const arr = byCategory.get(s.category) || [];
      arr.push(s);
      byCategory.set(s.category, arr);
    }

    for (const [cat, items] of byCategory) {
      console.log(`\n  ${cat} (${items.length} failures):`);
      for (const s of items) {
        const gold = GOLD_QUERIES.find((g) => g.id === s.queryId);
        console.log(
          `    ${s.queryId}: "${gold?.query?.slice(0, 60)}" → ${s.details}`,
        );
      }
    }
  } else if (bestResult) {
    console.log('\n  All queries PASS with best parameters!');
  }

  // Save results
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/T/, '-')
    .replace(/:/g, '-')
    .slice(0, 16);
  const outputPath = path.join(
    __dirname,
    'autoresearch-results',
    `${timestamp}.json`,
  );

  const output = {
    timestamp: now.toISOString(),
    config: {
      engramUrl: ENGRAM_URL,
      fetchLimit: FETCH_LIMIT,
      minScoreValues: MIN_SCORE_VALUES,
      limitValues: LIMIT_VALUES,
      queryCount: GOLD_QUERIES.length,
      queryDelayMs: QUERY_DELAY_MS,
    },
    best: bestResult
      ? {
          minScore: bestResult.minScore,
          limit: bestResult.limit,
          passRate: bestResult.passRate,
          mustTop5Rate: bestResult.mustTop5Rate,
          shouldTop20Rate: bestResult.shouldTop20Rate,
          mustAbsentRate: bestResult.mustAbsentRate,
          avgLatencyMs: bestResult.avgLatencyMs,
          p50LatencyMs: bestResult.p50LatencyMs,
          p95LatencyMs: bestResult.p95LatencyMs,
          passedQueries: bestResult.passedQueries,
          totalQueries: bestResult.totalQueries,
          failedQueryIds: bestResult.failedQueryIds,
        }
      : null,
    mutationLog: allResults.map((r) => ({
      minScore: r.minScore,
      limit: r.limit,
      passRate: r.passRate,
      mustTop5Rate: r.mustTop5Rate,
      shouldTop20Rate: r.shouldTop20Rate,
      mustAbsentRate: r.mustAbsentRate,
      avgLatencyMs: r.avgLatencyMs,
      p50LatencyMs: r.p50LatencyMs,
      p95LatencyMs: r.p95LatencyMs,
      passedQueries: r.passedQueries,
      totalQueries: r.totalQueries,
      failedQueryIds: r.failedQueryIds,
    })),
    failingQueries: bestResult
      ? bestResult.scores
          .filter((s) => !s.passed)
          .map((s) => ({
            queryId: s.queryId,
            category: s.category,
            details: s.details,
            query: GOLD_QUERIES.find((g) => g.id === s.queryId)?.query,
          }))
      : [],
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);
  console.log('='.repeat(70));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
