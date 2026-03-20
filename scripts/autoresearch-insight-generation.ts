/**
 * Autoresearch Insight Generation Optimizer — Phase 2
 *
 * Evaluates the Dream Cycle's pattern → INSIGHT memory pipeline
 * (via src/awareness/). Documents current insight inventory,
 * confidence distribution, and optionally triggers a waking cycle
 * to measure insight generation under different parameter combos.
 *
 * Usage:
 *   npx ts-node scripts/autoresearch-insight-generation.ts
 *
 * Requires: Engram running locally on port 3001 with TRUST_LOCAL_NETWORK=true
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Configuration ───────────────────────────────────────────────

const ENGRAM_URL = process.env.ENGRAM_URL || 'http://localhost:3001';
const API_KEY = process.env.AM_API_KEY || '';

// Parameter sweep values
const MIN_CONFIDENCE_VALUES = [0.3, 0.4, 0.5, 0.6, 0.7];
const MAX_INSIGHTS_PER_CYCLE_VALUES = [3, 5, 8, 10];
const INSIGHT_TTL_DAYS_VALUES = [7, 14, 21, 30];

// ── Types ───────────────────────────────────────────────────────

interface InsightRecord {
  id: string;
  title: string | null;
  content: string;
  category: string | null;
  confidence: number | null;
  createdAt: string;
}

interface ConfidenceDistribution {
  bucket: string;
  count: number;
  percentage: number;
}

interface CategoryDistribution {
  category: string;
  count: number;
  percentage: number;
  avgConfidence: number;
}

interface InsightInventory {
  totalInsights: number;
  avgConfidence: number;
  medianConfidence: number;
  confidenceDistribution: ConfidenceDistribution[];
  categoryDistribution: CategoryDistribution[];
  actionableCount: number;
  actionablePercentage: number;
  oldestInsight: string | null;
  newestInsight: string | null;
  insightsByAge: { bucket: string; count: number }[];
}

interface CycleResult {
  observations: number;
  patterns: number;
  insights: number;
  durationMs: number;
  error?: string;
}

interface CycleStatus {
  phase: string;
  lastRun: string | null;
  insightsGenerated: number;
  duration: number;
  observations: number;
  patterns: number;
}

interface ParamRecommendation {
  param: string;
  currentDefault: string;
  recommended: string;
  reason: string;
}

// ── API Client ──────────────────────────────────────────────────

function makeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
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
  const res = await fetch(
    `${ENGRAM_URL}/v1/awareness/insights?limit=${limit}&offset=${offset}`,
    { headers: makeHeaders() },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GET /v1/awareness/insights failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as InsightRecord[];
}

async function fetchAllInsights(): Promise<InsightRecord[]> {
  const all: InsightRecord[] = [];
  let offset = 0;
  const batchSize = 100;
  while (true) {
    const batch = await fetchInsights(batchSize, offset);
    all.push(...batch);
    if (batch.length < batchSize) break;
    offset += batchSize;
  }
  return all;
}

async function getCycleStatus(): Promise<CycleStatus | null> {
  try {
    const res = await fetch(
      `${ENGRAM_URL}/v1/awareness/cycle/status`,
      { headers: makeHeaders() },
    );
    if (!res.ok) return null;
    return (await res.json()) as CycleStatus;
  } catch {
    return null;
  }
}

async function triggerCycle(): Promise<CycleResult> {
  try {
    const res = await fetch(
      `${ENGRAM_URL}/v1/awareness/awareness/cycle`,
      {
        method: 'POST',
        headers: makeHeaders(),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        observations: 0,
        patterns: 0,
        insights: 0,
        durationMs: 0,
        error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    return (await res.json()) as CycleResult;
  } catch (err) {
    return {
      observations: 0,
      patterns: 0,
      insights: 0,
      durationMs: 0,
      error: (err as Error).message,
    };
  }
}

// ── Analysis ────────────────────────────────────────────────────

function buildInventory(insights: InsightRecord[]): InsightInventory {
  if (insights.length === 0) {
    return {
      totalInsights: 0,
      avgConfidence: 0,
      medianConfidence: 0,
      confidenceDistribution: [],
      categoryDistribution: [],
      actionableCount: 0,
      actionablePercentage: 0,
      oldestInsight: null,
      newestInsight: null,
      insightsByAge: [],
    };
  }

  // Confidence stats
  const confidences = insights
    .map((i) => i.confidence)
    .filter((c): c is number => c !== null && c !== undefined);

  const avg =
    confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0;

  const sorted = [...confidences].sort((a, b) => a - b);
  const median =
    sorted.length > 0
      ? sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)]
      : 0;

  // Confidence distribution buckets
  const buckets = [
    { label: '0.0-0.3', min: 0.0, max: 0.3 },
    { label: '0.3-0.5', min: 0.3, max: 0.5 },
    { label: '0.5-0.7', min: 0.5, max: 0.7 },
    { label: '0.7-0.9', min: 0.7, max: 0.9 },
    { label: '0.9-1.0', min: 0.9, max: 1.01 },
  ];

  const confidenceDistribution: ConfidenceDistribution[] = buckets.map(
    (b) => {
      const count = confidences.filter(
        (c) => c >= b.min && c < b.max,
      ).length;
      return {
        bucket: b.label,
        count,
        percentage:
          confidences.length > 0
            ? Math.round((count / confidences.length) * 100)
            : 0,
      };
    },
  );

  // Category distribution
  const catMap = new Map<
    string,
    { count: number; totalConf: number; confCount: number }
  >();
  for (const insight of insights) {
    const cat = insight.category || 'uncategorized';
    const entry = catMap.get(cat) || { count: 0, totalConf: 0, confCount: 0 };
    entry.count++;
    if (insight.confidence !== null && insight.confidence !== undefined) {
      entry.totalConf += insight.confidence;
      entry.confCount++;
    }
    catMap.set(cat, entry);
  }

  const categoryDistribution: CategoryDistribution[] = Array.from(
    catMap.entries(),
  )
    .map(([category, data]) => ({
      category,
      count: data.count,
      percentage: Math.round((data.count / insights.length) * 100),
      avgConfidence:
        data.confCount > 0
          ? Math.round((data.totalConf / data.confCount) * 100) / 100
          : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // Actionable: insights with confidence >= 0.5
  const actionableCount = insights.filter(
    (i) => (i.confidence ?? 0) >= 0.5,
  ).length;

  // Age distribution
  const now = Date.now();
  const ageBuckets = [
    { label: '< 1 day', maxMs: 1 * 24 * 60 * 60 * 1000 },
    { label: '1-3 days', maxMs: 3 * 24 * 60 * 60 * 1000 },
    { label: '3-7 days', maxMs: 7 * 24 * 60 * 60 * 1000 },
    { label: '7-14 days', maxMs: 14 * 24 * 60 * 60 * 1000 },
    { label: '14-30 days', maxMs: 30 * 24 * 60 * 60 * 1000 },
    { label: '> 30 days', maxMs: Infinity },
  ];

  const insightsByAge = ageBuckets.map((bucket, i) => {
    const prevMax = i > 0 ? ageBuckets[i - 1].maxMs : 0;
    const count = insights.filter((ins) => {
      const age = now - new Date(ins.createdAt).getTime();
      return age >= prevMax && age < bucket.maxMs;
    }).length;
    return { bucket: bucket.label, count };
  });

  // Date range
  const dates = insights
    .map((i) => new Date(i.createdAt).getTime())
    .sort((a, b) => a - b);

  return {
    totalInsights: insights.length,
    avgConfidence: Math.round(avg * 1000) / 1000,
    medianConfidence: Math.round(median * 1000) / 1000,
    confidenceDistribution,
    categoryDistribution,
    actionableCount,
    actionablePercentage: Math.round(
      (actionableCount / insights.length) * 100,
    ),
    oldestInsight: dates.length > 0 ? new Date(dates[0]).toISOString() : null,
    newestInsight:
      dates.length > 0
        ? new Date(dates[dates.length - 1]).toISOString()
        : null,
    insightsByAge,
  };
}

function evaluateParamCombos(
  insights: InsightRecord[],
): {
  combo: {
    minConfidence: number;
    maxInsightsPerCycle: number;
    insightTtlDays: number;
  };
  wouldRetain: number;
  retainPercentage: number;
  avgRetainedConfidence: number;
}[] {
  const results: {
    combo: {
      minConfidence: number;
      maxInsightsPerCycle: number;
      insightTtlDays: number;
    };
    wouldRetain: number;
    retainPercentage: number;
    avgRetainedConfidence: number;
  }[] = [];

  const now = Date.now();

  for (const minConf of MIN_CONFIDENCE_VALUES) {
    for (const ttl of INSIGHT_TTL_DAYS_VALUES) {
      const ttlMs = ttl * 24 * 60 * 60 * 1000;

      // Filter insights that would survive this param combo
      const retained = insights.filter((i) => {
        const conf = i.confidence ?? 0;
        const age = now - new Date(i.createdAt).getTime();
        return conf >= minConf && age <= ttlMs;
      });

      const avgConf =
        retained.length > 0
          ? retained.reduce((s, i) => s + (i.confidence ?? 0), 0) /
            retained.length
          : 0;

      // We test maxInsightsPerCycle as a separate dimension
      // (doesn't affect current inventory, only future generation)
      for (const maxIns of MAX_INSIGHTS_PER_CYCLE_VALUES) {
        results.push({
          combo: {
            minConfidence: minConf,
            maxInsightsPerCycle: maxIns,
            insightTtlDays: ttl,
          },
          wouldRetain: retained.length,
          retainPercentage:
            insights.length > 0
              ? Math.round((retained.length / insights.length) * 100)
              : 0,
          avgRetainedConfidence: Math.round(avgConf * 1000) / 1000,
        });
      }
    }
  }

  return results;
}

function generateRecommendations(
  inventory: InsightInventory,
  insights: InsightRecord[],
): ParamRecommendation[] {
  const recommendations: ParamRecommendation[] = [];

  // MIN_CONFIDENCE recommendation
  if (inventory.avgConfidence > 0.7) {
    recommendations.push({
      param: 'AWARENESS_MIN_CONFIDENCE',
      currentDefault: '0.5',
      recommended: '0.6',
      reason: `Average confidence is ${inventory.avgConfidence.toFixed(2)}, indicating high-quality insights. Raising threshold to 0.6 would filter out low-value noise.`,
    });
  } else if (inventory.avgConfidence < 0.4) {
    recommendations.push({
      param: 'AWARENESS_MIN_CONFIDENCE',
      currentDefault: '0.5',
      recommended: '0.3',
      reason: `Average confidence is only ${inventory.avgConfidence.toFixed(2)}. Lowering threshold to 0.3 allows more insights through until quality improves.`,
    });
  } else {
    recommendations.push({
      param: 'AWARENESS_MIN_CONFIDENCE',
      currentDefault: '0.5',
      recommended: '0.5',
      reason: `Average confidence is ${inventory.avgConfidence.toFixed(2)} — current default of 0.5 is well-calibrated.`,
    });
  }

  // MAX_INSIGHTS_PER_CYCLE recommendation
  if (inventory.totalInsights < 10) {
    recommendations.push({
      param: 'AWARENESS_MAX_INSIGHTS_PER_CYCLE',
      currentDefault: '5',
      recommended: '8',
      reason: `Only ${inventory.totalInsights} insights exist. Increasing to 8/cycle will build up the insight corpus faster.`,
    });
  } else if (inventory.totalInsights > 100) {
    recommendations.push({
      param: 'AWARENESS_MAX_INSIGHTS_PER_CYCLE',
      currentDefault: '5',
      recommended: '3',
      reason: `${inventory.totalInsights} insights already — reducing to 3/cycle avoids overwhelming users.`,
    });
  } else {
    recommendations.push({
      param: 'AWARENESS_MAX_INSIGHTS_PER_CYCLE',
      currentDefault: '5',
      recommended: '5',
      reason: `${inventory.totalInsights} insights exist — current default of 5/cycle is appropriate.`,
    });
  }

  // TTL recommendation
  const now = Date.now();
  const recentInsights = insights.filter(
    (i) => now - new Date(i.createdAt).getTime() < 14 * 24 * 60 * 60 * 1000,
  );
  const staleRatio =
    insights.length > 0
      ? (insights.length - recentInsights.length) / insights.length
      : 0;

  if (staleRatio > 0.5) {
    recommendations.push({
      param: 'AWARENESS_INSIGHT_TTL_DAYS',
      currentDefault: '14',
      recommended: '21',
      reason: `${Math.round(staleRatio * 100)}% of insights are older than 14 days. Extending TTL to 21 days would preserve more historical context.`,
    });
  } else if (staleRatio < 0.1 && insights.length > 20) {
    recommendations.push({
      param: 'AWARENESS_INSIGHT_TTL_DAYS',
      currentDefault: '14',
      recommended: '7',
      reason: `Almost all insights are fresh (<14d old). A 7-day TTL would keep the corpus lean without losing value.`,
    });
  } else {
    recommendations.push({
      param: 'AWARENESS_INSIGHT_TTL_DAYS',
      currentDefault: '14',
      recommended: '14',
      reason: `Current TTL of 14 days is balanced — ${Math.round(staleRatio * 100)}% stale ratio is healthy.`,
    });
  }

  return recommendations;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(70));
  console.log(
    'Autoresearch Insight Generation Optimizer — Phase 2',
  );
  console.log('='.repeat(70));
  console.log(`Target:     ${ENGRAM_URL}`);
  console.log(`Auth:       ${API_KEY ? 'API Key' : 'LAN Bypass'}`);
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

  // ── Step 1: Fetch all existing insights ───────────────────────
  console.log('\nStep 1: Fetching existing INSIGHT memories...');
  let insights: InsightRecord[];
  try {
    insights = await fetchAllInsights();
    console.log(`  Found ${insights.length} insights.`);
  } catch (err) {
    console.error(`  Failed to fetch insights: ${(err as Error).message}`);
    console.error(
      '  The /v1/awareness/insights endpoint may not be available.',
    );
    insights = [];
  }

  // ── Step 2: Build inventory ───────────────────────────────────
  console.log('\nStep 2: Building insight inventory...');
  const inventory = buildInventory(insights);

  console.log(`  Total insights:     ${inventory.totalInsights}`);
  console.log(
    `  Avg confidence:     ${inventory.avgConfidence.toFixed(3)}`,
  );
  console.log(
    `  Median confidence:  ${inventory.medianConfidence.toFixed(3)}`,
  );
  console.log(
    `  Actionable:         ${inventory.actionableCount} (${inventory.actionablePercentage}%)`,
  );

  if (inventory.confidenceDistribution.length > 0) {
    console.log('\n  Confidence distribution:');
    for (const b of inventory.confidenceDistribution) {
      const bar = '#'.repeat(Math.round(b.percentage / 2));
      console.log(
        `    ${b.bucket.padEnd(8)} ${b.count.toString().padStart(4)} (${b.percentage.toString().padStart(3)}%) ${bar}`,
      );
    }
  }

  if (inventory.categoryDistribution.length > 0) {
    console.log('\n  Category distribution:');
    for (const c of inventory.categoryDistribution) {
      console.log(
        `    ${(c.category || 'null').padEnd(30)} ${c.count.toString().padStart(4)} (${c.percentage.toString().padStart(3)}%) avgConf=${c.avgConfidence.toFixed(2)}`,
      );
    }
  }

  if (inventory.insightsByAge.length > 0) {
    console.log('\n  Age distribution:');
    for (const a of inventory.insightsByAge) {
      if (a.count > 0) {
        console.log(
          `    ${a.bucket.padEnd(14)} ${a.count.toString().padStart(4)}`,
        );
      }
    }
  }

  // ── Step 3: Check waking cycle status ─────────────────────────
  console.log('\nStep 3: Checking waking cycle status...');
  const cycleStatus = await getCycleStatus();
  if (cycleStatus) {
    console.log(`  Phase:              ${cycleStatus.phase}`);
    console.log(`  Last run:           ${cycleStatus.lastRun || 'never'}`);
    console.log(
      `  Insights generated: ${cycleStatus.insightsGenerated}`,
    );
    console.log(`  Duration:           ${cycleStatus.duration}ms`);
    console.log(`  Observations:       ${cycleStatus.observations}`);
    console.log(`  Patterns:           ${cycleStatus.patterns}`);
  } else {
    console.log(
      '  Cycle status endpoint not available (AWARENESS_ENABLED=false?)',
    );
  }

  // ── Step 4: Attempt to trigger a waking cycle ─────────────────
  console.log('\nStep 4: Attempting to trigger waking cycle...');
  const cycleResult = await triggerCycle();
  if (cycleResult.error) {
    console.log(`  Cycle trigger returned: ${cycleResult.error}`);
    console.log(
      '  (This is expected if AWARENESS_ENABLED=false — script continues with existing data)',
    );
  } else {
    console.log(
      `  Cycle completed: ${cycleResult.observations} observations, ${cycleResult.patterns} patterns, ${cycleResult.insights} insights (${cycleResult.durationMs}ms)`,
    );

    // Re-fetch insights after cycle
    if (cycleResult.insights > 0) {
      console.log('  Re-fetching insights after cycle...');
      insights = await fetchAllInsights();
      console.log(`  Now have ${insights.length} insights.`);
    }
  }

  // ── Step 5: Parameter combo evaluation ────────────────────────
  console.log('\nStep 5: Evaluating parameter combinations...');
  console.log(
    `  Sweeping: minConfidence=[${MIN_CONFIDENCE_VALUES.join(',')}] × ttlDays=[${INSIGHT_TTL_DAYS_VALUES.join(',')}] × maxPerCycle=[${MAX_INSIGHTS_PER_CYCLE_VALUES.join(',')}]`,
  );

  const combos = evaluateParamCombos(insights);

  // Show top combos by retain count (grouped by minConf × ttl)
  const uniqueCombos = new Map<
    string,
    { wouldRetain: number; retainPct: number; avgConf: number }
  >();
  for (const c of combos) {
    const key = `conf=${c.combo.minConfidence} ttl=${c.combo.insightTtlDays}`;
    if (!uniqueCombos.has(key)) {
      uniqueCombos.set(key, {
        wouldRetain: c.wouldRetain,
        retainPct: c.retainPercentage,
        avgConf: c.avgRetainedConfidence,
      });
    }
  }

  console.log(
    '\n  minConf  ttlDays  retained  retainPct  avgRetainedConf',
  );
  for (const [key, val] of uniqueCombos) {
    console.log(
      `  ${key.padEnd(20)} ${val.wouldRetain.toString().padStart(8)}  ${(val.retainPct + '%').padStart(9)}  ${val.avgConf.toFixed(3).padStart(15)}`,
    );
  }

  // ── Step 6: Generate recommendations ──────────────────────────
  console.log('\nStep 6: Generating recommendations...');
  const recommendations = generateRecommendations(inventory, insights);

  for (const rec of recommendations) {
    console.log(`\n  ${rec.param}:`);
    console.log(`    Current default: ${rec.currentDefault}`);
    console.log(`    Recommended:     ${rec.recommended}`);
    console.log(`    Reason:          ${rec.reason}`);
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
    `insight-generation-${timestamp}.json`,
  );

  const output = {
    timestamp: now.toISOString(),
    phase: 'Phase 2: Insight Generation Optimizer',
    config: {
      engramUrl: ENGRAM_URL,
      minConfidenceValues: MIN_CONFIDENCE_VALUES,
      maxInsightsPerCycleValues: MAX_INSIGHTS_PER_CYCLE_VALUES,
      insightTtlDaysValues: INSIGHT_TTL_DAYS_VALUES,
    },
    inventory,
    cycleStatus,
    cycleResult: cycleResult.error
      ? { error: cycleResult.error }
      : cycleResult,
    paramEvaluation: combos,
    recommendations,
    sampleInsights: insights.slice(0, 10).map((i) => ({
      id: i.id,
      category: i.category,
      confidence: i.confidence,
      contentPreview: i.content?.slice(0, 120),
      createdAt: i.createdAt,
    })),
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
