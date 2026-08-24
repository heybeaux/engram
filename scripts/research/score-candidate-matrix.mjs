#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write(
    'usage: score-candidate-matrix.mjs <probe.json> [...]\n',
  );
  process.exit(2);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

const artifacts = files.map((file) => ({
  file,
  ...JSON.parse(readFileSync(file, 'utf8')),
}));

const rows = artifacts.map(({ file, summary, rows: tasks }) => {
  const n = tasks.length;
  const at = (k) =>
    tasks.filter((task) => task.rankInPage >= 0 && task.rankInPage < k).length;
  const mrr =
    tasks.reduce(
      (sum, task) =>
        sum + (task.rankInPage >= 0 ? 1 / (task.rankInPage + 1) : 0),
      0,
    ) / n;
  const latencies = tasks
    .map((task) => task.pageLatencyMs)
    .filter(Number.isFinite);
  return {
    artifact: file,
    arm: summary.label,
    n,
    goldAt1: at(1),
    goldAt5: at(5),
    goldAt10: at(10),
    mrrAt10: Number(mrr.toFixed(4)),
    pageSizes: [...new Set(tasks.map((task) => task.pageSize))].join(','),
    poolSizes: [...new Set(tasks.map((task) => task.poolSize))].join(','),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
  };
});

console.table(rows);

const byLogicalArm = new Map();
for (const artifact of artifacts) {
  const logical = artifact.summary.label.replace(/-r[0-9]+$/, '');
  const prior = byLogicalArm.get(logical);
  const signature = artifact.rows.map((task) =>
    task.top.map((hit) => hit.id).join(','),
  );
  if (!prior) {
    byLogicalArm.set(logical, signature);
    continue;
  }
  let changedQueries = 0;
  for (let i = 0; i < signature.length; i++) {
    if (signature[i] !== prior[i]) changedQueries++;
  }
  process.stdout.write(
    `${logical} stability: ${changedQueries}/20 repeated-query rankings changed\n`,
  );
}

const formerMisses = new Set([
  'paginated-list-endpoint',
  'webhook-processor',
  'inventory-reservation',
  'currency-conversion',
  'tenant-scoped-projects',
  'order-dto-mapping',
]);
for (const artifact of artifacts.filter((item) =>
  /-r1$/.test(item.summary.label),
)) {
  process.stdout.write(
    `\n${artifact.summary.label} former-miss ranks (0-based):\n`,
  );
  for (const task of artifact.rows.filter((item) =>
    formerMisses.has(item.task),
  )) {
    process.stdout.write(
      `  ${task.task}: page=${task.rankInPage} pool=${task.rankInPool} poolSize=${task.poolSize}\n`,
    );
  }
}
