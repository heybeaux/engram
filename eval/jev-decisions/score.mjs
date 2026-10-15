import fs from 'node:fs';
import { load, readJsonl } from './lib.mjs';
const d = load();
const P = Object.fromEntries(d.pairs.map((p) => [p.id, p]));
const eng = Object.fromEntries(
  readJsonl('data/engram-path.jsonl').map((r) => [r.id, r]),
);
const jev = Object.fromEntries(
  readJsonl('data/jev-pairs.jsonl').map((r) => [r.id, r]),
);
const ids = d.pairs.map((p) => p.id).filter((id) => eng[id] && jev[id]);
const qOf = (id) => P[id].question_id;
const q = (a, f) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};

// ---- prediction functions (return boolean|null where null = no valid answer) ----
const predEng = (id) => {
  const r = eng[id];
  return r.label ? r.label === 'CONFLICTING' : null;
};
const predJevChoice = (id) => {
  const a = jev[id].answers?.relation;
  return a ? a.choice === 'CONFLICTING' : null;
};
const predJevNoul =
  (t = 0.5) =>
  (id) => {
    const a = jev[id].answers?.updates;
    return a ? a.noul > t : null;
  };
const scoreNoul = (id) => jev[id].answers.updates.noul;
const scoreChoice = (id) => jev[id].answers.relation.probabilities.CONFLICTING;

function prf(idList, pred) {
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0,
    invalid = 0;
  for (const id of idList) {
    const g = P[id].gold_conflict,
      p = pred(id);
    if (p === null) {
      invalid++;
      if (g) fn++;
      else tn++;
      continue;
    }
    if (g && p) tp++;
    else if (!g && p) fp++;
    else if (g && !p) fn++;
    else tn++;
  }
  const prec = tp / Math.max(1, tp + fp),
    rec = tp / Math.max(1, tp + fn);
  return {
    tp,
    fp,
    fn,
    tn,
    invalid,
    precision: prec,
    recall: rec,
    f1: prec + rec ? (2 * prec * rec) / (prec + rec) : 0,
    acc: (tp + tn) / idList.length,
  };
}
function auc(idList, sc) {
  const pos = idList.filter((i) => P[i].gold_conflict).map(sc),
    neg = idList.filter((i) => !P[i].gold_conflict).map(sc);
  let w = 0;
  for (const a of pos) for (const b of neg) w += a > b ? 1 : a === b ? 0.5 : 0;
  return w / (pos.length * neg.length);
}

// bootstrap over question items (cluster) — paired for differences
const items = [...new Set(ids.map(qOf))];
const byItem = {};
ids.forEach((id) => (byItem[qOf(id)] ??= []).push(id));
let seed = 7;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function boot(fn, B = 2000) {
  const vals = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let i = 0; i < items.length; i++)
      sample.push(...byItem[items[Math.floor(rnd() * items.length)]]);
    vals.push(fn(sample));
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]];
}

const out = {
  n_pairs: ids.length,
  n_pos: ids.filter((i) => P[i].gold_conflict).length,
  n_items: items.length,
  set_meta: d.meta,
};
const systems = {
  'Engram prompt (Haiku 4.5)': predEng,
  'Jev choice argmax=CONFLICTING': predJevChoice,
  'Jev noul>0.5': predJevNoul(0.5),
};
out.e1 = {};
for (const [name, fn] of Object.entries(systems)) {
  const m = prf(ids, fn);
  m.f1_ci = boot((s) => prf(s, fn).f1);
  out.e1[name] = m;
}
out.e1_auc = {
  'Jev noul': auc(ids, scoreNoul),
  'Jev P(CONFLICTING)': auc(ids, scoreChoice),
};
out.e1_auc_ci = {
  'Jev noul': boot((s) => auc(s, scoreNoul), 500),
  'Jev P(CONFLICTING)': boot((s) => auc(s, scoreChoice), 500),
};
// paired F1 difference jev noul - engram
out.e1_diff_f1 = {
  'Jev noul>0.5 minus Engram prompt': boot(
    (s) => prf(s, predJevNoul(0.5)).f1 - prf(s, predEng).f1,
  ),
  'Jev choice minus Engram prompt': boot(
    (s) => prf(s, predJevChoice).f1 - prf(s, predEng).f1,
  ),
};
out.e1_noul_sweep = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((t) => ({
  t,
  ...prf(ids, predJevNoul(t)),
}));
// confidence-gated: act only when jev choice confidence >= c (else abstain => treated as "not conflict"); coverage vs precision of acted positives
out.e1_gate = [0, 0.3, 0.5, 0.7].map((c) => {
  const acted = ids.filter((i) => jev[i].answers.relation.confidence >= c);
  const m = prf(acted, predJevChoice);
  return {
    conf_ge: c,
    coverage: acted.length / ids.length,
    precision: m.precision,
    recall: m.recall,
    acc: m.acc,
  };
});
// confusion of engram labels
out.engram_label_counts = { gold_conflict: {}, gold_other: {} };
for (const id of ids) {
  const k = P[id].gold_conflict ? 'gold_conflict' : 'gold_other';
  const l = eng[id].label ?? (eng[id].parse_error ? 'PARSE_FAIL' : 'ERROR');
  out.engram_label_counts[k][l] = (out.engram_label_counts[k][l] || 0) + 1;
}
out.jev_label_counts = { gold_conflict: {}, gold_other: {} };
for (const id of ids) {
  const k = P[id].gold_conflict ? 'gold_conflict' : 'gold_other';
  const l = jev[id].answers.relation.choice;
  out.jev_label_counts[k][l] = (out.jev_label_counts[k][l] || 0) + 1;
}
out.failures = {
  engram_parse_fail: ids.filter((i) => eng[i].parse_error).length,
  engram_error: ids.filter((i) => eng[i].error).length,
  jev_error: ids.filter((i) => jev[i].error).length,
};

