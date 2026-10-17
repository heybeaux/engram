// Dev-only analysis of where independently extracted facts lose update recall.
// Reads pinned raw results; makes no model or database calls.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const base = new URL('./', import.meta.url);
const v2 = process.argv.includes('--v2');
const inputs = {
  baseline: [
    'results/dev-on.jsonl',
    '3e5ab3ef20bb2e58d5a3f5c5fda1358316eb43ceba777d71f15bb9df5d64ec6a',
  ],
  facts: v2
    ? [
        'results/dev-atomic-facts-v2.jsonl',
        '1e790a678d13986df0580f3f0d8f517277950139a20afd957ccd46e13e9106c4',
      ]
    : [
        'results/dev-atomic-facts.jsonl',
        '9a52dd9d98d0ed0fe0d63d10dcd56b4e2f38fb0839be8c71fc2098fa583e12e4',
      ],
  align: v2
    ? [
        'results/dev-atomic-align-v2.jsonl',
        '64d4b5fb95a74e741f510766aa0f5cc29375a948520a518bb9adb535206bce4b',
      ]
    : [
        'results/dev-atomic-align.jsonl',
        '68a7fa57ba64f72f0a4d75192481c724bddba6262d5f94612cdfbcda20984cb5',
      ],
};
const load = ([name, expected]) => {
  const bytes = fs.readFileSync(new URL(name, base));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`${name}: input hash mismatch`);
  return bytes.toString('utf8').trim().split('\n').map(JSON.parse);
};
const baseline = load(inputs.baseline);
const facts = load(inputs.facts);
const align = load(inputs.align);
if (
  baseline.length !== 448 ||
  facts.length !== 111 ||
  align.length !== 60 ||
  new Map(baseline.map((row) => [row.id, row])).size !== 420 ||
  [...new Map(baseline.map((row) => [row.id, row])).values()].filter(
    (row) => row.predicted,
  ).length !== 60
) {
  throw new Error('Unexpected dev input counts');
}
const baselineById = new Map(baseline.map((row) => [row.id, row]));
const norm = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .replace(/^(me|myself|i)$/, 'user');
const counts = {};
const ids = {};
const record = (key, row) => {
  counts[key] = (counts[key] ?? 0) + 1;
  (ids[key] ??= []).push(row.id);
};
for (const row of align) {
  const source = baselineById.get(row.id);
  if (!source?.predicted || source.gold !== row.gold) {
    throw new Error(`${row.id}: raw rows disagree`);
  }
  const prefix = row.gold ? 'gold' : 'negative';
  record(`${prefix}_selected`, row);
  if (row.error) {
    record(`${prefix}_precall_abstain`, row);
    continue;
  }
  const oldFacts = row.candidate_facts ?? [];
  const newFacts = row.incoming_facts ?? [];
  if (!oldFacts.length || !newFacts.length) {
    record(`${prefix}_empty_fact_list`, row);
    continue;
  }
  record(`${prefix}_both_fact_lists_nonempty`, row);
  const sameSubjectMode = oldFacts.flatMap((old) =>
    newFacts
      .filter(
        (current) =>
          old.mode === current.mode &&
          norm(old.subject_key) === norm(current.subject_key),
      )
      .map((current) => [old, current]),
  );
  if (!sameSubjectMode.length) record(`${prefix}_no_same_subject_mode`, row);
  const changedValue = sameSubjectMode.filter(
    ([old, current]) => norm(old.value) !== norm(current.value),
  );
  if (changedValue.length) record(`${prefix}_subject_mode_value`, row);
  const sameAttribute = changedValue.filter(
    ([old, current]) => norm(old.attribute_key) === norm(current.attribute_key),
  );
  if (sameAttribute.length) record(`${prefix}_also_exact_attribute`, row);
  const sameScope = sameAttribute.filter(
    ([old, current]) => norm(old.scope_key) === norm(current.scope_key),
  );
  if (sameScope.length) record(`${prefix}_also_exact_scope`, row);
  let parsed;
  try {
    parsed = JSON.parse(row.response.match(/\{[\s\S]*\}/)?.[0] ?? '');
  } catch {
    record(`${prefix}_invalid_alignment_json`, row);
    continue;
  }
  if (parsed.supersedes !== true) {
    record(`${prefix}_alignment_abstained`, row);
    continue;
  }
  record(`${prefix}_alignment_approved`, row);
  const old = oldFacts[parsed.older_index];
  const current = newFacts[parsed.newer_index];
  if (
    old &&
    current &&
    old.mode === current.mode &&
    ['current', 'planned'].includes(old.mode) &&
    norm(old.subject_key) === norm(current.subject_key) &&
    norm(old.value) !== norm(current.value)
  ) {
    record(`${prefix}_final_predicted`, row);
  } else {
    record(`${prefix}_alignment_rejected_by_guard`, row);
  }
}
console.log(
  JSON.stringify({ version: v2 ? 'v2' : 'v1', counts, ids }, null, 2),
);
