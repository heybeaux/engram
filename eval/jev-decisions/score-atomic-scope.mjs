// Score ENG-122 independent-fact extraction on seen dev only. No model or DB calls.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const base = new URL('./', import.meta.url);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const read = (name, expected) => {
  const bytes = fs.readFileSync(new URL(name, base));
  if (sha(bytes) !== expected) throw new Error(`${name}: hash mismatch`);
  return bytes.toString('utf8');
};
const pairs = JSON.parse(
  read(
    'data/pairs.json',
    '8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c',
  ),
).pairs;
const baselineAttempts = read(
  'results/dev-on.jsonl',
  '3e5ab3ef20bb2e58d5a3f5c5fda1358316eb43ceba777d71f15bb9df5d64ec6a',
)
  .trim()
  .split('\n')
  .map(JSON.parse);
const extracted = read(
  'results/dev-atomic-facts.jsonl',
  '9a52dd9d98d0ed0fe0d63d10dcd56b4e2f38fb0839be8c71fc2098fa583e12e4',
)
  .trim()
  .split('\n')
  .map(JSON.parse);
const baseline = new Map(baselineAttempts.map((row) => [row.id, row]));
if (pairs.length !== 420 || baseline.size !== 420 || extracted.length !== 111)
  throw new Error('Unexpected dev input counts');
const norm = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .replace(/^(me|myself|i)$/, 'user');
let invalidExtractions = 0;
const facts = new Map();
for (const row of extracted) {
  let parsed;
  try {
    parsed = JSON.parse(row.response.match(/\{[\s\S]*\}/)[0]).facts;
    if (!Array.isArray(parsed)) throw new Error('facts is not an array');
  } catch {
    invalidExtractions++;
    parsed = [];
  }
  facts.set(
    row.text_sha256,
    parsed.filter(
      (fact) =>
        ['current', 'planned'].includes(fact.mode) &&
        ['subject_key', 'attribute_key', 'scope_key', 'value', 'quote'].every(
          (key) => typeof fact[key] === 'string' && fact[key].length > 0,
        ) &&
        row.text.includes(fact.quote),
    ),
  );
}
const rows = pairs.map((pair) => {
  const oldFacts = facts.get(sha(pair.candidate.text)) ?? [];
  const newFacts = facts.get(sha(pair.incoming.text)) ?? [];
  const match = oldFacts.some((old) =>
    newFacts.some(
      (current) =>
        old.mode === current.mode &&
        norm(old.subject_key) === norm(current.subject_key) &&
        norm(old.attribute_key) === norm(current.attribute_key) &&
        norm(old.scope_key) === norm(current.scope_key) &&
        norm(old.value) !== norm(current.value),
    ),
  );
  return {
    id: pair.id,
    cluster: pair.question_id,
    gold: pair.gold_conflict,
    predicted: baseline.get(pair.id).predicted && match,
  };
});
const score = (items) => {
  const tp = items.filter((row) => row.gold && row.predicted).length;
  const fp = items.filter((row) => !row.gold && row.predicted).length;
  const fn = items.filter((row) => row.gold && !row.predicted).length;
  const tn = items.filter((row) => !row.gold && !row.predicted).length;
  return { tp, fp, fn, tn, f1: (2 * tp) / (2 * tp + fp + fn) || 0 };
};
let seed = 7;
const random = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32;
const clusters = [...new Set(rows.map((row) => row.cluster))].sort();
const byCluster = new Map(
  clusters.map((cluster) => [
    cluster,
    rows.filter((row) => row.cluster === cluster),
  ]),
);
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
const tokens = (name) =>
  extracted.reduce((total, row) => total + (row[name] ?? 0), 0);
const result = score(rows);
console.log(
  JSON.stringify({
    ...result,
    f1_ci: [q(f1Samples, 0.025), q(f1Samples, 0.975)],
    false_supersession_count_ci: [q(fpSamples, 0.025), q(fpSamples, 0.975)],
    clusters: clusters.length,
    selected_pairs: pairs.filter((pair) => baseline.get(pair.id).predicted)
      .length,
    unique_memories: extracted.length,
    invalid_extractions: invalidExtractions,
    prompt_tokens: tokens('prompt_tokens'),
    completion_tokens: tokens('completion_tokens'),
    estimated_extra_chat_cost_usd:
      (tokens('prompt_tokens') * 0.15 + tokens('completion_tokens') * 0.6) /
      1e6,
    false_positive_ids: rows
      .filter((row) => !row.gold && row.predicted)
      .map((row) => row.id),
  }),
);
