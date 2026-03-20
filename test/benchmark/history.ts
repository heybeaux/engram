/**
 * Benchmark History Tracking
 *
 * Saves benchmark results as timestamped JSON files and supports
 * comparing current vs previous runs for regression detection.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { BenchmarkReport } from './scoring';

const RESULTS_DIR = join(__dirname, 'results');

/**
 * Save a benchmark report to the results directory.
 */
export function saveReport(report: BenchmarkReport): string {
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `benchmark-${ts}.json`;
  const filepath = join(RESULTS_DIR, filename);

  writeFileSync(filepath, JSON.stringify(report, null, 2));
  return filepath;
}

/**
 * Load the most recent benchmark report.
 */
export function loadLatestReport(): BenchmarkReport | null {
  if (!existsSync(RESULTS_DIR)) return null;

  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith('benchmark-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  const content = readFileSync(join(RESULTS_DIR, files[0]), 'utf-8');
  return JSON.parse(content) as BenchmarkReport;
}

/**
 * Load the second-most-recent report (for comparison).
 */
export function loadPreviousReport(): BenchmarkReport | null {
  if (!existsSync(RESULTS_DIR)) return null;

  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith('benchmark-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length < 2) return null;

  const content = readFileSync(join(RESULTS_DIR, files[1]), 'utf-8');
  return JSON.parse(content) as BenchmarkReport;
}

/**
 * Compare two reports and return a human-readable diff.
 */
export function compareReports(
  current: BenchmarkReport,
  previous: BenchmarkReport,
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('═══ BENCHMARK COMPARISON ═══');
  lines.push('');
  lines.push(
    `  Previous: ${previous.gitSha} (${previous.branch}) @ ${previous.timestamp}`,
  );
  lines.push(
    `  Current:  ${current.gitSha} (${current.branch}) @ ${current.timestamp}`,
  );
  lines.push('');

  const metrics: Array<{
    name: string;
    prev: number;
    curr: number;
    higherBetter: boolean;
  }> = [
    {
      name: 'Precision@5',
      prev: previous.overallPrecisionAt5,
      curr: current.overallPrecisionAt5,
      higherBetter: true,
    },
    {
      name: 'Recall@20',
      prev: previous.overallRecallAt20,
      curr: current.overallRecallAt20,
      higherBetter: true,
    },
    {
      name: 'MRR',
      prev: previous.overallMrr,
      curr: current.overallMrr,
      higherBetter: true,
    },
    {
      name: 'Isolation',
      prev: previous.overallIsolationScore,
      curr: current.overallIsolationScore,
      higherBetter: true,
    },
    {
      name: 'Pass Rate',
      prev: previous.passedQueries / previous.totalQueries,
      curr: current.passedQueries / current.totalQueries,
      higherBetter: true,
    },
  ];

  lines.push('  ┌─────────────────┬──────────┬──────────┬──────────┐');
  lines.push('  │ Metric          │ Previous │ Current  │ Delta    │');
  lines.push('  ├─────────────────┼──────────┼──────────┼──────────┤');

  for (const m of metrics) {
    const delta = m.curr - m.prev;
    const deltaStr =
      delta >= 0
        ? `+${(delta * 100).toFixed(1)}%`
        : `${(delta * 100).toFixed(1)}%`;
    const emoji =
      Math.abs(delta) < 0.001
        ? '  '
        : delta > 0
          ? m.higherBetter
            ? '📈'
            : '📉'
          : m.higherBetter
            ? '📉'
            : '📈';

    lines.push(
      `  │ ${m.name.padEnd(15)} │ ${(m.prev * 100).toFixed(1).padStart(6)}%  │ ${(m.curr * 100).toFixed(1).padStart(6)}%  │ ${emoji} ${deltaStr.padStart(6)} │`,
    );
  }

  lines.push('  └─────────────────┴──────────┴──────────┴──────────┘');
  lines.push('');

  // Regressions: queries that newly failed
  const prevFailedIds = new Set(
    previous.failedQueryDetails.map((q) => q.queryId),
  );
  const newFailures = current.failedQueryDetails.filter(
    (q) => !prevFailedIds.has(q.queryId),
  );
  const fixes = previous.failedQueryDetails.filter(
    (q) => !current.failedQueryDetails.some((c) => c.queryId === q.queryId),
  );

  if (newFailures.length > 0) {
    lines.push(`  ⚠️  NEW REGRESSIONS (${newFailures.length}):`);
    for (const q of newFailures) {
      lines.push(`    - [${q.queryId}] "${q.details.query}"`);
    }
    lines.push('');
  }

  if (fixes.length > 0) {
    lines.push(`  ✅ FIXED (${fixes.length}):`);
    for (const q of fixes) {
      lines.push(`    - [${q.queryId}] "${q.details.query}"`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get git info for the current commit.
 */
export function getGitInfo(): { sha: string; branch: string } {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
    }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    return { sha, branch };
  } catch {
    return { sha: 'unknown', branch: 'unknown' };
  }
}