// ---- E3 target selection ----
function selection(scoreFn /* id -> number|null (null = not flagged) */) {
  let aOK = 0,
    bOK = 0,
    aWrongPick = 0,
    aMiss = 0,
    bFalse = 0,
    n = 0;
  for (const it of d.items) {
    const dis = [0, 1, 2, 3, 4].map((i) => `${it.question_id}:dis${i}`),
      old = `${it.question_id}:old`;
    if (![old, ...dis].every((i) => eng[i] && jev[i])) continue;
    n++;
    const pick = (cands) => {
      let best = null,
        bs = -1;
      for (const c of cands) {
        const s = scoreFn(c);
        if (s !== null && s > bs) {
          bs = s;
          best = c;
        }
      }
      return best;
    };
    const pa = pick([old, ...dis.slice(0, 4)]);
    if (pa === old) aOK++;
    else if (pa === null) aMiss++;
    else aWrongPick++;
    const pb = pick(dis);
    if (pb === null) bOK++;
    else bFalse++;
  }
  return {
    n,
    with_true_target_correct: aOK / n,
    with_true_target_missed: aMiss / n,
    with_true_target_wrong_pick: aWrongPick / n,
    no_target_correct_none: bOK / n,
    no_target_false_supersede: bFalse / n,
    combined_acc: (aOK + bOK) / (2 * n),
  };
}
out.e3 = {
  'Engram prompt (Haiku 4.5)': selection((id) =>
    eng[id].label === 'CONFLICTING' ? eng[id].confidence : null,
  ),
  'Jev noul>0.5 (argmax)': selection((id) =>
    scoreNoul(id) > 0.5 ? scoreNoul(id) : null,
  ),
  'Jev choice argmax=CONFLICTING': selection((id) =>
    jev[id].answers.relation.choice === 'CONFLICTING' ? scoreChoice(id) : null,
  ),
};

// ---- E2 direction ----
out.e2 = {};
for (const sys of ['jev', 'haiku']) {
  const f = `data/direction-${sys}.jsonl`;
  if (!fs.existsSync(f)) continue;
  for (const variant of ['dated', 'undated']) {
    const rs = readJsonl(f).filter((r) => r.variant === variant);
    if (!rs.length) continue;
    const valid = rs.filter((r) => r.pred);
    const ok = valid.filter((r) => r.pred === (r.a_is_new ? 'A' : 'B')).length;
    const lat = rs.map((r) => r.latency_ms).filter(Boolean);
    out.e2[`${sys}/${variant}`] = {
      n: rs.length,
      invalid: rs.length - valid.length,
      acc_on_valid: ok / Math.max(1, valid.length),
      acc_all: ok / rs.length,
      p50_ms: q(lat, 0.5),
      cost_usd: rs.reduce((a, r) => a + (r.cost_usd || 0), 0) || undefined,
      jev_in_tok:
        sys === 'jev' ? rs.reduce((a, r) => a + (r.in_tok || 0), 0) : undefined,
    };
  }
}
out.e2.newest_wins = {
  note: 'deterministic by timestamp; 100% by construction because gold is defined by session date',
  acc: 1,
};

// ---- cost / latency ----
const lat = (m) => ({
  p50_ms: q(m, 0.5),
  p95_ms: q(m, 0.95),
  mean_ms: m.reduce((a, b) => a + b, 0) / m.length,
});
const eL = ids.map((i) => eng[i].latency_ms),
  jL = ids.map((i) => jev[i].latency_ms);
const eIn = ids.reduce((a, i) => a + eng[i].in_tok, 0),
  eOut = ids.reduce((a, i) => a + eng[i].out_tok, 0),
  jIn = ids.reduce((a, i) => a + jev[i].in_tok, 0);
const est = { in: jIn / ids.length + 50, out: 100 };
out.cost = {
  per_1k_pairs_usd: {
    jev: (jIn / ids.length) * 1000 * 0.042e-6,
    haiku_measured:
      (ids.reduce((a, i) => a + (eng[i].cost_usd || 0), 0) / ids.length) * 1000,
    gpt4omini_estimate_list_price: (est.in * 0.15e-6 + est.out * 0.6e-6) * 1000,
  },
  assumptions:
    'Jev $0.042/Mtok input, output free (docs.typesafe.ai/models, fetched today). Haiku = headless CLI total_cost_usd (includes ~393-token CLI overhead and verbose output; NOT representative of an API call). gpt-4o-mini = assumed list $0.15/$0.60 per Mtok at ~' +
    Math.round(est.in) +
    ' in / ' +
    est.out +
    ' out tokens: an estimate, not measured.',
  tokens: {
    jev_in_mean: jIn / ids.length,
    haiku_in_mean: eIn / ids.length,
    haiku_out_mean: eOut / ids.length,
  },
  latency: {
    jev_seq_conc1: lat(jL),
    haiku_cli_conc3: lat(eL),
    haiku_api_ms: lat(ids.map((i) => eng[i].api_ms)),
  },
};
fs.writeFileSync('data/results.json', JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    { ...out, e1_noul_sweep: undefined },
    (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v),
    1,
  ),
);
console.log(
  'noul sweep',
  JSON.stringify(
    out.e1_noul_sweep.map((r) => ({
      t: r.t,
      p: +r.precision.toFixed(3),
      r: +r.recall.toFixed(3),
      f1: +r.f1.toFixed(3),
    })),
  ),
);
