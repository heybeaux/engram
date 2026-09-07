/** Label coverage is not precision: the fixture lists required items, not exhaustive relevance judgments. */
import type { GoldQuery } from '../fixtures/types';

// Retain the original quality bar; exclude unlabelled cases instead of awarding them 1.
export const REQUIRED_COVERAGE_AT_5_THRESHOLD = 0.95;
export interface QueryScore {
  queryId: string;
  category: string;
  passed: boolean;
  requiredCoverageAt5: number | null;
  expectedCoverageAt20: number | null;
  /** Reciprocal rank of the FIRST required item, not the mean over required items. */
  mrr: number | null;
  noAnswerPassed: boolean | null;
  isolationPassed: boolean;
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
  labelledTop5Count: number;
  labelledTop20Count: number;
  noAnswerCount: number;
  unlabelledCount: number;
  passed: number;
  failed: number;
  avgRequiredCoverageAt5: number | null;
  avgExpectedCoverageAt20: number | null;
  avgMrr: number | null;
  isolationScore: number;
}
export interface BenchmarkReport {
  metricVersion: 2;
  timestamp: string;
  gitSha: string;
  branch: string;
  totalQueries: number;
  labelledTop5Count: number;
  labelledTop20Count: number;
  noAnswerCount: number;
  unlabelledCount: number;
  passedQueries: number;
  failedQueries: number;
  overallRequiredCoverageAt5: number | null;
  overallExpectedCoverageAt20: number | null;
  overallMrr: number | null;
  overallIsolationScore: number;
  categoryScores: CategoryScore[];
  queryScores: QueryScore[];
  failedQueryDetails: QueryScore[];
  thresholdsPassed: boolean;
}
export function scoreQuery(query: GoldQuery, resultIds: string[]): QueryScore {
  if (
    query.expect_no_answer &&
    (query.must_top5.length || query.should_top20?.length)
  ) {
    throw new Error(`Contradictory no-answer labels: ${query.id}`);
  }
  const top5 = resultIds.slice(0, 5);
  const top20 = resultIds.slice(0, 20);
  const expectedTop5 = [...new Set(query.must_top5)];
  const expectedTop20 = [...new Set(query.should_top20 ?? [])];
  const top5Hits = expectedTop5.filter((id) => top5.includes(id));
  const top20Hits = expectedTop20.filter((id) => top20.includes(id));
  const firstRank = resultIds.findIndex((id) => expectedTop5.includes(id));
  const mustAbsentViolations = query.must_absent.filter((id) =>
    resultIds.includes(id),
  );
  const isolationPassed = mustAbsentViolations.length === 0;
  const noAnswerPassed = query.expect_no_answer ? resultIds.length === 0 : null;
  return {
    queryId: query.id,
    category: query.category,
    passed:
      isolationPassed &&
      noAnswerPassed !== false &&
      (!expectedTop5.length || top5Hits.length > 0),
    requiredCoverageAt5: expectedTop5.length
      ? top5Hits.length / expectedTop5.length
      : null,
    expectedCoverageAt20: expectedTop20.length
      ? top20Hits.length / expectedTop20.length
      : null,
    mrr: expectedTop5.length ? (firstRank < 0 ? 0 : 1 / (firstRank + 1)) : null,
    noAnswerPassed,
    isolationPassed,
    details: {
      query: query.query,
      user: query.user,
      expectedTop5,
      expectedTop20,
      actualIds: top20,
      mustAbsentViolations,
      top5Hits,
      top20Hits,
    },
  };
}
export function averageLabelled(values: (number | null)[]): number | null {
  const labelled = values.filter((v): v is number => v !== null);
  return labelled.length
    ? labelled.reduce((s, v) => s + v, 0) / labelled.length
    : null;
}
function counts(scores: QueryScore[]) {
  return {
    labelledTop5Count: scores.filter((s) => s.requiredCoverageAt5 !== null)
      .length,
    labelledTop20Count: scores.filter((s) => s.expectedCoverageAt20 !== null)
      .length,
    noAnswerCount: scores.filter((s) => s.noAnswerPassed !== null).length,
    unlabelledCount: scores.filter(
      (s) =>
        s.requiredCoverageAt5 === null &&
        s.expectedCoverageAt20 === null &&
        s.noAnswerPassed === null,
    ).length,
  };
}
export function aggregateByCategory(scores: QueryScore[]): CategoryScore[] {
  return [...new Set(scores.map((s) => s.category))].sort().map((category) => {
    const group = scores.filter((s) => s.category === category);
    const passed = group.filter((s) => s.passed).length;
    return {
      category,
      queryCount: group.length,
      ...counts(group),
      passed,
      failed: group.length - passed,
      avgRequiredCoverageAt5: averageLabelled(
        group.map((s) => s.requiredCoverageAt5),
      ),
      avgExpectedCoverageAt20: averageLabelled(
        group.map((s) => s.expectedCoverageAt20),
      ),
      avgMrr: averageLabelled(group.map((s) => s.mrr)),
      isolationScore:
        group.filter((s) => s.isolationPassed).length / group.length,
    };
  });
}
export function checkThresholds(scores: QueryScore[]): boolean {
  const coverage = averageLabelled(scores.map((s) => s.requiredCoverageAt5));
  return (
    scores.length > 0 &&
    coverage !== null &&
    coverage >= REQUIRED_COVERAGE_AT_5_THRESHOLD &&
    scores.every((s) => s.isolationPassed && s.noAnswerPassed !== false)
  );
}
export function buildReport(
  scores: QueryScore[],
  gitSha: string,
  branch: string,
): BenchmarkReport {
  return {
    metricVersion: 2,
    timestamp: new Date().toISOString(),
    gitSha,
    branch,
    totalQueries: scores.length,
    ...counts(scores),
    passedQueries: scores.filter((s) => s.passed).length,
    failedQueries: scores.filter((s) => !s.passed).length,
    overallRequiredCoverageAt5: averageLabelled(
      scores.map((s) => s.requiredCoverageAt5),
    ),
    overallExpectedCoverageAt20: averageLabelled(
      scores.map((s) => s.expectedCoverageAt20),
    ),
    overallMrr: averageLabelled(scores.map((s) => s.mrr)),
    overallIsolationScore: scores.length
      ? scores.filter((s) => s.isolationPassed).length / scores.length
      : 0,
    categoryScores: aggregateByCategory(scores),
    queryScores: scores,
    failedQueryDetails: scores.filter((s) => !s.passed),
    thresholdsPassed: checkThresholds(scores),
  };
}
export function formatReport(report: BenchmarkReport): string {
  const pct = (n: number | null) =>
    n === null ? 'N/A (no labels)' : `${(100 * n).toFixed(2)}%`;
  return [
    `Engram recall benchmark (metric version ${report.metricVersion})`,
    `${report.gitSha} (${report.branch}) at ${report.timestamp}`,
    `Queries: ${report.totalQueries}; case assertions passed: ${report.passedQueries}`,
    `Required-item coverage@5: ${pct(report.overallRequiredCoverageAt5)} (${report.labelledTop5Count} labelled; gate 95%)`,
    `Expected-item coverage@20: ${pct(report.overallExpectedCoverageAt20)} (${report.labelledTop20Count} labelled)`,
    `MRR of first required hit: ${report.overallMrr?.toFixed(4) ?? 'N/A'}`,
    `Explicit no-answer cases: ${report.noAnswerCount}; unlabelled relevance cases: ${report.unlabelledCount}`,
    `Forbidden-ID isolation checks: ${pct(report.overallIsolationScore)}`,
    'These partial labels do not measure precision or exhaustive recall. Unlabelled cases contribute only forbidden-ID checks.',
    ...report.categoryScores.map(
      (c) =>
        `${c.category}: coverage@5 ${pct(c.avgRequiredCoverageAt5)} (n=${c.labelledTop5Count}), coverage@20 ${pct(c.avgExpectedCoverageAt20)} (n=${c.labelledTop20Count})`,
    ),
    ...report.failedQueryDetails.map(
      (q) =>
        `FAIL ${q.queryId}: expected [${q.details.expectedTop5.join(', ')}], returned [${q.details.actualIds.slice(0, 5).join(', ')}], forbidden [${q.details.mustAbsentViolations.join(', ')}], no-answer=${q.noAnswerPassed}`,
    ),
    report.thresholdsPassed
      ? 'Quality thresholds passed'
      : 'Quality thresholds FAILED',
  ].join('\n');
}
