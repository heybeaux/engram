#!/usr/bin/env node
/**
 * Live check of the limit-monotonicity property against a running Engram.
 *
 * Property: for the same candidate pool, the top-K page of a `limit=K` query
 * must be the prefix of the top-K of a `limit=N` query (N > K).
 *
 * Two comparisons are reported, because the recall path has TWO sources of
 * limit-dependence and only one of them is the ranking defect:
 *
 *   5 vs 10   — `candidateLimit = max(200, limit*20)` is 200 for both, so the
 *               candidate pool is identical. Any violation here is pure
 *               ranking policy. This is the property the fix targets.
 *   10 vs 250 — the deep call widens the vector pool (200 → up to 5000), so a
 *               violation here can also be caused by candidates the shallow
 *               call never saw. Reported for information.
 *
 * Usage: PROBE_API_KEY=... node scripts/research/check-limit-monotonicity.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MNEMON = process.env.PROBE_MNEMON ?? '/Users/beauxwalton/projects/mnemon';
const BASE = (process.env.PROBE_BASE_URL ?? 'http://127.0.0.1:3007').replace(/\/+$/, '');
const KEY = process.env.PROBE_API_KEY;
const USER = process.env.PROBE_USER_ID ?? 'mnemon-v02-noise-prefix';
const TASKS = process.env.PROBE_TASKS_DIR ?? join(MNEMON, '.mnemon/noisy-tasks-prefix');

if (!KEY) {
  process.stderr.write('PROBE_API_KEY is required\n');
  process.exit(2);
}

const label = process.argv[2] ?? 'unlabelled';

async function recall(query, limit) {
  const res = await fetch(`${BASE}/v1/memories/query?scope=user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AM-API-Key': KEY,
      'X-AM-User-ID': USER,
    },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) throw new Error(`recall ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).memories ?? [];
}

const queries = readdirSync(TASKS)
  .filter((f) => /^\d\d-.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(TASKS, f), 'utf8')));

let samePoolViolations = 0;
let widePoolViolations = 0;

for (const t of queries) {
  // NOTE: recall increments retrieval_count, which feeds usage weighting. Issue
  // the WIDER call first so the narrow page is not scored against counters the
  // wide call just moved.
  const deep = (await recall(t.query, 250)).map((m) => m.id);
  const ten = (await recall(t.query, 10)).map((m) => m.id);
  const five = (await recall(t.query, 5)).map((m) => m.id);

  const samePool = five.join() === ten.slice(0, five.length).join();
  const widePool = ten.join() === deep.slice(0, ten.length).join();
  if (!samePool) {
    samePoolViolations++;
    process.stdout.write(`  VIOLATION (5 vs 10) ${t.id}\n    5:  ${five.join(' ')}\n    10: ${ten.slice(0, 5).join(' ')}\n`);
  }
  if (!widePool) widePoolViolations++;
}

process.stdout.write(
  `\n[${label}] limit-monotonicity over ${queries.length} queries\n` +
    `  same pool  (5 vs 10):   ${queries.length - samePoolViolations}/${queries.length} hold\n` +
    `  wider pool (10 vs 250): ${queries.length - widePoolViolations}/${queries.length} hold\n`,
);

process.exit(samePoolViolations === 0 ? 0 : 1);
