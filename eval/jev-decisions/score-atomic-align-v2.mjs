// Recompute the ENG-122 dev-only versioned extraction + alignment prototype.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const base = new URL('./', import.meta.url);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (name, hash) => {
  const bytes = fs.readFileSync(new URL(name, base));
  if (sha(bytes) !== hash) throw new Error(`${name}: hash mismatch`);
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
const extractions = read(
  'results/dev-atomic-facts-v2.jsonl',
  '1e790a678d13986df0580f3f0d8f517277950139a20afd957ccd46e13e9106c4',
)
  .trim()
  .split('\n')
  .map(JSON.parse);
const comparisons = read(
  'results/dev-atomic-align-v2.jsonl',
  '64d4b5fb95a74e741f510766aa0f5cc29375a948520a518bb9adb535206bce4b',
)
  .trim()
  .split('\n')
  .map(JSON.parse);
const aligned = new Map(comparisons.map((row) => [row.id, row]));
if (
  pairs.length !== 420 ||
  baseline.size !== 420 ||
  extractions.length !== 111 ||
  comparisons.length !== 60 ||
  aligned.size !== 60
)
  throw new Error('Unexpected dev counts');
const norm = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .replace(/^(me|myself|i)$/, 'user');
let invalidComparison = 0;
const rows = pairs.map((pair) => {
  const comparison = aligned.get(pair.id);
  let predicted = false;
  if (baseline.get(pair.id)?.predicted && comparison && !comparison.error) {
    try {
      const parsed = JSON.parse(comparison.response.match(/\{[\s\S]*\}/)[0]);
      const old = comparison.candidate_facts?.[parsed.older_index];
      const current = comparison.incoming_facts?.[parsed.newer_index];
      predicted =
        parsed.supersedes === true &&
        old &&
        current &&
        old.mode === current.mode &&
        ['current', 'planned'].includes(old.mode) &&
        norm(old.subject_key) === norm(current.subject_key) &&
        norm(old.value) !== norm(current.value);
    } catch {
      invalidComparison++;
    }
  }
  return {
    id: pair.id,
    cluster: pair.question_id,
    gold: pair.gold_conflict,
    predicted: Boolean(predicted),
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
const sum = (records, name) =>
  records.reduce((total, row) => total + (row[name] ?? 0), 0);
const promptTokens =
  sum(extractions, 'prompt_tokens') + sum(comparisons, 'prompt_tokens');
const completionTokens =
  sum(extractions, 'completion_tokens') + sum(comparisons, 'completion_tokens');
console.log(
  JSON.stringify({
    ...score(rows),
    f1_ci: [q(f1Samples, 0.025), q(f1Samples, 0.975)],
    false_supersession_count_ci: [q(fpSamples, 0.025), q(fpSamples, 0.975)],
    selected_pairs: comparisons.length,
    unique_extractions: extractions.length,
    abstained_alignment_rows: comparisons.filter((row) => row.error).length,
    invalid_comparison_json: invalidComparison,
    total_prompt_tokens: promptTokens,
    total_completion_tokens: completionTokens,
    estimated_extra_chat_cost_usd:
      (promptTokens * 0.15 + completionTokens * 0.6) / 1e6,
    false_positive_ids: rows
      .filter((row) => !row.gold && row.predicted)
      .map((row) => row.id),
  }),
);
