// Recompute all classifier metrics from raw JSONL rows; no model or database calls.
import fs from 'node:fs';
const dir = new URL('./results/', import.meta.url);
const mode = process.argv[2] ?? 'default';
if (
  !['default', '--dev-verified', '--dev-property', '--heldout-v3'].includes(
    mode,
  )
)
  throw new Error(
    'Usage: node score-supersession.mjs [--dev-verified|--dev-property|--heldout-v3]',
  );
const verifiedDev = mode === '--dev-verified';
const propertyDev = mode === '--dev-property';
const read = (set, arm) => {
  const name =
    verifiedDev && set === 'dev' && arm === 'on'
      ? 'dev-on-verified'
      : propertyDev && set === 'dev' && arm === 'on'
        ? 'dev-on-property'
        : `${set}-${arm}`;
  const attempts = fs
    .readFileSync(new URL(`${name}.jsonl`, dir), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return {
    attempts,
    rows: [...new Map(attempts.map((r) => [r.id, r])).values()],
  };
};
const expected = {
  dev: [420, 70, 70],
  heldout: [80, 20, 20],
  'heldout-v3': [80, 20, 20],
};
const f1 = (rows) => {
  const tp = rows.filter((r) => r.gold && r.predicted).length;
  const fp = rows.filter((r) => !r.gold && r.predicted).length;
  const fn = rows.filter((r) => r.gold && !r.predicted).length;
  const tn = rows.filter((r) => !r.gold && !r.predicted).length;
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
const quantile = (values, p) => {
  const a = [...values].sort((x, y) => x - y);
  return a[Math.floor((a.length - 1) * p)];
};
const wilson = (k, n) => {
  const z = 1.96,
    p = k / n,
    d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const radius = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
};
let seed = 7;
const random = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32;
for (const set of mode === '--heldout-v3'
  ? ['heldout-v3']
  : verifiedDev || propertyDev
    ? ['dev']
    : ['dev', 'heldout']) {
  const offRaw = read(set, 'off'),
    onRaw = read(set, 'on');
  const off = offRaw.rows,
    on = onRaw.rows;
  const clusters = [...new Set(on.map((r) => r.cluster))].sort();
  if (
    off.length !== expected[set][0] ||
    on.length !== expected[set][0] ||
    clusters.length !== expected[set][1]
  )
    throw new Error(`${set}: missing or duplicate rows`);
  const byArm = new Map();
  for (const [arm, rows] of [
    ['off', off],
    ['on', on],
  ]) {
    const index = new Map(rows.map((r) => [r.id, r]));
    if (
      index.size !== rows.length ||
      rows.some((r) => r.error || typeof r.predicted !== 'boolean')
    )
      throw new Error(`${set} ${arm}: duplicate or invalid classification`);
    if (rows.filter((r) => r.gold).length !== expected[set][2])
      throw new Error('Gold count mismatch');
    if (
      arm === 'on' &&
      off.some((r) => !index.has(r.id) || index.get(r.id).gold !== r.gold)
    )
      throw new Error('Unpaired rows');
    byArm.set(
      arm,
      new Map(clusters.map((c) => [c, rows.filter((r) => r.cluster === c)])),
    );
  }
  const samples = { off: [], on: [], delta: [], offFp: [], onFp: [] };
  for (let b = 0; b < 2000; b++) {
    const sampled = Array.from(
      { length: clusters.length },
      () => clusters[Math.floor(random() * clusters.length)],
    );
    const scores = Object.fromEntries(
      ['off', 'on'].map((arm) => [
        arm,
        f1(sampled.flatMap((c) => byArm.get(arm).get(c))),
      ]),
    );
    samples.off.push(scores.off.f1);
    samples.on.push(scores.on.f1);
    samples.delta.push(scores.on.f1 - scores.off.f1);
    samples.offFp.push(scores.off.fp);
    samples.onFp.push(scores.on.fp);
  }
  console.log(`\n${set}: ${on.length} pairs, ${clusters.length} clusters`);
  for (const [arm, rows] of [
    ['off', off],
    ['on', on],
  ]) {
    const s = f1(rows);
    const fpInterval = wilson(s.fp, s.fp + s.tn);
    const valid = rows.filter(
      (r) => r.prompt_tokens !== null && r.completion_tokens !== null,
    );
    const sum = (field) => valid.reduce((n, r) => n + r[field], 0);
    const dollars =
      (sum('prompt_tokens') * 0.15 + sum('completion_tokens') * 0.6) / 1e6;
    const attempts = arm === 'off' ? offRaw.attempts : onRaw.attempts;
    const totalCost = attempts.reduce(
      (cost, r) =>
        cost +
        ((r.prompt_tokens ?? 0) * 0.15 + (r.completion_tokens ?? 0) * 0.6) /
          1e6,
      0,
    );
    console.log(
      JSON.stringify({
        arm,
        ...s,
        f1_ci: [quantile(samples[arm], 0.025), quantile(samples[arm], 0.975)],
        false_supersession_count_ci: [
          quantile(samples[`${arm}Fp`], 0.025),
          quantile(samples[`${arm}Fp`], 0.975),
        ],
        false_supersession_rate: s.fp / (s.fp + s.tn),
        false_supersession_ci_wilson: fpInterval,
        latency_p50_ms: quantile(
          rows.map((r) => r.latency_ms),
          0.5,
        ),
        latency_p95_ms: quantile(
          rows.map((r) => r.latency_ms),
          0.95,
        ),
        mean_prompt_tokens: sum('prompt_tokens') / valid.length,
        mean_completion_tokens: sum('completion_tokens') / valid.length,
        total_prompt_tokens: sum('prompt_tokens'),
        total_completion_tokens: sum('completion_tokens'),
        estimated_usd_per_classification: dollars / valid.length,
        estimated_total_attempt_cost_usd: totalCost,
        raw_attempts: attempts.length,
        failed_attempts: attempts.filter((r) => r.error).length,
        metered: valid.length,
        total: rows.length,
      }),
    );
  }
  const delta = f1(on).f1 - f1(off).f1;
  console.log(
    JSON.stringify({
      paired_f1_delta: delta,
      ci: [quantile(samples.delta, 0.025), quantile(samples.delta, 0.975)],
    }),
  );
}
