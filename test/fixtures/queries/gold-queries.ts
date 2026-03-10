/**
 * Gold Benchmark Queries — 50+ queries with expected results.
 *
 * Each query defines which fixture memories MUST/SHOULD/MUST NOT appear.
 * Used for recall accuracy regression testing.
 */

import type { GoldQuery } from '../types';

export const GOLD_QUERIES: GoldQuery[] = [
  // ── Semantic Basic ────────────────────────────────────────────

  {
    id: 'semantic_001',
    query: 'What kind of coffee do I like?',
    user: 'alice',
    must_top5: ['alice_coffee_001', 'alice_coffee_002'],
    should_top20: ['alice_coffee_004_correction'],
    must_absent: ['bob_coffee_001', 'bob_coffee_002'],
    category: 'semantic',
  },
  {
    id: 'semantic_002',
    query: 'Tell me about my morning routine',
    user: 'alice',
    must_top5: ['alice_coffee_002'],
    must_absent: ['bob_routine_001', 'bob_coffee_001'],
    category: 'semantic',
  },
  {
    id: 'semantic_003',
    query: 'What tech stack am I using?',
    user: 'alice',
    must_top5: ['alice_work_001'],
    must_absent: ['bob_work_001'],
    category: 'semantic',
  },
  {
    id: 'semantic_004',
    query: 'coffee preferences',
    user: 'bob',
    must_top5: ['bob_coffee_001', 'bob_coffee_002'],
    must_absent: ['alice_coffee_001', 'alice_coffee_002'],
    category: 'semantic',
  },
  {
    id: 'semantic_005',
    query: 'What books have I been reading?',
    user: 'alice',
    must_top5: ['alice_books_001'],
    must_absent: ['bob_books_001'],
    category: 'semantic',
  },
  {
    id: 'semantic_006',
    query: 'favorite dinner recipe',
    user: 'alice',
    must_top5: ['alice_cooking_001'],
    must_absent: [],
    category: 'semantic',
  },
  {
    id: 'semantic_007',
    query: 'house savings goal',
    user: 'alice',
    must_top5: ['alice_finance_001'],
    must_absent: [],
    category: 'semantic',
  },
  {
    id: 'semantic_008',
    query: 'What framework am I using for the frontend?',
    user: 'bob',
    must_top5: ['bob_work_001'],
    must_absent: ['alice_work_001'],
    category: 'semantic',
  },
  {
    id: 'semantic_009',
    query: 'flight seat preference',
    user: 'alice',
    must_top5: ['alice_travel_002'],
    must_absent: [],
    category: 'semantic',
  },
  {
    id: 'semantic_010',
    query: 'ensemble search architecture decision',
    user: 'alice',
    must_top5: ['alice_work_003'],
    must_absent: [],
    category: 'semantic',
  },

  // ── Correction / Supersession ─────────────────────────────────

  {
    id: 'semantic_011',
    query: 'What coffee roast do I prefer?',
    user: 'alice',
    must_top5: ['alice_coffee_004_correction'],
    should_top20: ['alice_coffee_003_old'],
    must_absent: ['bob_coffee_001'],
    category: 'semantic',
  },

  // ── Emotional Retrieval ───────────────────────────────────────

  {
    id: 'emotional_001',
    query: 'What makes me happy?',
    user: 'alice',
    must_top5: ['alice_joy_001'],
    must_absent: ['alice_grief_001', 'alice_stress_001'],
    category: 'emotional',
  },
  {
    id: 'emotional_002',
    query: 'times I felt sad or grieving',
    user: 'alice',
    must_top5: ['alice_grief_001'],
    must_absent: ['alice_joy_001'],
    category: 'emotional',
  },
  {
    id: 'emotional_003',
    query: 'when I felt stressed or overwhelmed',
    user: 'alice',
    must_top5: ['alice_stress_001', 'alice_work_002'],
    must_absent: ['alice_joy_001'],
    category: 'emotional',
  },

  // ── Temporal ──────────────────────────────────────────────────

  {
    id: 'temporal_001',
    query: 'What happened today in standup?',
    user: 'dave',
    must_top5: ['dave_today_001', 'dave_today_002'],
    must_absent: ['dave_2years_001', 'dave_2years_002'],
    category: 'temporal',
  },
  {
    id: 'temporal_002',
    query: 'recent standup notes from this week',
    user: 'dave',
    must_top5: ['dave_today_001'],
    must_absent: ['dave_6months_001', 'dave_2years_001'],
    category: 'temporal',
  },
  {
    id: 'temporal_003',
    query: 'What happened with my daughter recently?',
    user: 'alice',
    must_top5: ['alice_family_001'],
    should_top20: ['alice_family_003'],
    must_absent: ['bob_family_001'],
    category: 'temporal',
  },

  // ── RLS Isolation ─────────────────────────────────────────────
  // These specifically test that cross-tenant data never appears

  {
    id: 'rls_001',
    query: 'coffee',
    user: 'alice',
    must_top5: ['alice_coffee_001'],
    must_absent: ['bob_coffee_001', 'bob_coffee_002', 'eve_009'],
    category: 'rls_isolation',
  },
  {
    id: 'rls_002',
    query: 'coffee',
    user: 'bob',
    must_top5: ['bob_coffee_001'],
    must_absent: ['alice_coffee_001', 'alice_coffee_002'],
    category: 'rls_isolation',
  },
  {
    id: 'rls_003',
    query: 'family and kids',
    user: 'alice',
    must_top5: ['alice_family_001'],
    must_absent: ['bob_family_001', 'bob_family_002'],
    category: 'rls_isolation',
  },
  {
    id: 'rls_004',
    query: 'family and kids',
    user: 'bob',
    must_top5: ['bob_family_001'],
    must_absent: ['alice_family_001', 'alice_family_002', 'alice_family_003'],
    category: 'rls_isolation',
  },
  {
    id: 'rls_005',
    query: 'travel food experiences',
    user: 'alice',
    must_top5: ['alice_travel_001'],
    must_absent: ['bob_travel_001'],
    category: 'rls_isolation',
  },
  {
    id: 'rls_006',
    query: 'travel food experiences',
    user: 'bob',
    must_top5: ['bob_travel_001'],
    must_absent: ['alice_travel_001'],
    category: 'rls_isolation',
  },
  {
    id: 'rls_007',
    query: 'work projects and code',
    user: 'alice',
    must_top5: ['alice_work_001'],
    must_absent: ['bob_work_001', 'bob_work_002'],
    category: 'rls_isolation',
  },
  {
    id: 'rls_008',
    query: 'health medical information',
    user: 'alice',
    must_top5: ['alice_health_001'],
    must_absent: ['bob_health_001'],
    category: 'rls_isolation',
  },
  {
    id: 'rls_009',
    query: 'health medical information',
    user: 'bob',
    must_top5: ['bob_health_001'],
    must_absent: ['alice_health_001', 'alice_health_002'],
    category: 'rls_isolation',
  },
  {
    id: 'rls_010',
    query: 'morning routine',
    user: 'bob',
    must_top5: ['bob_routine_001'],
    must_absent: ['alice_coffee_002'],
    category: 'rls_isolation',
  },

  // ── Edge Cases ────────────────────────────────────────────────

  {
    id: 'edge_001',
    query: 'cats',
    user: 'eve',
    must_top5: ['eve_003'],
    must_absent: [],
    category: 'edge_case',
  },
  {
    id: 'edge_002',
    query: 'everything about my life',
    user: 'eve',
    must_top5: [],
    must_absent: ['alice_family_001', 'bob_family_001', 'carol_short_001'],
    category: 'edge_case',
  },
  {
    id: 'edge_003',
    query: '<script>alert(1)</script>',
    user: 'carol',
    must_top5: [],
    must_absent: ['alice_coffee_001', 'bob_coffee_001'],
    category: 'edge_case',
  },
  {
    id: 'edge_004',
    query: "'; DROP TABLE memories; --",
    user: 'carol',
    must_top5: [],
    must_absent: ['alice_coffee_001'],
    category: 'edge_case',
  },
  {
    id: 'edge_005',
    query: '🎉 party',
    user: 'carol',
    must_top5: ['carol_unicode_001'],
    must_absent: [],
    category: 'edge_case',
  },

  // ── Cross-category queries ────────────────────────────────────

  {
    id: 'cross_001',
    query: 'medication I need to take every morning',
    user: 'alice',
    must_top5: ['alice_health_001'],
    must_absent: ['bob_health_001'],
    category: 'semantic',
  },
  {
    id: 'cross_002',
    query: 'exercise and fitness activities',
    user: 'alice',
    must_top5: ['alice_health_002'],
    must_absent: ['bob_routine_001'],
    category: 'semantic',
  },
  {
    id: 'cross_003',
    query: 'What are we saving money for?',
    user: 'alice',
    must_top5: ['alice_finance_001'],
    must_absent: [],
    category: 'semantic',
  },
  {
    id: 'cross_004',
    query: 'kids school and daycare',
    user: 'alice',
    must_top5: ['alice_family_003'],
    must_absent: ['bob_family_001'],
    category: 'semantic',
  },
  {
    id: 'cross_005',
    query: 'kids school and daycare',
    user: 'bob',
    must_top5: ['bob_family_001'],
    must_absent: ['alice_family_003'],
    category: 'semantic',
  },

  // ── Minimal user queries ──────────────────────────────────────

  {
    id: 'minimal_001',
    query: 'grocery shopping list',
    user: 'eve',
    must_top5: ['eve_005'],
    must_absent: [],
    category: 'semantic',
  },
  {
    id: 'minimal_002',
    query: 'TypeScript learning',
    user: 'eve',
    must_top5: ['eve_007'],
    must_absent: ['alice_work_001'],
    category: 'semantic',
  },
  {
    id: 'minimal_003',
    query: 'pizza preference',
    user: 'eve',
    must_top5: ['eve_009'],
    must_absent: [],
    category: 'semantic',
  },

  // ── Negative queries (should return nothing relevant) ─────────

  {
    id: 'negative_001',
    query: 'quantum physics black holes dark matter',
    user: 'alice',
    must_top5: [],
    must_absent: ['bob_coffee_001', 'carol_short_001', 'eve_001'],
    category: 'semantic',
  },
  {
    id: 'negative_002',
    query: 'ancient Egyptian hieroglyphics translation',
    user: 'bob',
    must_top5: [],
    must_absent: ['alice_coffee_001', 'carol_short_001'],
    category: 'semantic',
  },
];

/** Total query count for reporting */
export const QUERY_COUNT = GOLD_QUERIES.length;

/** Queries by category for targeted runs */
export const QUERIES_BY_CATEGORY = GOLD_QUERIES.reduce(
  (acc, q) => {
    if (!acc[q.category]) acc[q.category] = [];
    acc[q.category].push(q);
    return acc;
  },
  {} as Record<string, GoldQuery[]>,
);
