/**
 * Engram Autoresearch — Recall Parameter Optimizer
 *
 * Tunes Engram's recall parameters against the semantic recall test suite.
 * Based on Karpathy's autoresearch methodology.
 *
 * Tunable parameters:
 * - minScore (similarity threshold, default 0.35)
 * - maxResults (top-k, default 5)
 * - TOPIC_SHIFT_THRESHOLD (cosine distance, default 0.4)
 * - recencyHalfLifeDays (usage decay, default 14)
 * - usageWeight (usage signal weight, default 0.15)
 * - boostFactor (delegation boost, default 1.5)
 *
 * NOTE: This requires a running Engram instance with populated memories.
 * It modifies environment variables and recall DTO defaults to test
 * different configurations, then measures recall accuracy.
 *
 * Usage:
 *   ENGRAM_URL=http://localhost:3001 npx ts-node tests/evaluation/autoresearch-recall.ts
 *
 * Run from the Engram repo root on a machine with the Engram server running.
 */

import * as fs from 'fs';
import * as path from 'path';
import { recallScenarios, RecallScenario } from './recall-scenarios';

const ENGRAM_URL = process.env.ENGRAM_URL || 'http://localhost:3001';
const USER_ID = process.env.ENGRAM_USER_ID || 'beaux';

// ── Configuration ────────────────────────────────────────────────────

interface RecallConfig {
  minScore: number;
  maxResults: number;
  // These require server-side changes — log recommendations only
  topicShiftThreshold?: number;
  recencyHalfLifeDays?: number;
  usageWeight?: number;
}

const BASELINE_CONFIG: RecallConfig = {
  minScore: 0.35,
  maxResults: 5,
};

// ── Recall Test Runner ───────────────────────────────────────────────

interface RecallResult {
  scenario: string;
  query: string;
  passed: boolean;
  matchedContent: string[];
  missedContent: string[];
  resultCount: number;
  topScore: number;
  duration: number;
}

