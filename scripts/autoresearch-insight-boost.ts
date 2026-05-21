/**
 * Autoresearch Insight Recall Boost Optimizer — Phase 3
 *
 * Tests the boostFactor in contextual-recall.service.ts that boosts
 * INSIGHT memories in recall results when a delegationContext is present.
 *
 * Approach:
 * 1. Fetch existing INSIGHT memories from the DB
 * 2. Build gold queries from insight content that should surface those insights
 * 3. Sweep boostFactor and minInsightScore values
 * 4. Score: is the INSIGHT in top 5? How does ranking change with boost?
 *
 * Usage:
 *   npx ts-node scripts/autoresearch-insight-boost.ts
 *
 * Requires: Engram running locally on port 3001 with TRUST_LOCAL_NETWORK=true
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Configuration ───────────────────────────────────────────────

const ENGRAM_URL = process.env.ENGRAM_URL || 'http://localhost:3001';
const API_KEY = process.env.AM_API_KEY || '';
const QUERY_DELAY_MS = 50;

// Sweep parameters
const BOOST_FACTOR_VALUES = [1.0, 1.2, 1.5, 1.8, 2.0, 2.5];
const MIN_INSIGHT_SCORE_VALUES = [0.2, 0.3, 0.4];

// ── Types ───────────────────────────────────────────────────────

interface InsightRecord {
  id: string;
  title: string | null;
  content: string;
  category: string | null;
  confidence: number | null;
  createdAt: string;
}

interface MemoryResult {
  id: string;
  raw: string;
  score?: number;
  layer?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface GoldInsightQuery {
  id: string;
  query: string;
  expectedInsightId: string;
  insightPreview: string;
  user: string;
  category: string;
}

interface QueryScore {
  queryId: string;
  boostFactor: number;
  insightInTop5: boolean;
  insightInTop10: boolean;
  insightRank: number | null; // null = not found
  insightScore: number | null;
  totalResults: number;
  topResultLayer: string | null;
  latencyMs: number;
}

interface BoostSweepResult {
  boostFactor: number;
  insightTop5Rate: number;
  insightTop10Rate: number;
  avgInsightRank: number;
  avgInsightScore: number;
  queriesWithInsight: number;
  totalQueries: number;
}

// ── Gold Query Generation ───────────────────────────────────────

/**
 * Static gold queries that test insight surfacing.
 * These queries should naturally pull up INSIGHT-type memories.
 */
const STATIC_GOLD_QUERIES: Omit<GoldInsightQuery, 'expectedInsightId' | 'insightPreview'>[] = [
  { id: 'insight_gold_01', query: 'What patterns have you noticed about my work habits?', user: 'alice', category: 'work_patterns' },
  { id: 'insight_gold_02', query: 'What insights do you have about my behavior?', user: 'alice', category: 'behavioral' },
  { id: 'insight_gold_03', query: 'What trends have you observed?', user: 'alice', category: 'trends' },
  { id: 'insight_gold_04', query: 'What have you learned about how I work?', user: 'alice', category: 'work_patterns' },
  { id: 'insight_gold_05', query: 'Any observations about my habits?', user: 'alice', category: 'habits' },
  { id: 'insight_gold_06', query: 'What recurring patterns do you see?', user: 'alice', category: 'patterns' },
  { id: 'insight_gold_07', query: 'Tell me something you noticed about my routine', user: 'alice', category: 'routine' },
  { id: 'insight_gold_08', query: 'What behavioral trends stand out?', user: 'alice', category: 'behavioral' },
  { id: 'insight_gold_09', query: 'Summarize what you know about my preferences', user: 'alice', category: 'preferences' },
  { id: 'insight_gold_10', query: 'What insights have emerged from our conversations?', user: 'alice', category: 'conversations' },
  { id: 'insight_gold_11', query: 'What patterns exist in how I approach problems?', user: 'alice', category: 'problem_solving' },
  { id: 'insight_gold_12', query: 'Have you noticed any changes in my behavior?', user: 'alice', category: 'behavioral_change' },
  { id: 'insight_gold_13', query: 'What do you know about my learning style?', user: 'alice', category: 'learning' },
  { id: 'insight_gold_14', query: 'Any observations about my communication patterns?', user: 'alice', category: 'communication' },
  { id: 'insight_gold_15', query: 'What have you inferred about my goals?', user: 'alice', category: 'goals' },
];

