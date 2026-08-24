#!/usr/bin/env node
/**
 * Summarise retrieval-probe artifacts into a comparison table.
 *
 * gold@1 / @5 / @10 are counts of tasks whose gold memory landed in the
 * limit=10 page at that depth. MRR@10 is the mean of 1/(rank+1) over all tasks,
 * counting 0 for tasks where gold never appears in the page — so it is
 * comparable across arms with different miss rates.
 *
 * poolMedian is the gold's median rank in the deep (limit=250) recall for that
 * arm: the ordering the page *could* have delivered.
 *
 * Usage: node scripts/research/score-arms.mjs <probe.json> [...]
 */
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('usage: score-arms.mjs <probe.json> [...]\n');
  process.exit(2);
}

function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const rows = [];
for (const f of files) {
  const { summary, rows: tasks } = JSON.parse(readFileSync(f, 'utf8'));
  const n = tasks.length;
  const at = (k) => tasks.filter((t) => t.rankInPage >= 0 && t.rankInPage < k).length;
  const mrr =
    tasks.reduce((a, t) => a + (t.rankInPage >= 0 ? 1 / (t.rankInPage + 1) : 0), 0) / n;
  rows.push({
    arm: summary.label,
    n,
    'gold@1': at(1),
    'gold@5': at(5),
    'gold@10': at(10),
    'MRR@10': Number(mrr.toFixed(4)),
    poolMedian: median(tasks.map((t) => t.rankInPool)),
    poolTop5: tasks.filter((t) => t.rankInPool >= 0 && t.rankInPool < 5).length,
    inPool: tasks.filter((t) => t.rankInPool >= 0).length,
  });
}

console.table(rows);
