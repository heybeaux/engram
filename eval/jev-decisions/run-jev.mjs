// Jev (jev-1.13.0, pinned). One request per pair, fan-out: a Choice with Engram's 5 labels (same taxonomy as the
// baseline) + a Noul "does the incoming statement update/replace the candidate". Output tokens are free; priced per input token.
import { load, appendJsonl, readJsonl, pmap, readSecret } from './lib.mjs';
const KEY =
  process.env.TYPESAFE_API_KEY ||
  readSecret('~/.config/clawdbot/secrets/typesafe-jev-api-key');
const OUT = process.argv[2] || 'data/jev-pairs.jsonl';
const CONC = Number(process.env.CONC || 1);
const d = load();
const done = new Set(
  readJsonl(OUT)
    .filter((r) => !r.error)
    .map((r) => r.id),
);
const todo = d.pairs.filter((p) => !done.has(p.id));

const QUESTIONS = {
  relation: {
    type: 'choice',
    instructions:
      'Classify the relationship between Memory 1 and Memory 2, two statements a user made at different times.',
    criteria: {
      DUPLICATE: 'nearly identical content, same meaning',
      SUPPORTING: 'one expands or supports the other',
      OVERLAPPING: 'partially overlapping, each has unique content',
      CONFLICTING: 'contradictory information',
      RELATED: 'related topic but clearly distinct',
    },
  },
  updates: {
    type: 'noul',
    instructions:
      'Does Memory 2 give a new value for the same fact that Memory 1 states, so that Memory 1 is now out of date?',
    criteria: {
      true: 'Same fact about the user, different value; Memory 2 replaces Memory 1',
      false:
        'Different facts, or the same value, or no change in a stated fact',
    },
  },
};

await pmap(todo, CONC, async (p) => {
  const [c1, c2] = p.candidate_first
    ? [p.candidate, p.incoming]
    : [p.incoming, p.candidate];
  // Memory 2 is always the *later-arriving* one in the update question, so present dated state explicitly.
  const state = {
    'Memory 1': { said_on: c1.date, text: c1.text },
    'Memory 2': { said_on: c2.date, text: c2.text },
  };
  const t0 = performance.now();
  const rec = { id: p.id, system: 'jev-1.13.0' };
  try {
    const r = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state,
        model: 'jev-1.13.0',
        questions: QUESTIONS,
      }),
    });
    rec.latency_ms = performance.now() - t0;
    rec.http = r.status;
    const txt = await r.text();
    if (!r.ok) rec.error = `http ${r.status} ${txt.slice(0, 200)}`;
    else {
      const j = JSON.parse(txt);
      rec.model = j.model;
      rec.in_tok = j.usage.input_tokens;
      rec.out_tok = j.usage.output_tokens;
      rec.answers = j.answers;
    }
  } catch (e) {
    rec.latency_ms = performance.now() - t0;
    rec.error = String(e.message);
  }
  appendJsonl(OUT, rec);
});
console.log('done', readJsonl(OUT).length);
