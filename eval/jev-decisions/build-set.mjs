// Builds the labelled pair set for ENG-19 from public LongMemEval knowledge-update items.
// Gold: each KU item has two evidence sessions (older value, newer value) with has_answer turns.
import fs from 'node:fs';
import crypto from 'node:crypto';

const SRC =
  process.env.LME_DATA ||
  `${process.env.HOME}/projects/engram/eval/longmemeval/data/longmemeval_s_cleaned.json`;
const OUT = new URL('./data/pairs.json', import.meta.url).pathname;
const N_DISTRACTORS = 5;
const SECRET_RE =
  /(api[_ -]?key|password|passwd|secret|token|credential|sk-[A-Za-z0-9]{10,}|bearer\s+[A-Za-z0-9._-]{10,})/i;

const parseDate = (s) => {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2}).*?(\d{2}):(\d{2})/);
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`).getTime();
};
const toks = (t) => t.toLowerCase().match(/[a-z]{3,}/g) ?? [];
const STOP = new Set(
  'the and for that with this have from your you are was were but not what can how about they them their will would could should been has had its our out one all any get got just like some more very also into than then there when which who why does did doing make made want need know think going help please thanks thank'.split(
    ' ',
  ),
);

// seeded rng (mulberry32)
let seed = 20261013;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const ku = data.filter((d) => d.question_type === 'knowledge-update');
const items = [];
let dropped = 0;

for (const it of ku) {
  const ans = it.haystack_session_ids
    .map((id, i) => ({ id, i }))
    .filter((x) => x.id.startsWith('answer'));
  if (ans.length !== 2) {
    dropped++;
    continue;
  }
  ans.sort(
    (a, b) =>
      parseDate(it.haystack_dates[a.i]) - parseDate(it.haystack_dates[b.i]),
  );
  const evid = ans.map((a) =>
    it.haystack_sessions[a.i].filter((t) => t.has_answer && t.role === 'user'),
  );
  if (!evid[0].length || !evid[1].length) {
    dropped++;
    continue;
  }
  const oldT = evid[0].map((t) => t.content).join('\n');
  const newT = evid[1].map((t) => t.content).join('\n');
  const oldDate = it.haystack_dates[ans[0].i],
    newDate = it.haystack_dates[ans[1].i];
  if (SECRET_RE.test(oldT + newT + it.question)) {
    dropped++;
    continue;
  }

  // distractor pool: user turns from non-evidence sessions, preferring simulated-user sessions (not sharegpt/ultrachat)
  const pool = [];
  it.haystack_session_ids.forEach((id, i) => {
    if (id.startsWith('answer')) return;
    const generic = /^(sharegpt|ultrachat)/.test(id);
    for (const t of it.haystack_sessions[i]) {
      if (
        t.role !== 'user' ||
        t.has_answer ||
        t.content.length < 40 ||
        t.content.length > 1500
      )
        continue;
      if (SECRET_RE.test(t.content)) continue;
      pool.push({
        text: t.content,
        date: it.haystack_dates[i],
        sessionId: id,
        generic,
      });
    }
  });
  const q = new Set(toks(newT).filter((w) => !STOP.has(w)));
  const scored = pool
    .map((p) => {
      const w = new Set(toks(p.text).filter((x) => !STOP.has(x)));
      let inter = 0;
      for (const x of w) if (q.has(x)) inter++;
      return {
        ...p,
        sim: inter / Math.sqrt(Math.max(1, w.size) * Math.max(1, q.size)),
      };
    })
    .sort((a, b) => b.sim - a.sim);
  // take top by similarity, dedupe on text
  const seen = new Set();
  const distractors = [];
  for (const s of scored) {
    if (seen.has(s.text)) continue;
    seen.add(s.text);
    distractors.push(s);
    if (distractors.length === N_DISTRACTORS) break;
  }
  if (distractors.length < N_DISTRACTORS) {
    dropped++;
    continue;
  }
  items.push({
    question_id: it.question_id,
    question: it.question,
    gold_answer: String(it.answer),
    old: { text: oldT, date: oldDate },
    new: { text: newT, date: newDate },
    distractors,
  });
}

// pair-level records
const pairs = [];
for (const it of items) {
  const mk = (kind, cand, idx) => {
    const swap = rnd() < 0.5; // presentation order (Memory 1 / Memory 2)
    pairs.push({
      id: `${it.question_id}:${kind}${idx ?? ''}`,
      question_id: it.question_id,
      kind,
      gold_conflict: kind === 'old',
      candidate: { text: cand.text, date: cand.date },
      incoming: { text: it.new.text, date: it.new.date },
      candidate_first: !swap,
      sim: cand.sim ?? null,
    });
  };
  mk('old', it.old);
  it.distractors.forEach((d, i) => mk('dis', d, i));
}

const dirItems = items.map((it) => ({
  id: it.question_id,
  a_is_new: rnd() < 0.5,
  old: it.old,
  new: it.new,
}));
const out = {
  meta: {
    source: 'LongMemEval-S cleaned (public)',
    built: new Date().toISOString(),
    n_items: items.length,
    dropped,
    n_pairs: pairs.length,
    n_positive: pairs.filter((p) => p.gold_conflict).length,
    seed: 20261013,
  },
  items,
  pairs,
  dirItems,
};
const json = JSON.stringify(out);
fs.writeFileSync(OUT, json);
out.meta.sha256 = crypto.createHash('sha256').update(json).digest('hex');
console.log(JSON.stringify(out.meta));
const lens = pairs
  .flatMap((p) => [p.candidate.text.length, p.incoming.text.length])
  .sort((a, b) => a - b);
console.log(
  'text length p50/p90/max',
  lens[lens.length >> 1],
  lens[Math.floor(lens.length * 0.9)],
  lens.at(-1),
);
