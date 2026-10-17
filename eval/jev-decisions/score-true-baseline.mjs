import fs from 'node:fs';
import { load, readJsonl } from './lib.mjs';

const data = load();
const baseline = Object.fromEntries(
  readJsonl('data/true-baseline.jsonl').map((r) => [r.id, r]),
);
const jev = Object.fromEntries(
  readJsonl('data/jev-pairs.jsonl').map((r) => [r.id, r]),
);
const pairs = data.pairs;
if (pairs.some((p) => !baseline[p.id] || !jev[p.id]))
  throw new Error('Incomplete paired data');

const predictBaseline = (id) =>
  baseline[id].label ? baseline[id].label === 'CONFLICTING' : false;
const predictJev = (id) => jev[id].answers.updates.noul > 0.5;
const byId = Object.fromEntries(pairs.map((p) => [p.id, p]));
const ids = pairs.map((p) => p.id);
const score = (sample, predict) => {
  const counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const id of sample) {
    const gold = byId[id].gold_conflict;
    const pred = predict(id);
    counts[gold ? (pred ? 'tp' : 'fn') : pred ? 'fp' : 'tn']++;
  }
  const precision = counts.tp / Math.max(1, counts.tp + counts.fp);
  const recall = counts.tp / Math.max(1, counts.tp + counts.fn);
  return {
    ...counts,
    precision,
    recall,
    f1:
      precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
  };
};
const groups = Object.groupBy(pairs, (p) => p.question_id);
const items = Object.keys(groups);
let seed = 7;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const samples = Array.from({ length: 2000 }, () =>
  Array.from(
    { length: items.length },
    () => groups[items[Math.floor(rnd() * items.length)]],
  )
    .flat()
    .map((p) => p.id),
);
const ci = (values) => {
  values.sort((a, b) => a - b);
  return [values[50], values[1950]];
};
const b = score(ids, predictBaseline);
const j = score(ids, predictJev);
const out = {
  n_pairs: ids.length,
  n_items: items.length,
  invalid_baseline: ids.filter((id) => !baseline[id].label).length,
  baseline: {
    ...b,
    f1_ci: ci(samples.map((s) => score(s, predictBaseline).f1)),
  },
  jev_noul_gt_0_5: {
    ...j,
    f1_ci: ci(samples.map((s) => score(s, predictJev).f1)),
  },
  paired_jev_minus_baseline_f1: {
    point: j.f1 - b.f1,
    ci: ci(
      samples.map(
        (s) => score(s, predictJev).f1 - score(s, predictBaseline).f1,
      ),
    ),
  },
};
fs.writeFileSync(
  'data/true-baseline-results.json',
  JSON.stringify(out, null, 2),
);
console.log(JSON.stringify(out, null, 2));
