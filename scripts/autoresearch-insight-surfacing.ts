/**
 * Autoresearch Insight Surfacing Optimizer — Phase 4
 *
 * Tests the anticipatory recall engine and proactive notification layer:
 * - AnticipatoryService (src/anticipatory/)
 * - ProactiveNotificationService (src/awareness/proactive-notification.service.ts)
 *
 * Sweeps anticipatory parameters (minSalience, maxResults, strategy weights)
 * to find optimal settings for surfacing insights alongside standard recall.
 *
 * Usage:
 *   npx ts-node scripts/autoresearch-insight-surfacing.ts
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
const MIN_SALIENCE_VALUES = [0.2, 0.3, 0.4, 0.5];
const MAX_RESULTS_VALUES = [2, 3, 5, 8];
const INSIGHT_INJECTION_WEIGHTS = [0.5, 0.8, 1.0, 1.2];
const ENTITY_RADIATION_WEIGHTS = [0.7, 1.0, 1.3];

// ── Types ───────────────────────────────────────────────────────

interface MemoryResult {
  id: string;
  raw: string;
  score?: number;
  layer?: string;
  recallSource?: string;
  anticipatory?: {
    strategy: string;
    reason: string;
    salience: number;
    entityPath?: string[];
    insightType?: string;
  };
  [key: string]: unknown;
}

interface QueryResponse {
  memories: MemoryResult[];
  latencyMs?: number;
  anticipatory?: {
    strategiesRun: string[];
    latencyMs: number;
    circuitBreakerActive: boolean;
    signals: {
      entitiesDetected: string[];
      topics: string[];
    };
  };
}

interface GoldSurfacingQuery {
  id: string;
  query: string;
  user: string;
  expectedContext: string; // what kind of anticipatory context should surface
  category: string;
}

interface SurfacingScore {
  queryId: string;
  minSalience: number;
  maxResults: number;
  strategies: string[] | null;
  hasAnticipatoryResults: boolean;
  anticipatoryCount: number;
  anticipatoryStrategies: string[];
  avgSalience: number;
  topSalience: number;
  hasInsightInjection: boolean;
  hasEntityRadiation: boolean;
  directResultCount: number;
  latencyMs: number;
  anticipatoryLatencyMs: number;
  error?: string;
}

interface SweepResult {
  minSalience: number;
  maxResults: number;
  strategies: string[] | null;
  avgAnticipatoryCount: number;
  surfacingRate: number; // % of queries that got any anticipatory results
  avgSalience: number;
  insightInjectionRate: number;
  entityRadiationRate: number;
  avgLatencyMs: number;
  avgAnticipatoryLatencyMs: number;
  totalQueries: number;
}

// ── Gold Queries ────────────────────────────────────────────────

const GOLD_SURFACING_QUERIES: GoldSurfacingQuery[] = [
  {
    id: 'surf_01',
    query: 'What should I work on today?',
    user: 'alice',
    expectedContext: 'recent work-related insights + high-salience patterns',
    category: 'daily_planning',
  },
  {
    id: 'surf_02',
    query: 'Tell me about my health',
    user: 'alice',
    expectedContext: 'health-related insights and medication reminders',
    category: 'health',
  },
  {
    id: 'surf_03',
    query: 'How is my project going?',
    user: 'alice',
    expectedContext: 'work pattern insights + project context',
    category: 'project_status',
  },
  {
    id: 'surf_04',
    query: 'What are my priorities this week?',
    user: 'alice',
    expectedContext: 'task insights + behavioral patterns about prioritization',
    category: 'priorities',
  },
  {
    id: 'surf_05',
    query: 'Remind me about my meetings',
    user: 'alice',
    expectedContext: 'scheduling patterns + meeting-related context',
    category: 'scheduling',
  },
  {
    id: 'surf_06',
    query: 'What have I been learning lately?',
    user: 'alice',
    expectedContext: 'learning-related insights + knowledge growth patterns',
    category: 'learning',
  },
  {
    id: 'surf_07',
    query: "How am I doing with my goals?",
    user: 'alice',
    expectedContext: 'goal-related insights + progress patterns',
    category: 'goals',
  },
  {
    id: 'surf_08',
    query: 'What did I forget to do?',
    user: 'alice',
    expectedContext: 'task-related insights + behavioral patterns about forgetfulness',
    category: 'task_tracking',
  },
  {
    id: 'surf_09',
    query: 'Tell me about my family',
    user: 'alice',
    expectedContext: 'family-related context + relationship insights',
    category: 'family',
  },
  {
    id: 'surf_10',
    query: 'What code patterns should I follow?',
    user: 'alice',
    expectedContext: 'coding insights + tech stack patterns',
    category: 'development',
  },
];

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

async function queryWithAnticipatory(
  query: string,
  user: string,
  limit: number,
  anticipatoryOptions: {
    enabled: boolean;
    maxResults?: number;
    minSalience?: number;
    strategies?: string[];
  },
): Promise<QueryResponse> {
  const startTime = Date.now();

  const body: Record<string, unknown> = {
    query,
    limit,
    anticipatory: anticipatoryOptions,
  };

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

  const data = (await res.json()) as QueryResponse;
  if (!data.latencyMs) {
    data.latencyMs = clientLatency;
  }
  return data;
}

async function queryBaseline(
  query: string,
  user: string,
  limit: number,
): Promise<QueryResponse> {
  const startTime = Date.now();

  const res = await fetch(`${ENGRAM_URL}/v1/memories/query`, {
    method: 'POST',
    headers: makeHeaders(user),
    body: JSON.stringify({ query, limit }),
  });

  const clientLatency = Date.now() - startTime;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Query failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as QueryResponse;
  if (!data.latencyMs) {
    data.latencyMs = clientLatency;
  }
  return data;
}

// ── Scoring ─────────────────────────────────────────────────────

function scoreResult(
  queryId: string,
  minSalience: number,
  maxResults: number,
  strategies: string[] | null,
  response: QueryResponse,
): SurfacingScore {
  // Identify anticipatory results
  const anticipatoryMemories = response.memories.filter(
    (m) => m.recallSource === 'anticipatory' || m.anticipatory,
  );
  const directMemories = response.memories.filter(
    (m) => m.recallSource !== 'anticipatory' && !m.anticipatory,
  );

  const salienceValues = anticipatoryMemories
    .map((m) => m.anticipatory?.salience ?? 0)
    .filter((s) => s > 0);

  const strategiesUsed = [
    ...new Set(
      anticipatoryMemories
        .map((m) => m.anticipatory?.strategy)
        .filter(Boolean) as string[],
    ),
  ];

  return {
    queryId,
    minSalience,
    maxResults,
    strategies,
    hasAnticipatoryResults: anticipatoryMemories.length > 0,
    anticipatoryCount: anticipatoryMemories.length,
    anticipatoryStrategies: strategiesUsed,
    avgSalience:
      salienceValues.length > 0
        ? salienceValues.reduce((a, b) => a + b, 0) / salienceValues.length
        : 0,
    topSalience: salienceValues.length > 0 ? Math.max(...salienceValues) : 0,
    hasInsightInjection: strategiesUsed.includes('insight_injection'),
    hasEntityRadiation: strategiesUsed.includes('entity_radiation'),
    directResultCount: directMemories.length,
    latencyMs: response.latencyMs ?? 0,
    anticipatoryLatencyMs: response.anticipatory?.latencyMs ?? 0,
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(70));
  console.log(
    'Autoresearch Insight Surfacing Optimizer — Phase 4',
  );
  console.log('='.repeat(70));
  console.log(`Target:     ${ENGRAM_URL}`);
  console.log(`Auth:       ${API_KEY ? 'API Key' : 'LAN Bypass'}`);
  console.log(`Queries:    ${GOLD_SURFACING_QUERIES.length}`);
  console.log(
    `Sweep:      minSalience=[${MIN_SALIENCE_VALUES.join(',')}]`,
  );
  console.log(
    `            maxResults=[${MAX_RESULTS_VALUES.join(',')}]`,
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

  // Warm-up
  try {
    await queryBaseline('test', 'alice', 5);
    console.log('Warm-up: OK\n');
  } catch (err) {
    console.error(`Warm-up failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Step 1: Baseline (no anticipatory) ────────────────────────
  console.log('Step 1: Baseline queries (no anticipatory)...');
  const baselineResults = new Map<string, QueryResponse>();

  for (const q of GOLD_SURFACING_QUERIES) {
    try {
      const result = await queryBaseline(q.query, q.user, 10);
      baselineResults.set(q.id, result);
      process.stdout.write('.');
    } catch (err) {
      console.log(
        `\n  Baseline query ${q.id} failed: ${(err as Error).message}`,
      );
    }
    if (QUERY_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
    }
  }
  console.log(` Done (${baselineResults.size} queries).`);

  // Show baseline summary
  const baselineMemoryCounts = Array.from(baselineResults.values()).map(
    (r) => r.memories.length,
  );
  const avgBaselineCount =
    baselineMemoryCounts.length > 0
      ? baselineMemoryCounts.reduce((a, b) => a + b, 0) /
        baselineMemoryCounts.length
      : 0;
  console.log(
    `  Avg baseline results: ${avgBaselineCount.toFixed(1)}`,
  );

  // ── Step 2: Sweep anticipatory parameters ─────────────────────
  console.log('\nStep 2: Sweeping anticipatory parameters...');

  const allScores: SurfacingScore[] = [];
  const allSweepResults: SweepResult[] = [];
  let runIndex = 0;

  // First: sweep minSalience × maxResults with all strategies enabled
  const totalRuns =
    MIN_SALIENCE_VALUES.length * MAX_RESULTS_VALUES.length;

  for (const minSalience of MIN_SALIENCE_VALUES) {
    for (const maxResults of MAX_RESULTS_VALUES) {
      runIndex++;
      const scores: SurfacingScore[] = [];

      for (const q of GOLD_SURFACING_QUERIES) {
        try {
          const response = await queryWithAnticipatory(
            q.query,
            q.user,
            10,
            {
              enabled: true,
              maxResults,
              minSalience,
            },
          );

          const score = scoreResult(
            q.id,
            minSalience,
            maxResults,
            null,
            response,
          );
          scores.push(score);
          allScores.push(score);
        } catch (err) {
          scores.push({
            queryId: q.id,
            minSalience,
            maxResults,
            strategies: null,
            hasAnticipatoryResults: false,
            anticipatoryCount: 0,
            anticipatoryStrategies: [],
            avgSalience: 0,
            topSalience: 0,
            hasInsightInjection: false,
            hasEntityRadiation: false,
            directResultCount: 0,
            latencyMs: 0,
            anticipatoryLatencyMs: 0,
            error: (err as Error).message,
          });
        }

        if (QUERY_DELAY_MS > 0) {
          await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
        }
      }

      // Aggregate
      const withAnticipatory = scores.filter(
        (s) => s.hasAnticipatoryResults,
      );
      const avgCount =
        scores.length > 0
          ? scores.reduce((s, q) => s + q.anticipatoryCount, 0) /
            scores.length
          : 0;
      const avgSal =
        withAnticipatory.length > 0
          ? withAnticipatory.reduce((s, q) => s + q.avgSalience, 0) /
            withAnticipatory.length
          : 0;
      const insightInj = scores.filter(
        (s) => s.hasInsightInjection,
      ).length;
      const entityRad = scores.filter(
        (s) => s.hasEntityRadiation,
      ).length;
      const avgLat =
        scores.length > 0
          ? scores.reduce((s, q) => s + q.latencyMs, 0) / scores.length
          : 0;
      const avgAntLat =
        scores.length > 0
          ? scores.reduce((s, q) => s + q.anticipatoryLatencyMs, 0) /
            scores.length
          : 0;

      const sweepResult: SweepResult = {
        minSalience,
        maxResults,
        strategies: null,
        avgAnticipatoryCount: Math.round(avgCount * 10) / 10,
        surfacingRate:
          scores.length > 0
            ? withAnticipatory.length / scores.length
            : 0,
        avgSalience: Math.round(avgSal * 1000) / 1000,
        insightInjectionRate:
          scores.length > 0 ? insightInj / scores.length : 0,
        entityRadiationRate:
          scores.length > 0 ? entityRad / scores.length : 0,
        avgLatencyMs: Math.round(avgLat),
        avgAnticipatoryLatencyMs: Math.round(avgAntLat),
        totalQueries: scores.length,
      };

      allSweepResults.push(sweepResult);

      console.log(
        `  [${runIndex}/${totalRuns}] minSal=${minSalience.toFixed(1)} maxRes=${maxResults} → surfacing=${(sweepResult.surfacingRate * 100).toFixed(0)}% avgCount=${sweepResult.avgAnticipatoryCount} avgSal=${sweepResult.avgSalience.toFixed(3)} insight=${(sweepResult.insightInjectionRate * 100).toFixed(0)}% entity=${(sweepResult.entityRadiationRate * 100).toFixed(0)}% lat=${sweepResult.avgLatencyMs}ms antLat=${sweepResult.avgAnticipatoryLatencyMs}ms`,
      );
    }
  }

  // ── Step 3: Strategy-specific sweeps ──────────────────────────
  console.log('\nStep 3: Testing individual strategies...');

  const strategyOnlyResults: SweepResult[] = [];

  for (const strategySet of [
    ['insight_injection'],
    ['entity_radiation'],
    ['insight_injection', 'entity_radiation'],
  ]) {
    const scores: SurfacingScore[] = [];

    for (const q of GOLD_SURFACING_QUERIES) {
      try {
        const response = await queryWithAnticipatory(
          q.query,
          q.user,
          10,
          {
            enabled: true,
            maxResults: 3,
            minSalience: 0.3,
            strategies: strategySet,
          },
        );

        const score = scoreResult(
          q.id,
          0.3,
          3,
          strategySet,
          response,
        );
        scores.push(score);
      } catch {
        // skip errors for strategy-specific tests
      }

      if (QUERY_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
      }
    }

    const withAnticipatory = scores.filter(
      (s) => s.hasAnticipatoryResults,
    );
    const avgCount =
      scores.length > 0
        ? scores.reduce((s, q) => s + q.anticipatoryCount, 0) /
          scores.length
        : 0;
    const avgSal =
      withAnticipatory.length > 0
        ? withAnticipatory.reduce((s, q) => s + q.avgSalience, 0) /
          withAnticipatory.length
        : 0;

    const result: SweepResult = {
      minSalience: 0.3,
      maxResults: 3,
      strategies: strategySet,
      avgAnticipatoryCount: Math.round(avgCount * 10) / 10,
      surfacingRate:
        scores.length > 0 ? withAnticipatory.length / scores.length : 0,
      avgSalience: Math.round(avgSal * 1000) / 1000,
      insightInjectionRate:
        scores.length > 0
          ? scores.filter((s) => s.hasInsightInjection).length /
            scores.length
          : 0,
      entityRadiationRate:
        scores.length > 0
          ? scores.filter((s) => s.hasEntityRadiation).length /
            scores.length
          : 0,
      avgLatencyMs: Math.round(
        scores.length > 0
          ? scores.reduce((s, q) => s + q.latencyMs, 0) / scores.length
          : 0,
      ),
      avgAnticipatoryLatencyMs: Math.round(
        scores.length > 0
          ? scores.reduce((s, q) => s + q.anticipatoryLatencyMs, 0) /
            scores.length
          : 0,
      ),
      totalQueries: scores.length,
    };

    strategyOnlyResults.push(result);

    console.log(
      `  strategies=[${strategySet.join(',')}] → surfacing=${(result.surfacingRate * 100).toFixed(0)}% avgCount=${result.avgAnticipatoryCount} avgSal=${result.avgSalience.toFixed(3)}`,
    );
  }

  // ── Results Summary ───────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(70));

  // Find best sweep result by surfacing rate, then by avg anticipatory count
  const best = allSweepResults.reduce((a, b) => {
    if (b.surfacingRate > a.surfacingRate) return b;
    if (
      b.surfacingRate === a.surfacingRate &&
      b.avgAnticipatoryCount > a.avgAnticipatoryCount
    )
      return b;
    return a;
  });

  console.log('\nOptimal anticipatory parameters:');
  console.log(`  minSalience:         ${best.minSalience}`);
  console.log(`  maxResults:          ${best.maxResults}`);
  console.log(
    `  Surfacing rate:      ${(best.surfacingRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Avg anticipatory:    ${best.avgAnticipatoryCount} results/query`,
  );
  console.log(
    `  Avg salience:        ${best.avgSalience.toFixed(3)}`,
  );
  console.log(
    `  Insight injection:   ${(best.insightInjectionRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Entity radiation:    ${(best.entityRadiationRate * 100).toFixed(1)}%`,
  );
  console.log(`  Avg latency:         ${best.avgLatencyMs}ms`);
  console.log(
    `  Anticipatory latency: ${best.avgAnticipatoryLatencyMs}ms`,
  );

  // Check if anticipatory is even working
  const anyAnticipatory = allScores.some(
    (s) => s.hasAnticipatoryResults,
  );
  if (!anyAnticipatory) {
    console.log(
      '\n  NOTE: No anticipatory results were returned for any query.',
    );
    console.log(
      '  This likely means ANTICIPATORY_ENABLED=false or the engine',
    );
    console.log(
      '  is disabled. Set ANTICIPATORY_ENABLED=true and restart.',
    );
    console.log(
      '  The sweep data is still valuable as a baseline measurement.',
    );
  }

  // Mutation log
  console.log(
    '\n── Full Sweep Log ────────────────────────────────────────',
  );
  console.log(
    'minSal  maxRes  surfaceRate  avgCount  avgSal  insightPct  entityPct  latMs  antLatMs',
  );
  for (const r of allSweepResults) {
    console.log(
      `${r.minSalience.toFixed(1).padStart(6)}  ${r.maxResults.toString().padStart(6)}  ${(r.surfacingRate * 100).toFixed(0).padStart(11)}%  ${r.avgAnticipatoryCount.toFixed(1).padStart(8)}  ${r.avgSalience.toFixed(3).padStart(6)}  ${(r.insightInjectionRate * 100).toFixed(0).padStart(10)}%  ${(r.entityRadiationRate * 100).toFixed(0).padStart(9)}%  ${r.avgLatencyMs.toString().padStart(5)}  ${r.avgAnticipatoryLatencyMs.toString().padStart(8)}`,
    );
  }

  // Per-query breakdown for best params
  console.log('\n── Per-Query Breakdown (best params) ─────────────────');
  const bestQueryScores = allScores.filter(
    (s) =>
      s.minSalience === best.minSalience &&
      s.maxResults === best.maxResults &&
      s.strategies === null,
  );

  for (const s of bestQueryScores) {
    const gold = GOLD_SURFACING_QUERIES.find((q) => q.id === s.queryId);
    const status = s.hasAnticipatoryResults
      ? `${s.anticipatoryCount} results [${s.anticipatoryStrategies.join(',')}] sal=${s.avgSalience.toFixed(2)}`
      : 'no anticipatory';
    console.log(
      `  ${s.queryId}: "${gold?.query?.slice(0, 40)}" → ${status}`,
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
    `insight-surfacing-${timestamp}.json`,
  );

  const output = {
    timestamp: now.toISOString(),
    phase: 'Phase 4: Insight Surfacing Optimizer',
    config: {
      engramUrl: ENGRAM_URL,
      minSalienceValues: MIN_SALIENCE_VALUES,
      maxResultsValues: MAX_RESULTS_VALUES,
      insightInjectionWeights: INSIGHT_INJECTION_WEIGHTS,
      entityRadiationWeights: ENTITY_RADIATION_WEIGHTS,
      queryCount: GOLD_SURFACING_QUERIES.length,
    },
    anticipatoryActive: anyAnticipatory,
    optimal: {
      minSalience: best.minSalience,
      maxResults: best.maxResults,
      surfacingRate: best.surfacingRate,
      avgAnticipatoryCount: best.avgAnticipatoryCount,
      avgSalience: best.avgSalience,
      insightInjectionRate: best.insightInjectionRate,
      entityRadiationRate: best.entityRadiationRate,
      avgLatencyMs: best.avgLatencyMs,
      avgAnticipatoryLatencyMs: best.avgAnticipatoryLatencyMs,
    },
    baseline: {
      avgResultCount: Math.round(avgBaselineCount * 10) / 10,
      queryCount: baselineResults.size,
    },
    sweepResults: allSweepResults,
    strategyResults: strategyOnlyResults,
    perQueryScores: allScores,
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
