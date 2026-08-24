#!/usr/bin/env node
/**
 * Retrieval-only probe for the noisy mnemon corpus.
 *
 * Replays the 20 task queries against a running Engram instance and reports,
 * per query: the top-N with scores, the score band each hit fell into, and
 * where the gold ("allowed") memory actually ranked.
 *
 * NO LLM. NO generation. NO writes to Engram. Pure recall measurement.
 *
 * Usage:
 *   node scripts/research/retrieval-probe.mjs [--limit 10] [--label before]
 *
 * Env:
 *   PROBE_BASE_URL   default http://127.0.0.1:3007
 *   PROBE_API_KEY    required
 *   PROBE_USER_ID    default mnemon-v02-noise-prefix
 *   PROBE_TASKS_DIR  default <mnemon>/.mnemon/noisy-tasks-prefix
 *   PROBE_RECEIPT    default <mnemon>/.mnemon/noisy-corpus-receipt-prefix.json
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const MNEMON = process.env.PROBE_MNEMON ?? '/Users/beauxwalton/projects/mnemon';
const BASE = (process.env.PROBE_BASE_URL ?? 'http://127.0.0.1:3007').replace(
  /\/+$/,
  '',
);
const KEY = process.env.PROBE_API_KEY;
const USER = process.env.PROBE_USER_ID ?? 'mnemon-v02-noise-prefix';
const TASKS =
  process.env.PROBE_TASKS_DIR ?? join(MNEMON, '.mnemon/noisy-tasks-prefix');
const RECEIPT =
  process.env.PROBE_RECEIPT ??
  join(MNEMON, '.mnemon/noisy-corpus-receipt-prefix.json');
const RESET_DB = process.env.PROBE_RESET_DB_URL;

if (!KEY) {
  process.stderr.write('PROBE_API_KEY is required\n');
  process.exit(2);
}

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const LIMIT = Number(arg('limit', '10'));
const LABEL = arg('label', 'probe');
const OUT = arg('out', null);
const EXTRA_HEADERS = {};
const flagHeader = arg('header', null); // e.g. --header 'X-Engram-Rescue-Mode: relative'
if (flagHeader) {
  const idx = flagHeader.indexOf(':');
  EXTRA_HEADERS[flagHeader.slice(0, idx).trim()] = flagHeader
    .slice(idx + 1)
    .trim();
}

const receipt = JSON.parse(readFileSync(RECEIPT, 'utf8'));
const goldByTask = receipt.targets; // { taskId: goldMemoryId }

const taskFiles = readdirSync(TASKS)
  .filter((f) => /^\d\d-.*\.json$/.test(f))
  .sort();

/** Which scoring band a returned score fell into. */
function band(score) {
  if (score === undefined || score === null) return 'none';
  if (score > 1.25 + 1e-9) return 'boosted>FTS'; // graph x1.2 etc
  if (score > 1.1 + 1e-9) return 'FTS(1.10,1.25]';
  if (score > 1.0 + 1e-9) return 'ILIKE(1.00,1.10]';
  return 'vector<=1.00';
}

async function recall(query, limit) {
  const res = await fetch(`${BASE}/v1/memories/query?scope=user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AM-API-Key': KEY,
      'X-AM-User-ID': USER,
      ...EXTRA_HEADERS,
    },
    body: JSON.stringify({ query, limit }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`recall ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  return {
    memories: data.memories ?? [],
    latencyMs: Number(data.latencyMs ?? 0),
  };
}

function resetUsage() {
  if (!RESET_DB) return;
  execFileSync(
    'psql',
    [
      RESET_DB,
      '-q',
      '-c',
      `UPDATE memories m
          SET retrieval_count = s.retrieval_count,
              used_count = s.used_count,
              unused_count = s.unused_count,
              last_retrieved_at = s.last_retrieved_at,
              last_used_at = s.last_used_at
         FROM zz_probe_usage_snapshot s
        WHERE m.id = s.id;`,
    ],
    { stdio: 'ignore' },
  );
}

const rows = [];
let goldTop1 = 0;
let goldTop5 = 0;
let goldTop10 = 0;
let goldInPool = 0;

for (const file of taskFiles) {
  const task = JSON.parse(readFileSync(join(TASKS, file), 'utf8'));
  const gold = goldByTask[task.id];
  if (!gold) {
    process.stderr.write(`no gold target for task ${task.id}\n`);
    continue;
  }

  // Ranked page the benchmark would actually consume.
  resetUsage();
  const pageResponse = await recall(task.query, LIMIT);
  const page = pageResponse.memories;
  // Deep page: is the gold anywhere in the candidate pool at all?
  resetUsage();
  const deepResponse = await recall(task.query, 250);
  const deep = deepResponse.memories;

  const rank = page.findIndex((m) => m.id === gold); // -1 = absent
  const deepRank = deep.findIndex((m) => m.id === gold);
  const goldRow = deep[deepRank] ?? null;

  if (rank === 0) goldTop1++;
  if (rank >= 0 && rank < 5) goldTop5++;
  if (rank >= 0 && rank < 10) goldTop10++;
  if (deepRank >= 0) goldInPool++;

  rows.push({
    task: task.id,
    query: task.query,
    goldId: gold,
    rankInPage: rank,
    rankInPool: deepRank,
    pageSize: page.length,
    poolSize: deep.length,
    pageLatencyMs: pageResponse.latencyMs,
    deepLatencyMs: deepResponse.latencyMs,
    goldScore: goldRow ? goldRow.score : null,
    goldBand: goldRow ? band(goldRow.score) : 'ABSENT',
    top: page.slice(0, 10).map((m, i) => ({
      i,
      id: m.id,
      score: m.score,
      band: band(m.score),
      gold: m.id === gold,
      text: (m.raw ?? m.content ?? '').slice(0, 70),
    })),
  });
}

const n = rows.length;
const summary = {
  label: LABEL,
  baseUrl: BASE,
  limit: LIMIT,
  headers: EXTRA_HEADERS,
  tasks: n,
  goldTop1: `${goldTop1}/${n}`,
  goldTop5: `${goldTop5}/${n}`,
  goldTop10: `${goldTop10}/${n}`,
  goldAnywhereInPool: `${goldInPool}/${n}`,
};

// ── human-readable ────────────────────────────────────────────────────────
process.stdout.write(`\n=== ${LABEL}  (limit=${LIMIT}) ===\n`);
for (const r of rows) {
  const where =
    r.rankInPage >= 0
      ? `page rank ${r.rankInPage}`
      : r.rankInPool >= 0
        ? `NOT in page; pool rank ${r.rankInPool}/${r.poolSize}`
        : `NOT IN POOL AT ALL (pool ${r.poolSize})`;
  process.stdout.write(
    `\n${r.task}\n  gold ${r.goldId} -> ${where}  score=${
      r.goldScore === null ? 'n/a' : Number(r.goldScore).toFixed(5)
    } band=${r.goldBand}\n`,
  );
  for (const t of r.top) {
    process.stdout.write(
      `   ${String(t.i).padStart(2)} ${Number(t.score).toFixed(5)} ${t.band.padEnd(17)} ${
        t.gold ? 'GOLD ' : '     '
      }${t.text}\n`,
    );
  }
}
process.stdout.write(
  `\n--- summary ---\n${JSON.stringify(summary, null, 2)}\n`,
);

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
  process.stdout.write(`wrote ${OUT}\n`);
}
