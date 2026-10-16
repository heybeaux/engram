// Pinned ENG-122 property-targeted dev decision rule; no model or DB calls.
// Usage: node eval/jev-decisions/score-property-target.mjs <raw-sha256>
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const rawHash = process.argv[2];
if (!/^[a-f0-9]{64}$/.test(rawHash ?? ''))
  throw new Error('Pass the raw JSONL SHA-256 as the only argument');
const base = new URL('./', import.meta.url);
const read = (name, expected) => {
  const bytes = fs.readFileSync(new URL(name, base));
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error(`${name}: input hash mismatch`);
  return bytes.toString('utf8');
};
const pairs = JSON.parse(
  read(
    'data/pairs.json',
    '8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c',
  ),
).pairs;
const baseline = new Map(
  read(
    'results/dev-on.jsonl',
    '3e5ab3ef20bb2e58d5a3f5c5fda1358316eb43ceba777d71f15bb9df5d64ec6a',
  )
    .trim()
    .split('\n')
    .map(JSON.parse)
    .map((row) => [row.id, row]),
);
const raw = read('results/dev-property-target.jsonl', rawHash)
  .trim()
  .split('\n')
  .map(JSON.parse);
const byId = new Map(raw.map((row) => [row.id, row]));
if (
  pairs.length !== 420 ||
  baseline.size !== 420 ||
  raw.length !== 60 ||
  byId.size !== 60 ||
  [...baseline.values()].filter((row) => row.predicted).length !== 60
)
  throw new Error('Unexpected dev input counts');
const norm = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .replace(/^(me|myself|i)$/, 'user');
const claimValid = (claim, sourceText) =>
  claim &&
  [
    'quote',
    'subject_key',
    'target_key',
    'property_key',
    'scope_key',
    'value',
  ].every(
    (key) => typeof claim[key] === 'string' && claim[key].trim().length > 0,
  ) &&
  ['current', 'planned'].includes(claim.mode) &&
  sourceText.includes(claim.quote) &&
  claim.quote.toLowerCase().includes(claim.value.toLowerCase());
let invalidJson = 0;
let invalidShape = 0;
const rows = pairs.map((pair) => {
  const attempt = byId.get(pair.id);
  let predicted = false;
  if (baseline.get(pair.id)?.predicted && attempt && !attempt.error) {
    let parsed;
    try {
      parsed = JSON.parse(attempt.response.match(/\{[\s\S]*\}/)?.[0] ?? '');
    } catch {
      invalidJson++;
    }
    if (parsed) {
      if (
        !('older' in parsed) ||
        !('newer' in parsed) ||
        typeof parsed.same_property_scope !== 'boolean' ||
        typeof parsed.can_coexist_as_current !== 'boolean'
      )
        invalidShape++;
      else {
        const old = parsed.older;
        const current = parsed.newer;
        const candidateTime = new Date(
          pair.candidate.date.replace(/ \([A-Za-z]{3}\)/, ''),
        ).getTime();
        const incomingTime = new Date(
          pair.incoming.date.replace(/ \([A-Za-z]{3}\)/, ''),
        ).getTime();
        predicted = Boolean(
          parsed.same_property_scope === true &&
          parsed.can_coexist_as_current === false &&
          Number.isFinite(candidateTime) &&
          Number.isFinite(incomingTime) &&
          candidateTime < incomingTime &&
          claimValid(old, pair.candidate.text) &&
          claimValid(current, pair.incoming.text) &&
          old.mode === current.mode &&
          ['subject_key', 'target_key', 'property_key', 'scope_key'].every(
            (key) => norm(old[key]) === norm(current[key]),
          ) &&
          norm(old.value) !== norm(current.value),
        );
      }
    }
  }
  return {
    id: pair.id,
    cluster: pair.question_id,
    gold: pair.gold_conflict,
    predicted,
  };
});
const score = (items) => {
  const tp = items.filter((row) => row.gold && row.predicted).length;
  const fp = items.filter((row) => !row.gold && row.predicted).length;
  const fn = items.filter((row) => row.gold && !row.predicted).length;
  const tn = items.filter((row) => !row.gold && !row.predicted).length;
  return { tp, fp, fn, tn, f1: (2 * tp) / (2 * tp + fp + fn) || 0 };
};
const clusters = [...new Set(rows.map((row) => row.cluster))].sort();
const byCluster = new Map(
  clusters.map((cluster) => [
    cluster,
    rows.filter((row) => row.cluster === cluster),
  ]),
);
let seed = 7;
const random = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32;
const f1Samples = [];
const fpSamples = [];
for (let repeat = 0; repeat < 2000; repeat++) {
  const sample = Array.from(
    { length: clusters.length },
    () => clusters[Math.floor(random() * clusters.length)],
  ).flatMap((cluster) => byCluster.get(cluster));
  const result = score(sample);
  f1Samples.push(result.f1);
  fpSamples.push(result.fp);
}
const q = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
};
const result = score(rows);
const z = 1.96;
const n = result.fp + result.tn;
const rate = result.fp / n;
const denominator = 1 + (z * z) / n;
const center = (rate + (z * z) / (2 * n)) / denominator;
const half =
  (z * Math.sqrt((rate * (1 - rate)) / n + (z * z) / (4 * n * n))) /
  denominator;
const latencies = raw
  .map((row) => row.latency_ms)
  .filter(Number.isFinite)
  .sort((a, b) => a - b);
const sum = (name) => raw.reduce((total, row) => total + (row[name] ?? 0), 0);
const promptTokens = sum('prompt_tokens');
const completionTokens = sum('completion_tokens');
console.log(
  JSON.stringify({
    ...result,
    f1_ci: [q(f1Samples, 0.025), q(f1Samples, 0.975)],
    false_supersession_count_ci: [q(fpSamples, 0.025), q(fpSamples, 0.975)],
    false_supersession_wilson_ci: [Math.max(0, center - half), center + half],
    clusters: clusters.length,
    selected_pairs: raw.length,
    model_calls: latencies.length,
    abstained_before_call: raw.filter(
      (row) => row.error === 'candidate is not older',
    ).length,
    model_call_failures: raw.filter((row) => row.error === 'model call failed')
      .length,
    invalid_json: invalidJson,
    invalid_shape: invalidShape,
    raw_failed_attempts: raw.reduce(
      (total, row) => total + (row.attempts?.length ?? 0),
      0,
    ),
    p50_latency_ms: q(latencies, 0.5),
    p95_latency_ms: q(latencies, 0.95),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    estimated_extra_chat_cost_usd:
      (promptTokens * 0.15 + completionTokens * 0.6) / 1e6,
    false_positive_ids: rows
      .filter((row) => !row.gold && row.predicted)
      .map((row) => row.id),
  }),
);
