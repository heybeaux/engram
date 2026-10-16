// Score the first ENG-125 held-out flag comparison. Never calls a model or database.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const path = (name) => new URL(name, import.meta.url);
const fixtureBytes = fs.readFileSync(path('fixtures/heldout-v3.json'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (
  hash(fixtureBytes) !==
  '3a2d03a1cd98125a5772e74b0e87e3165e313dcd7ef8bd3d81c7031f60277072'
)
  throw new Error('Fixture hash mismatch');
const fixture = JSON.parse(fixtureBytes);
const expected = new Map(
  fixture.items.flatMap((item) =>
    [item.old, ...item.stillTrue].map((_, index) => [
      `${item.id}:${index}`,
      { cluster: item.id, gold: index === 0 },
    ]),
  ),
);
if (fixture.items.length !== 20 || expected.size !== 80)
  throw new Error('Fixture size mismatch');

const raw = Object.fromEntries(
  ['off', 'on'].map((arm) => {
    const bytes = fs.readFileSync(path(`results/eng125-v3-${arm}.jsonl`));
    const attempts = bytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const final = new Map(attempts.map((row) => [row.id, row]));
    if (final.size !== 80 || attempts.length !== 80)
      throw new Error(`${arm}: incomplete or duplicate raw attempts`);
    for (const [id, row] of final) {
      const want = expected.get(id);
      if (
        !want ||
        row.cluster !== want.cluster ||
        row.gold !== want.gold ||
        row.arm !== arm ||
        row.set !== 'heldout'
      )
        throw new Error(`${arm}: raw row does not match frozen fixture`);
    }
    return [arm, { attempts, rows: [...final.values()], sha256: hash(bytes) }];
  }),
);

const invalid = Object.fromEntries(
  ['off', 'on'].map((arm) => [
    arm,
    raw[arm].rows.filter(
      (row) => row.error || typeof row.predicted !== 'boolean',
    ),
  ]),
);
if (invalid.off.length || invalid.on.length) {
  console.log(
    JSON.stringify({
      gate: 'indeterminate_invalid_calls',
      raw_sha256: { off: raw.off.sha256, on: raw.on.sha256 },
      invalid: Object.fromEntries(
        ['off', 'on'].map((arm) => [
          arm,
          invalid[arm].map((row) => ({ id: row.id, error: row.error })),
        ]),
      ),
    }),
  );
  process.exit(2);
}

const score = (rows) => {
  const tp = rows.filter((row) => row.gold && row.predicted).length;
  const fp = rows.filter((row) => !row.gold && row.predicted).length;
  const fn = rows.filter((row) => row.gold && !row.predicted).length;
  const tn = rows.filter((row) => !row.gold && !row.predicted).length;
  return {
    tp,
    fp,
    fn,
    tn,
    precision: tp / (tp + fp) || 0,
    recall: tp / (tp + fn) || 0,
    f1: (2 * tp) / (2 * tp + fp + fn) || 0,
  };
};
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
};
const interval = (values) => [
  percentile(values, 0.025),
  percentile(values, 0.975),
];
const wilson = (k, n) => {
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const radius = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
};

let seed = 7;
const random = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32;
const clusters = fixture.items.map((item) => item.id);
const byArm = Object.fromEntries(
  ['off', 'on'].map((arm) => [
    arm,
    new Map(
      clusters.map((cluster) => [
        cluster,
        raw[arm].rows.filter((row) => row.cluster === cluster),
      ]),
    ),
  ]),
);
const samples = { offF1: [], onF1: [], deltaF1: [], offFp: [], onFp: [] };
for (let i = 0; i < 2000; i++) {
  const selected = Array.from(
    { length: clusters.length },
    () => clusters[Math.floor(random() * clusters.length)],
  );
  const off = score(selected.flatMap((cluster) => byArm.off.get(cluster)));
  const on = score(selected.flatMap((cluster) => byArm.on.get(cluster)));
  samples.offF1.push(off.f1);
  samples.onF1.push(on.f1);
  samples.deltaF1.push(on.f1 - off.f1);
  samples.offFp.push(off.fp);
  samples.onFp.push(on.fp);
}

const summarize = (arm) => {
  const rows = raw[arm].rows;
  const result = score(rows);
  const promptTokens = rows.reduce((sum, row) => sum + row.prompt_tokens, 0);
  const completionTokens = rows.reduce(
    (sum, row) => sum + row.completion_tokens,
    0,
  );
  const estimatedCostUsd = (promptTokens * 0.15 + completionTokens * 0.6) / 1e6;
  return {
    ...result,
    f1_ci_95: interval(samples[`${arm}F1`]),
    false_supersession_count: result.fp,
    false_supersession_count_ci_95: interval(samples[`${arm}Fp`]),
    false_supersession_rate_ci_wilson_95: wilson(result.fp, 60),
    latency_p50_ms: percentile(
      rows.map((row) => row.latency_ms),
      0.5,
    ),
    latency_p95_ms: percentile(
      rows.map((row) => row.latency_ms),
      0.95,
    ),
    prompt_tokens_total: promptTokens,
    completion_tokens_total: completionTokens,
    prompt_tokens_per_pair: promptTokens / rows.length,
    completion_tokens_per_pair: completionTokens / rows.length,
    api_calls: rows.reduce((sum, row) => sum + row.api_calls, 0),
    estimated_cost_usd: estimatedCostUsd,
    estimated_cost_usd_per_pair: estimatedCostUsd / rows.length,
    raw_attempts: raw[arm].attempts.length,
    valid_pairs: rows.length,
    invalid_pairs: invalid[arm].length,
    raw_sha256: raw[arm].sha256,
  };
};
const off = summarize('off');
const on = summarize('on');
console.log(
  JSON.stringify(
    {
      fixture_sha256: hash(fixtureBytes),
      clusters: clusters.length,
      pairs_per_arm: expected.size,
      off,
      on,
      paired_f1_delta: on.f1 - off.f1,
      paired_f1_delta_ci_95: interval(samples.deltaF1),
      classifier_gate_passes:
        on.f1 >= 0.6 && interval(samples.deltaF1)[0] > 0 && on.fp <= 1,
      row_effects_tested: false,
    },
    null,
    2,
  ),
);
