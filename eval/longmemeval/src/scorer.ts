/**
 * Aggregate scoring for the LongMemEval eval harness.
 *
 * Combines per-question judge results into summary metrics:
 *  - Overall accuracy
 *  - Per-category breakdown
 *  - Temporal-reasoning-ability category (hardest, ~7-11 pt range per paper)
 */

import * as fs from 'fs';
import type { QuestionResult, CategoryScore, SummaryReport, LmeCategory } from './types';

/**
 * Load per-question results from a JSONL file (one QuestionResult per line).
 * Returns an empty array if the file doesn't exist.
 * Blank lines are skipped; malformed lines throw with the line number for fast failure.
 */
export function loadResultsFromJsonl(jsonlPath: string): QuestionResult[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n');
  const results: QuestionResult[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      results.push(JSON.parse(line) as QuestionResult);
    } catch (err) {
      throw new Error(
        `Malformed JSONL at ${jsonlPath}:${i + 1}: ${(err as Error).message}`,
      );
    }
  }
  return results;
}

/**
 * Build the full SummaryReport from per-question results.
 */
export function buildSummary(
  results: QuestionResult[],
  subset: string,
): SummaryReport {
  const correctCount = results.filter(r => r.correct).length;
  const accuracy = results.length > 0 ? correctCount / results.length : 0;

  const byCategory = computeByCategory(results);

  return {
    runAt: new Date().toISOString(),
    subset,
    totalQuestions: results.length,
    correctCount,
    accuracy,
    byCategory,
    questions: results,
  };
}

/**
 * Compute per-category accuracy breakdown.
 */
export function computeByCategory(results: QuestionResult[]): Record<string, CategoryScore> {
  const buckets = new Map<string, { total: number; correct: number }>();

  for (const r of results) {
    const cat = r.category as string;
    if (!buckets.has(cat)) {
      buckets.set(cat, { total: 0, correct: 0 });
    }
    const bucket = buckets.get(cat)!;
    bucket.total++;
    if (r.correct) bucket.correct++;
  }

  const out: Record<string, CategoryScore> = {};
  for (const [cat, { total, correct }] of buckets.entries()) {
    out[cat] = {
      total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
    };
  }
  return out;
}

/**
 * Format a summary as a human-readable string for CLI output.
 */
export function formatSummary(report: SummaryReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('LongMemEval Results');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`  Subset:    ${report.subset}`);
  lines.push(`  Questions: ${report.totalQuestions}`);
  lines.push(`  Correct:   ${report.correctCount}`);
  lines.push(`  Accuracy:  ${(report.accuracy * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('  By Category:');

  const categories = Object.entries(report.byCategory).sort(([a], [b]) => a.localeCompare(b));
  for (const [cat, score] of categories) {
    const pct = (score.accuracy * 100).toFixed(1);
    lines.push(`    ${cat.padEnd(35)} ${score.correct}/${score.total} (${pct}%)`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

/**
 * Check whether a summary meets minimum passing thresholds.
 * Returns a list of failing checks (empty = all pass).
 */
export function checkThresholds(report: SummaryReport): string[] {
  const failures: string[] = [];

  if (report.totalQuestions === 0) {
    failures.push('No questions were evaluated.');
  }

  // LongMemEval baseline from the paper: ~65-70% for naive retrieval
  // We don't gate CI on accuracy thresholds in Phase 1 — just report.

  return failures;
}