async function queryEngram(
  query: string,
  config: RecallConfig,
): Promise<{ memories: any[]; scores: number[] }> {
  const res = await fetch(`${ENGRAM_URL}/v1/memories/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: USER_ID,
      query,
      limit: config.maxResults,
      minScore: config.minScore,
    }),
  });

  if (!res.ok) {
    throw new Error(`Engram query failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const memories = Array.isArray(data) ? data : data.memories || data.results || [];
  const scores = memories.map((m: any) => m.score || m.similarity || 0);

  return { memories, scores };
}

async function runScenario(
  scenario: RecallScenario,
  config: RecallConfig,
): Promise<RecallResult> {
  const start = Date.now();

  try {
    const { memories, scores } = await queryEngram(scenario.query, config);

    const matched: string[] = [];
    const missed: string[] = [];

    for (const expected of scenario.expectedContent) {
      const found = memories.some((m: any) => {
        const text = (m.content || m.raw || m.text || JSON.stringify(m)).toLowerCase();
        return text.includes(expected.toLowerCase());
      });
      if (found) matched.push(expected);
      else missed.push(expected);
    }

    return {
      scenario: scenario.description,
      query: scenario.query,
      passed: missed.length === 0,
      matchedContent: matched,
      missedContent: missed,
      resultCount: memories.length,
      topScore: scores[0] || 0,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      scenario: scenario.description,
      query: scenario.query,
      passed: false,
      matchedContent: [],
      missedContent: scenario.expectedContent,
      resultCount: 0,
      topScore: 0,
      duration: Date.now() - start,
    };
  }
}

// ── Eval Functions ───────────────────────────────────────────────────

interface EvalResult {
  passRate: number;
  passed: number;
  total: number;
  avgTopScore: number;
  avgResultCount: number;
  failures: { scenario: string; missed: string[] }[];
}

async function runEval(config: RecallConfig): Promise<EvalResult> {
  const results: RecallResult[] = [];

  for (const scenario of recallScenarios) {
    const result = await runScenario(scenario, config);
    results.push(result);
  }

  const passed = results.filter((r) => r.passed).length;
  const avgTopScore = results.reduce((s, r) => s + r.topScore, 0) / results.length;
  const avgResultCount = results.reduce((s, r) => s + r.resultCount, 0) / results.length;
  const failures = results
    .filter((r) => !r.passed)
    .map((r) => ({ scenario: r.scenario, missed: r.missedContent }));

  return {
    passRate: passed / results.length,
    passed,
    total: results.length,
    avgTopScore,
    avgResultCount,
    failures,
  };
}

// ── Mutations ────────────────────────────────────────────────────────

interface Mutation {
  name: string;
  description: string;
  apply: (config: RecallConfig) => RecallConfig;
}

function generateMutations(config: RecallConfig): Mutation[] {
  return [
    // minScore — the big lever
    {
      name: 'minScore_down_005',
      description: `Lower similarity threshold: ${config.minScore} → ${(config.minScore - 0.05).toFixed(2)} (more permissive, higher recall)`,
      apply: (c) => ({ ...c, minScore: Math.max(0.10, c.minScore - 0.05) }),
    },
    {
      name: 'minScore_down_010',
      description: `Lower similarity threshold: ${config.minScore} → ${(config.minScore - 0.10).toFixed(2)} (much more permissive)`,
      apply: (c) => ({ ...c, minScore: Math.max(0.10, c.minScore - 0.10) }),
    },
    {
      name: 'minScore_up_005',
      description: `Raise similarity threshold: ${config.minScore} → ${(config.minScore + 0.05).toFixed(2)} (more precise, lower recall)`,
      apply: (c) => ({ ...c, minScore: Math.min(0.60, c.minScore + 0.05) }),
    },
    {
      name: 'minScore_down_002',
      description: `Fine-tune threshold down: ${config.minScore} → ${(config.minScore - 0.02).toFixed(2)}`,
      apply: (c) => ({ ...c, minScore: Math.max(0.10, c.minScore - 0.02) }),
    },
    {
      name: 'minScore_up_002',
      description: `Fine-tune threshold up: ${config.minScore} → ${(config.minScore + 0.02).toFixed(2)}`,
      apply: (c) => ({ ...c, minScore: Math.min(0.60, c.minScore + 0.02) }),
    },

    // maxResults — affects recall@k
    {
      name: 'maxResults_up_5',
      description: `Increase top-k: ${config.maxResults} → ${config.maxResults + 5} (wider net)`,
      apply: (c) => ({ ...c, maxResults: Math.min(30, c.maxResults + 5) }),
    },
    {
      name: 'maxResults_up_10',
      description: `Increase top-k: ${config.maxResults} → ${config.maxResults + 10} (much wider)`,
      apply: (c) => ({ ...c, maxResults: Math.min(30, c.maxResults + 10) }),
    },
    {
      name: 'maxResults_down_2',
      description: `Decrease top-k: ${config.maxResults} → ${Math.max(3, config.maxResults - 2)} (tighter)`,
      apply: (c) => ({ ...c, maxResults: Math.max(3, c.maxResults - 2) }),
    },
  ];
}

// ── Main Loop ────────────────────────────────────────────────────────

async function main() {
  const outDir = path.join(__dirname, 'autoresearch-results');
  fs.mkdirSync(outDir, { recursive: true });

  const resultsPath = path.join(outDir, 'results.tsv');
  const changelogPath = path.join(outDir, 'changelog.md');

  fs.writeFileSync(resultsPath, 'experiment\tpass_rate\tpassed\ttotal\tavg_top_score\tstatus\tconfig\tdescription\n');
  fs.writeFileSync(changelogPath, '# Autoresearch Changelog — Engram Recall Optimization\n\n');

  console.log('=== Engram Autoresearch — Recall Parameter Optimizer ===\n');
  console.log(`Server: ${ENGRAM_URL}`);
  console.log(`User: ${USER_ID}`);
  console.log(`Scenarios: ${recallScenarios.length}\n`);

  // Baseline
  console.log('📊 Experiment 0: BASELINE');
  console.log(`   Config: minScore=${BASELINE_CONFIG.minScore}, maxResults=${BASELINE_CONFIG.maxResults}`);

  const baseline = await runEval(BASELINE_CONFIG);
  console.log(`   Pass rate: ${baseline.passed}/${baseline.total} (${(baseline.passRate * 100).toFixed(1)}%)`);
  console.log(`   Avg top score: ${baseline.avgTopScore.toFixed(3)}`);
  console.log(`   Avg results: ${baseline.avgResultCount.toFixed(1)}`);
  if (baseline.failures.length > 0) {
    console.log(`   Failures:`);
    for (const f of baseline.failures) {
      console.log(`     ❌ ${f.scenario} — missing: ${f.missed.join(', ')}`);
    }
  }

  fs.appendFileSync(resultsPath, `0\t${(baseline.passRate * 100).toFixed(1)}%\t${baseline.passed}\t${baseline.total}\t${baseline.avgTopScore.toFixed(3)}\tbaseline\tminScore=${BASELINE_CONFIG.minScore},maxResults=${BASELINE_CONFIG.maxResults}\toriginal config\n`);
  fs.appendFileSync(changelogPath, `## Experiment 0 — baseline\n**Pass rate:** ${baseline.passed}/${baseline.total} (${(baseline.passRate * 100).toFixed(1)}%)\n**Config:** minScore=${BASELINE_CONFIG.minScore}, maxResults=${BASELINE_CONFIG.maxResults}\n**Avg top score:** ${baseline.avgTopScore.toFixed(3)}\n**Failures:** ${baseline.failures.map(f => f.scenario).join(', ') || 'none'}\n\n`);

  let currentConfig = { ...BASELINE_CONFIG };
  let bestPassRate = baseline.passRate;
  let bestPassed = baseline.passed;
  const MAX_EXPERIMENTS = 8;

  for (let exp = 1; exp <= MAX_EXPERIMENTS; exp++) {
    const mutations = generateMutations(currentConfig);
    const mutation = mutations[(exp - 1) % mutations.length];
    const candidateConfig = mutation.apply(currentConfig);

    console.log(`\n🔬 Experiment ${exp}: ${mutation.description}`);

    const result = await runEval(candidateConfig);
    const passRate = result.passRate;
    let status: string;

    if (result.passed > bestPassed) {
      status = 'keep';
      bestPassRate = passRate;
      bestPassed = result.passed;
      currentConfig = { ...candidateConfig };
      console.log(`   ✅ KEEP — ${result.passed}/${result.total} (${(passRate * 100).toFixed(1)}%) — IMPROVED`);
    } else if (result.passed === bestPassed && result.avgTopScore > baseline.avgTopScore) {
      status = 'keep';
      currentConfig = { ...candidateConfig };
      console.log(`   ✅ KEEP — ${result.passed}/${result.total} (${(passRate * 100).toFixed(1)}%) — same pass rate, better scores`);
    } else {
      status = 'discard';
      console.log(`   ❌ DISCARD — ${result.passed}/${result.total} (${(passRate * 100).toFixed(1)}%)`);
    }

    if (result.failures.length > 0 && result.failures.length <= 3) {
      for (const f of result.failures) {
        console.log(`      ❌ ${f.scenario} — missing: ${f.missed.join(', ')}`);
      }
    }

    fs.appendFileSync(resultsPath, `${exp}\t${(passRate * 100).toFixed(1)}%\t${result.passed}\t${result.total}\t${result.avgTopScore.toFixed(3)}\t${status}\tminScore=${candidateConfig.minScore},maxResults=${candidateConfig.maxResults}\t${mutation.description}\n`);
    fs.appendFileSync(changelogPath, `## Experiment ${exp} — ${status}\n**Pass rate:** ${result.passed}/${result.total} (${(passRate * 100).toFixed(1)}%)\n**Change:** ${mutation.description}\n**Config:** minScore=${candidateConfig.minScore}, maxResults=${candidateConfig.maxResults}\n**Avg top score:** ${result.avgTopScore.toFixed(3)}\n\n`);

    if (bestPassed === recallScenarios.length) {
      console.log('\n🏆 Perfect recall — all scenarios pass.');
      break;
    }
  }

  console.log('\n\n=== AUTORESEARCH COMPLETE ===\n');
  console.log(`Baseline: ${baseline.passed}/${baseline.total} (${(baseline.passRate * 100).toFixed(1)}%)`);
  console.log(`Best:     ${bestPassed}/${baseline.total} (${(bestPassRate * 100).toFixed(1)}%)`);
  console.log(`\nOptimal config:`);
  console.log(`  minScore = ${currentConfig.minScore}`);
  console.log(`  maxResults = ${currentConfig.maxResults}`);

  if (bestPassed > baseline.passed) {
    console.log(`\n🔧 To apply, update these defaults:`);
    console.log(`   - src/memory/contextual-recall.service.ts: minScore default → ${currentConfig.minScore}`);
    console.log(`   - src/memory/contextual-recall.service.ts: maxResults default → ${currentConfig.maxResults}`);
  }

  // Server-side recommendations (can't test from client)
  console.log(`\n📋 Server-side parameters to test (require service restart):`);
  console.log(`   - TOPIC_SHIFT_THRESHOLD (default 0.4): try 0.35 and 0.45`);
  console.log(`   - USAGE_RECENCY_HALFLIFE_DAYS (default 14): try 7 and 21`);
  console.log(`   - Usage weight (default 0.15): try 0.10 and 0.20`);
  console.log(`   These need autoresearch run on the server directly.`);

  console.log(`\nResults: ${resultsPath}`);
  console.log(`Changelog: ${changelogPath}`);
}

main().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