/**
 * Generate dynamic gold queries from actual insights in the database.
 * For each insight, create a natural-language query that should surface it.
 */
function generateDynamicQueries(
  insights: InsightRecord[],
): GoldInsightQuery[] {
  const queries: GoldInsightQuery[] = [];

  for (const insight of insights.slice(0, 15)) {
    // Extract key phrases from insight content for the query
    const content = insight.content || '';
    const words = content
      .replace(/\[.*?\]/g, '') // remove bracketed tags
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 8);

    if (words.length < 3) continue;

    // Build a natural query from the insight's key terms
    const queryText = `Tell me about ${words.slice(0, 5).join(' ')}`;

    queries.push({
      id: `insight_dynamic_${queries.length + 1}`,
      query: queryText,
      expectedInsightId: insight.id,
      insightPreview: content.slice(0, 100),
      user: 'alice',
      category: insight.category || 'dynamic',
    });
  }

  return queries;
}

// ── API Client ──────────────────────────────────────────────────

function makeHeaders(user: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-AM-User-ID': user,
  };
  if (API_KEY) {
    headers['X-AM-API-Key'] = API_KEY;
  }
  return headers;
}

async function fetchInsights(
  limit = 100,
  offset = 0,
): Promise<InsightRecord[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (API_KEY) {
    headers['X-AM-API-Key'] = API_KEY;
  }
  const res = await fetch(
    `${ENGRAM_URL}/v1/awareness/insights?limit=${limit}&offset=${offset}`,
    { headers },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GET /v1/awareness/insights failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as InsightRecord[];
}

async function queryMemories(
  query: string,
  user: string,
  limit: number,
  layers?: string[],
): Promise<{ memories: MemoryResult[]; latencyMs: number }> {
  const startTime = Date.now();
  const body: Record<string, unknown> = { query, limit };
  if (layers) {
    body.layers = layers;
  }

  const res = await fetch(`${ENGRAM_URL}/v1/memories/query`, {
    method: 'POST',
    headers: makeHeaders(user),
    body: JSON.stringify(body),
  });

  const clientLatency = Date.now() - startTime;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Query failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    memories: (data as any).memories || [],
    latencyMs: (data as any).latencyMs ?? clientLatency,
  };
}

async function queryMemoriesWithInsightLayer(
  query: string,
  user: string,
  limit: number,
): Promise<{ memories: MemoryResult[]; latencyMs: number }> {
  // Query with INSIGHT layer filter to see what insight memories exist
  return queryMemories(query, user, limit, ['INSIGHT']);
}

// ── Scoring ─────────────────────────────────────────────────────

