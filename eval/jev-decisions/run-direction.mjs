// E2: given two conflicting statements about the same fact, which one reflects the current state?
// systems: jev | haiku ; variants: dated (said_on shown) | undated. Gold: the later statement. Position randomised (a_is_new).
import { spawn } from 'node:child_process';
import { load, appendJsonl, readJsonl, pmap, readSecret } from './lib.mjs';
const SYS = process.argv[2];
const OUT = process.argv[3] || `data/direction-${SYS}.jsonl`;
const CONC = Number(process.env.CONC || 1);
if (!['jev', 'haiku'].includes(SYS))
  throw new Error('usage: run-direction.mjs jev|haiku [out]');
const d = load();
const JEV_KEY =
  SYS === 'jev'
    ? process.env.TYPESAFE_API_KEY ||
      readSecret('~/.config/clawdbot/secrets/typesafe-jev-api-key')
    : null;
const done = new Set(
  readJsonl(OUT)
    .filter((r) => !r.error)
    .map((r) => `${r.id}|${r.variant}`),
);
const jobs = d.dirItems
  .flatMap((it) => ['dated', 'undated'].map((variant) => ({ it, variant })))
  .filter((j) => !done.has(`${j.it.id}|${j.variant}`));

function claude(prompt) {
  return new Promise((resolve, reject) => {
    const ch = spawn(
      'claude',
      [
        '-p',
        '--model',
        'haiku',
        '--tools',
        '',
        '--no-session-persistence',
        '--disable-slash-commands',
        '--setting-sources',
        '',
        '--system-prompt',
        'You are a JSON-only classifier. Output only what is asked.',
        '--output-format',
        'json',
      ],
      { cwd: '/tmp' },
    );
    let out = '',
      err = '';
    ch.stdout.on('data', (x) => (out += x));
    ch.stderr.on('data', (x) => (err += x));
    ch.on('close', (c) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`claude exit ${c}: ${(out || err).slice(0, 200)}`));
      }
    });
    ch.stdin.end(prompt);
  });
}

await pmap(jobs, CONC, async ({ it, variant }) => {
  const A = it.a_is_new ? it.new : it.old,
    B = it.a_is_new ? it.old : it.new;
  const fmt = (x) =>
    variant === 'dated' ? { said_on: x.date, text: x.text } : { text: x.text };
  const t0 = performance.now();
  const rec = { id: it.id, variant, system: SYS, a_is_new: it.a_is_new };
  try {
    if (SYS === 'jev') {
      const r = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${JEV_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'jev-1.13.0',
          state: { 'Statement A': fmt(A), 'Statement B': fmt(B) },
          questions: {
            current: {
              type: 'choice',
              instructions:
                'Both statements are what the same user said about the same fact at different times. Which statement reflects the CURRENT state of that fact?',
              criteria: {
                A: 'Statement A is the current one',
                B: 'Statement B is the current one',
              },
            },
          },
        }),
      });
      rec.latency_ms = performance.now() - t0;
      const txt = await r.text();
      if (!r.ok) rec.error = `http ${r.status} ${txt.slice(0, 150)}`;
      else {
        const j = JSON.parse(txt);
        rec.in_tok = j.usage.input_tokens;
        rec.pred = j.answers.current.choice;
        rec.conf = j.answers.current.confidence;
        rec.p = j.answers.current.probabilities;
      }
    } else {
      const f = (x) =>
        variant === 'dated' ? `[said on ${x.date}] ${x.text}` : x.text;
      const prompt = `Both statements are what the same user said about the same fact at different times. Which statement reflects the CURRENT state of that fact?\n\nStatement A:\n"${f(A)}"\n\nStatement B:\n"${f(B)}"\n\nRespond with ONLY valid JSON (no markdown fences): {"current": "A" | "B", "confidence": <0.0-1.0>}`;
      const j = await claude(prompt);
      rec.latency_ms = performance.now() - t0;
      rec.cost_usd = j.total_cost_usd;
      rec.out_tok = j.usage.output_tokens;
      const m = String(j.result)
        .replace(/```json\s*|```/gi, '')
        .match(/\{[\s\S]*\}/);
      try {
        const p = JSON.parse(m[0]);
        if (!['A', 'B'].includes(p.current)) throw new Error('bad label');
        rec.pred = p.current;
        rec.conf = p.confidence;
      } catch (e) {
        rec.parse_error = String(e.message);
        rec.raw = String(j.result).slice(0, 200);
      }
    }
  } catch (e) {
    rec.latency_ms = performance.now() - t0;
    rec.error = String(e.message);
  }
  appendJsonl(OUT, rec);
});
console.log('done', readJsonl(OUT).length);
