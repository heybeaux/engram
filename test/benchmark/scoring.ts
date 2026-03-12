/**
 * Benchmark scoring utilities.
 *
 * Calculates precision@5, recall@20, MRR, and isolation scores
 * for recall benchmark queries.
 */

import type { GoldQuery } from '../fixtures/types';

export interface QueryScore {
  queryId: string;
  category: string;
  passed: boolean;
  /** How many must_top5 items appeared in actual top 5 */
  precisionAt5: number;
  /** How many should_top20 items appeared in actual top 20 */
  recallAt20: number;
  /** Mean reciprocal rank for must_top5 items */
  mrr: number;
  /** True if no must_absent items appeared */
  isolationPassed: boolean;
  /** Details for debugging failures */
  details: {
    query: string;
    user: string;
    expectedTop5: string[];
    expectedTop20: string[];
    actualIds: string[];
    mustAbsentViolations: string[];
    top5Hits: string[];
    top20Hits: string[];
  };
}

export interface CategoryScore {
  category: string;
  queryCount: number;
  passed: number;
  failed: number;
  avgPrecisionAt5: number;
  avgRecallAt20: number;
  avgMrr: number;
  isolationScore: number;
}

export interface BenchmarkReport {
  timestamp: string;
  gitSha: string;
  branch: string;
  totalQueries: number;
  passedQueries: number;
  failedQueries: number;
  overallPrecisionAt5: number;
  overallRecallAt20: number;
  overallMrr: number;
  overallIsolationScore: number;
  categoryScores: CategoryScore[];
  queryScores: QueryScore[];
  failedQueryDetails: QueryScore[];
  thresholdsPassed: boolean;
}

/**
 * Score a single query's results against its gold expectations.
 */
export function scoreQuery(
  query: GoldQuery,
  resultIds: string[],
): QueryScore {
  const top5 = resultIds.slice(0, 5);
  const top20 = resultIds.slice(0, 20);

  // Precision@5: fraction of must_top5 items found in top 5
  const top5Hits = query.must_top5.filter((id) => top5.includes(id));
  const precisionAt5 =
    query.must_top5.length > 0
      ? top5Hits.length / query.must_top5.length
      : 1.0;

  // Recall@20: fraction of should_top20 items found in top 20
  const shouldTop20 = query.should_top20 ?? [];
  const top20Hits = shouldTop20.filter((id) => top20.includes(id));
  const recallAt20 =
    shouldTop20.length > 0 ? top20Hits.length / shouldTop20.length : 1.0;

  // MRR: mean reciprocal rank for must_top5 items
  let mrr = 0;
  if (query.must_top5.length > 0) {
    const reciprocalRanks = query.must_top5.map((id) => {
      const rank = resultIds.indexOf(id);
      return rank >= 0 ? 1 / (rank + 1) : 0;
    });
    mrr =
      reciprocalRanks.reduce((sum, rr) => sum + rr, 0) /
      query.must_top5.length;
  } else {
    mrr = 1.0; // no must_top5 = perfect by default
  }

  // Isolation: any must_absent item in results is a hard fail
  const mustAbsentViolations = query.must_absent.filter((id) =>
    resultIds.includes(id),
  );
  const isolationPassed = mustAbsentViolations.length === 0;

  // Overall pass: isolation + at least some hits if expected
  const passed =
    isolationPassed &&
    (query.must_top5.length === 0 || top5Hits.length > 0);

  return {
    queryId: query.id,
    category: query.category,
    passed,
    precisionAt5,
    recallAt20,
    mrr,
    isolationPassed,
    details: {
      query: query.query,
      user: query.user,
      expectedTop5: query.must_top5,
      expectedTop20: shouldTop20,
      actualIds: resultIds.slice(0, 20),
      mustAbsentViolations,
      top5Hits,
      top20Hits,
    },
  };
}

/**
 * Aggregate scores by category.
 */