function scoreQueryResult(
  queryId: string,
  boostFactor: number,
  memories: MemoryResult[],
  expectedInsightId: string | null,
  latencyMs: number,
): QueryScore {
  // Find the insight in results
  let insightRank: number | null = null;
  let insightScore: number | null = null;

  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    // Match by ID or by checking if it's an INSIGHT layer memory
    const isMatch =
      (expectedInsightId && mem.id === expectedInsightId) ||
      (mem as any).layer === 'INSIGHT';

    if (isMatch && insightRank === null) {
      insightRank = i + 1; // 1-indexed
      insightScore = mem.score ?? null;
    }
  }

  return {
    queryId,
    boostFactor,
    insightInTop5: insightRank !== null && insightRank <= 5,
    insightInTop10: insightRank !== null && insightRank <= 10,
    insightRank,
    insightScore,
    totalResults: memories.length,
    topResultLayer: memories.length > 0 ? ((memories[0] as any).layer ?? null) : null,
    latencyMs,
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(70));
  console.log(
    'Autoresearch Insight Recall Boost Optimizer — Phase 3',
  );
  console.log('='.repeat(70));
  console.log(`Target:     ${ENGRAM_URL}`);
  console.log(`Auth:       ${API_KEY ? 'API Key' : 'LAN Bypass'}`);
  console.log(
    `Sweep:      boostFactor=[${BOOST_FACTOR_VALUES.join(',')}]`,
  );
  console.log(
    `            minInsightScore=[${MIN_INSIGHT_SCORE_VALUES.join(',')}]`,
  );
  console.log('='.repeat(70));

  // Health check
  try {
    const res = await fetch(`${ENGRAM_URL}/health`);
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    console.log('\nHealth check: OK');
  } catch {
    console.error(`\nERROR: Cannot reach Engram at ${ENGRAM_URL}`);
    console.error('Make sure Engram is running: npm run start:dev');
    process.exit(1);
  }

  // ── Step 1: Fetch existing insights ───────────────────────────
  console.log('\nStep 1: Fetching existing INSIGHT memories...');
  let insights: InsightRecord[];
  try {
    insights = await fetchInsights(100, 0);
    console.log(`  Found ${insights.length} insights.`);
  } catch (err) {
    console.error(`  Failed: ${(err as Error).message}`);
    insights = [];
  }

  if (insights.length > 0) {
    console.log('  Sample insights:');
    for (const ins of insights.slice(0, 5)) {
      console.log(
        `    [${ins.id.slice(0, 8)}] conf=${(ins.confidence ?? 0).toFixed(2)} cat=${ins.category || 'null'} "${(ins.content || '').slice(0, 60)}..."`,
      );
    }
  }

  // ── Step 2: Build gold query set ──────────────────────────────
  console.log('\nStep 2: Building gold query set...');

  // Dynamic queries from actual insights
  const dynamicQueries = generateDynamicQueries(insights);
  console.log(
    `  Generated ${dynamicQueries.length} dynamic queries from existing insights`,
  );
  console.log(
    `  ${STATIC_GOLD_QUERIES.length} static queries for general insight surfacing`,
  );

  // ── Step 3: Cache baseline results ────────────────────────────
  console.log('\nStep 3: Caching baseline recall results...');

  // Warm-up
  try {
    await queryMemories('test', 'alice', 5);
    console.log('  Warm-up: OK');
  } catch (err) {
    console.error(
      `  Warm-up failed: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  // Cache results for static queries (without INSIGHT layer filter)
  interface CachedResult {
    memories: MemoryResult[];
    latencyMs: number;
  }
  const baselineCache = new Map<
    string,
    CachedResult | { error: string }
  >();

  // Also cache insight-only results to check what insights come back
  const insightCache = new Map<
    string,
    CachedResult | { error: string }
  >();

  const allQueryIds = [
    ...STATIC_GOLD_QUERIES.map((q) => q.id),
    ...dynamicQueries.map((q) => q.id),
  ];
  const allQueries = [
    ...STATIC_GOLD_QUERIES.map((q) => ({
      id: q.id,
      query: q.query,
      user: q.user,
    })),
    ...dynamicQueries.map((q) => ({
      id: q.id,
      query: q.query,
      user: q.user,
    })),
  ];

  for (const q of allQueries) {
    try {
      const result = await queryMemories(q.query, q.user, 20);
      baselineCache.set(q.id, result);
      process.stdout.write('.');
    } catch (err) {
      baselineCache.set(q.id, { error: (err as Error).message });
      process.stdout.write('X');
    }

    // Also fetch with INSIGHT layer filter
    try {
      const insightResult = await queryMemoriesWithInsightLayer(
        q.query,
        q.user,
        10,
      );
      insightCache.set(q.id, insightResult);
    } catch {
      insightCache.set(q.id, { error: 'insight query failed' });
    }

    if (QUERY_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
    }
  }
  console.log(`\n  Cached ${baselineCache.size} query results.`);

  // ── Step 4: Score each boost factor ───────────────────────────
  console.log('\nStep 4: Scoring boost factor combinations...');

  const allSweepResults: BoostSweepResult[] = [];
  const allQueryScores: QueryScore[] = [];

  // Since we can't dynamically change boostFactor server-side without
  // delegation context, we simulate the effect client-side:
  // - For each result set, identify INSIGHT-layer memories
  // - Apply the boost factor to their scores
  // - Re-sort and evaluate ranking changes

  for (const boost of BOOST_FACTOR_VALUES) {
    for (const minScore of MIN_INSIGHT_SCORE_VALUES) {
      const scores: QueryScore[] = [];

      for (const q of allQueries) {
        const cached = baselineCache.get(q.id);
        if (!cached || 'error' in cached) continue;

        // Simulate boost: multiply INSIGHT scores by boostFactor, cap at 1.0
        const boosted = cached.memories
          .map((m) => {
            const isInsight = (m as any).layer === 'INSIGHT';
            const baseScore = m.score ?? 0;
            if (isInsight && baseScore >= minScore) {
              return {
                ...m,
                score: Math.min(baseScore * boost, 1.0),
              };
            }
            return m;
          })
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

        // Find the expected insight for dynamic queries
        const dynQuery = dynamicQueries.find((dq) => dq.id === q.id);
        const expectedId = dynQuery?.expectedInsightId || null;

        const score = scoreQueryResult(
          q.id,
          boost,
          boosted,
          expectedId,
          cached.latencyMs,
        );
        scores.push(score);
        allQueryScores.push(score);
      }

      // Aggregate
      const withInsight = scores.filter(
        (s) => s.insightRank !== null,
      );
      const top5 = scores.filter((s) => s.insightInTop5);
      const top10 = scores.filter((s) => s.insightInTop10);
      const avgRank =
        withInsight.length > 0
          ? withInsight.reduce((s, q) => s + (q.insightRank || 0), 0) /
            withInsight.length
          : Infinity;
      const avgScore =
        withInsight.length > 0
          ? withInsight.reduce(
              (s, q) => s + (q.insightScore || 0),
              0,
            ) / withInsight.length
          : 0;

      const result: BoostSweepResult = {
        boostFactor: boost,
        insightTop5Rate:
          scores.length > 0 ? top5.length / scores.length : 0,
        insightTop10Rate:
          scores.length > 0 ? top10.length / scores.length : 0,
        avgInsightRank: Math.round(avgRank * 10) / 10,
        avgInsightScore: Math.round(avgScore * 1000) / 1000,
        queriesWithInsight: withInsight.length,
        totalQueries: scores.length,
      };

      allSweepResults.push(result);

      console.log(
        `  boost=${boost.toFixed(1)} minScore=${minScore.toFixed(1)} → top5=${(result.insightTop5Rate * 100).toFixed(1)}% top10=${(result.insightTop10Rate * 100).toFixed(1)}% avgRank=${result.avgInsightRank} withInsight=${result.queriesWithInsight}/${result.totalQueries}`,
      );
    }
  }

  // ── Step 5: Determine optimal boost ───────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(70));

  // Find best result: maximize top5 rate, break ties by avg rank
  const best = allSweepResults.reduce((a, b) => {
    if (b.insightTop5Rate > a.insightTop5Rate) return b;
    if (
      b.insightTop5Rate === a.insightTop5Rate &&
      b.avgInsightRank < a.avgInsightRank
    )
      return b;
    return a;
  });

  console.log(
    `\nOptimal boostFactor: ${best.boostFactor}`,
  );
  console.log(
    `  Insight top-5 rate:  ${(best.insightTop5Rate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Insight top-10 rate: ${(best.insightTop10Rate * 100).toFixed(1)}%`,
  );
  console.log(`  Avg insight rank:    ${best.avgInsightRank}`);
  console.log(
    `  Avg insight score:   ${best.avgInsightScore.toFixed(3)}`,
  );
  console.log(
    `  Queries w/ insight:  ${best.queriesWithInsight}/${best.totalQueries}`,
  );

  // ── Step 6: Identify reliably surfacing vs. weak insights ─────
  console.log('\n── Insight Surfacing Reliability ──');

  // Check which insights appear in baseline results
  const insightSurfaceMap = new Map<
    string,
    { surfacedCount: number; totalQueries: number; avgScore: number }
  >();

  for (const [qId, cached] of insightCache.entries()) {
    if ('error' in cached) continue;
    for (const mem of cached.memories) {
      const entry = insightSurfaceMap.get(mem.id) || {
        surfacedCount: 0,
        totalQueries: 0,
        avgScore: 0,
      };
      entry.surfacedCount++;
      entry.avgScore =
        (entry.avgScore * (entry.surfacedCount - 1) +
          (mem.score ?? 0)) /
        entry.surfacedCount;
      insightSurfaceMap.set(mem.id, entry);
    }
  }

  const reliableInsights: {
    id: string;
    surfacedCount: number;
    avgScore: number;
    preview: string;
  }[] = [];
  const weakInsights: {
    id: string;
    surfacedCount: number;
    avgScore: number;
    preview: string;
  }[] = [];

  for (const ins of insights) {
    const stats = insightSurfaceMap.get(ins.id);
    const entry = {
      id: ins.id,
      surfacedCount: stats?.surfacedCount ?? 0,
      avgScore: stats?.avgScore ?? 0,
      preview: (ins.content || '').slice(0, 80),
    };
    if (entry.surfacedCount >= 2 && entry.avgScore >= 0.3) {
      reliableInsights.push(entry);
    } else {
      weakInsights.push(entry);
    }
  }

  console.log(
    `  Reliable insights (surface well): ${reliableInsights.length}`,
  );
  for (const r of reliableInsights.slice(0, 5)) {
    console.log(
      `    [${r.id.slice(0, 8)}] surfaces=${r.surfacedCount} avgScore=${r.avgScore.toFixed(3)} "${r.preview}"`,
    );
  }

  console.log(
    `  Weak insights (need embedding fix): ${weakInsights.length}`,
  );
  for (const w of weakInsights.slice(0, 5)) {
    console.log(
      `    [${w.id.slice(0, 8)}] surfaces=${w.surfacedCount} avgScore=${w.avgScore.toFixed(3)} "${w.preview}"`,
    );
  }

  // ── Save results ──────────────────────────────────────────────
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/T/, '-')
    .replace(/:/g, '-')
    .slice(0, 16);
  const outputPath = path.join(
    __dirname,
    'autoresearch-results',
    `insight-boost-${timestamp}.json`,
  );

  const output = {
    timestamp: now.toISOString(),
    phase: 'Phase 3: Insight Recall Boost Optimizer',
    config: {
      engramUrl: ENGRAM_URL,
      boostFactorValues: BOOST_FACTOR_VALUES,
      minInsightScoreValues: MIN_INSIGHT_SCORE_VALUES,
      staticQueryCount: STATIC_GOLD_QUERIES.length,
      dynamicQueryCount: dynamicQueries.length,
    },
    insightCount: insights.length,
    optimal: {
      boostFactor: best.boostFactor,
      insightTop5Rate: best.insightTop5Rate,
      insightTop10Rate: best.insightTop10Rate,
      avgInsightRank: best.avgInsightRank,
      avgInsightScore: best.avgInsightScore,
    },
    sweepResults: allSweepResults,
    reliableInsights: reliableInsights.slice(0, 20),
    weakInsights: weakInsights.slice(0, 20),
    queryScores: allQueryScores,
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