export function aggregateByCategory(
  scores: QueryScore[],
): CategoryScore[] {
  const categories = new Map<string, QueryScore[]>();
  for (const score of scores) {
    const list = categories.get(score.category) ?? [];
    list.push(score);
    categories.set(score.category, list);
  }

  const result: CategoryScore[] = [];
  for (const [category, catScores] of categories) {
    const passed = catScores.filter((s) => s.passed).length;
    result.push({
      category,
      queryCount: catScores.length,
      passed,
      failed: catScores.length - passed,
      avgPrecisionAt5: avg(catScores.map((s) => s.precisionAt5)),
      avgRecallAt20: avg(catScores.map((s) => s.recallAt20)),
      avgMrr: avg(catScores.map((s) => s.mrr)),
      isolationScore:
        catScores.filter((s) => s.isolationPassed).length / catScores.length,
    });
  }

  return result.sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * Build the full benchmark report.
 */
export function buildReport(
  scores: QueryScore[],
  gitSha: string,
  branch: string,
): BenchmarkReport {
  const categoryScores = aggregateByCategory(scores);
  const failedQueryDetails = scores.filter((s) => !s.passed);

  return {
    timestamp: new Date().toISOString(),
    gitSha,
    branch,
    totalQueries: scores.length,
    passedQueries: scores.filter((s) => s.passed).length,
    failedQueries: failedQueryDetails.length,
    overallPrecisionAt5: avg(scores.map((s) => s.precisionAt5)),
    overallRecallAt20: avg(scores.map((s) => s.recallAt20)),
    overallMrr: avg(scores.map((s) => s.mrr)),
    overallIsolationScore:
      scores.filter((s) => s.isolationPassed).length / scores.length,
    categoryScores,
    queryScores: scores,
    failedQueryDetails,
    thresholdsPassed: checkThresholds(scores),
  };
}

/**
 * Check if all thresholds pass.
 */
export function checkThresholds(scores: QueryScore[]): boolean {
  const isolationScore =
    scores.filter((s) => s.isolationPassed).length / scores.length;
  const precisionAt5 = avg(scores.map((s) => s.precisionAt5));

  // Any must_top5 query with 0 hits?
  const zeroHitQueries = scores.filter(
    (s) => s.details.expectedTop5.length > 0 && s.details.top5Hits.length === 0,
  );

  // Zero-hit queries are tracked as warnings — P@5 threshold is the hard gate.
  if (zeroHitQueries.length > 0) {
    console.warn(
      `⚠️  ${zeroHitQueries.length} zero-hit queries (tracked, not blocking): ${zeroHitQueries.map((q) => q.queryId).join(', ')}`,
    );
  }

  return (
    isolationScore >= 1.0 && // Zero tolerance for isolation failures
    precisionAt5 >= 0.7 // At least 70% precision
  );
}

/**
 * Format the report for console output.
 */
export function formatReport(report: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║              ENGRAM RECALL BENCHMARK REPORT                 ║');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`  Git SHA:    ${report.gitSha}`);
  lines.push(`  Branch:     ${report.branch}`);
  lines.push(`  Timestamp:  ${report.timestamp}`);
  lines.push('');

  // Overall scores
  lines.push('┌─────────────────────────────────────────────────────────────┐');
  lines.push('│  OVERALL SCORES                                            │');
  lines.push('├─────────────────────────────────────────────────────────────┤');
  lines.push(
    `│  Total Queries:   ${report.totalQueries}                                         │`.slice(
      0,
      62,
    ) + '│',
  );
  lines.push(
    `│  Passed:          ${report.passedQueries} / ${report.totalQueries} (${pct(report.passedQueries / report.totalQueries)})` +
      ' '.repeat(40),
  );
  lines.push(
    `│  Precision@5:     ${pct(report.overallPrecisionAt5)}  ${report.overallPrecisionAt5 >= 0.7 ? '✅' : '❌'}  (threshold: 70%)`,
  );
  lines.push(`│  Recall@20:       ${pct(report.overallRecallAt20)}`);
  lines.push(`│  MRR:             ${report.overallMrr.toFixed(4)}`);
  lines.push(
    `│  Isolation:       ${pct(report.overallIsolationScore)}  ${report.overallIsolationScore >= 1.0 ? '✅' : '❌'}  (threshold: 100%)`,
  );
  lines.push('└─────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Category breakdown
  lines.push(
    '┌──────────────────┬───────┬────────┬──────────┬──────────┬──────────┬───────────┐',
  );
  lines.push(
    '│ Category         │ Total │ Passed │ Prec@5   │ Rec@20   │ MRR      │ Isolation │',
  );
  lines.push(
    '├──────────────────┼───────┼────────┼──────────┼──────────┼──────────┼───────────┤',
  );
  for (const cat of report.categoryScores) {
    lines.push(
      `│ ${pad(cat.category, 16)} │ ${pad(String(cat.queryCount), 5)} │ ${pad(String(cat.passed), 6)} │ ${pad(pct(cat.avgPrecisionAt5), 8)} │ ${pad(pct(cat.avgRecallAt20), 8)} │ ${pad(cat.avgMrr.toFixed(4), 8)} │ ${pad(pct(cat.isolationScore), 9)} │`,
    );
  }
  lines.push(
    '└──────────────────┴───────┴────────┴──────────┴──────────┴──────────┴───────────┘',
  );
  lines.push('');

  // Failed queries
  if (report.failedQueryDetails.length > 0) {
    lines.push(`❌ FAILED QUERIES (${report.failedQueryDetails.length}):`);
    lines.push('');
    for (const q of report.failedQueryDetails) {
      lines.push(`  [${q.queryId}] "${q.details.query}" (user: ${q.details.user})`);
      if (!q.isolationPassed) {
        lines.push(
          `    ⛔ ISOLATION FAILURE: ${q.details.mustAbsentViolations.join(', ')}`,
        );
      }
      if (
        q.details.expectedTop5.length > 0 &&
        q.details.top5Hits.length === 0
      ) {
        lines.push(
          `    ⚠️  ZERO HITS: expected ${q.details.expectedTop5.join(', ')} in top 5`,
        );
      }
      if (q.precisionAt5 < 1.0 && q.details.expectedTop5.length > 0) {
        lines.push(
          `    📊 Precision@5: ${pct(q.precisionAt5)} — hit: [${q.details.top5Hits.join(', ')}], missed: [${q.details.expectedTop5.filter((id) => !q.details.top5Hits.includes(id)).join(', ')}]`,
        );
      }
      lines.push(`    📋 Actual top 5: [${q.details.actualIds.slice(0, 5).join(', ')}]`);
      lines.push('');
    }
  }

  // Final verdict
  lines.push('');
  if (report.thresholdsPassed) {
    lines.push('✅ ALL THRESHOLDS PASSED');
  } else {
    lines.push('❌ THRESHOLDS NOT MET — benchmark FAILED');
  }
  lines.push('');

  return lines.join('\n');
}

// ── Helpers ─────────────────────────────────────────────────────

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pad(str: string, len: number): string {
  return str.padEnd(len);
}
