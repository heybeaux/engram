// Baseline: Engram's current dedup/conflict classifier (src/deduplication/automated/dedup-classification.service.ts):
// prompt and JSON parsing/validation reproduced verbatim. DEVIATIONS (no OpenAI key provisioned to this agent):
//  - model is Claude Haiku 4.5 via headless `claude -p` instead of gpt-4o-mini; temperature/maxTokens are not settable there.
//  - the 'semantic similarity' hint is lexical cosine (stand-in for Engram's embedder).
import { load, appendJsonl, readJsonl, pmap } from './lib.mjs';
import { spawn } from 'node:child_process';
const OUT = process.argv[2] || 'data/engram-path.jsonl';
const CONC = Number(process.env.CONC || 1);
const MODEL = process.env.BASE_MODEL || 'haiku';
const d = load();
const done = new Set(readJsonl(OUT).map((r) => r.id));
const todo = d.pairs.filter((p) => !done.has(p.id));

const toks = (t) => t.toLowerCase().match(/[a-z]{3,}/g) ?? [];
const lexCos = (x, y) => {
  const A = new Map(),
    B = new Map();
  toks(x).forEach((w) => A.set(w, (A.get(w) || 0) + 1));
  toks(y).forEach((w) => B.set(w, (B.get(w) || 0) + 1));
  let dot = 0,
    na = 0,
    nb = 0;
  for (const [w, c] of A) {
    na += c * c;
    if (B.has(w)) dot += c * B.get(w);
  }
  for (const c of B.values()) nb += c * c;
  return dot / Math.sqrt((na || 1) * (nb || 1));
};

function claude(prompt) {
  return new Promise((resolve, reject) => {
    const ch = spawn(
      'claude',
      [
        '-p',
        '--model',
        MODEL,
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
    ch.stdout.on('data', (d) => (out += d));
    ch.stderr.on('data', (d) => (err += d));
    ch.on('close', (code) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`claude exit ${code}: ${(out || err).slice(0, 200)}`));
      }
    });
    ch.stdin.end(prompt);
  });
}

const VALID = [
  'DUPLICATE',
  'SUPPORTING',
  'OVERLAPPING',
  'CONFLICTING',
  'RELATED',
];
function parse(raw) {
  const cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('non-JSON response');
  const p = JSON.parse(m[0]);
  if (!VALID.includes(p.classification))
    throw new Error('invalid label ' + p.classification);
  return {
    label: p.classification,
    confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0)),
  };
}

await pmap(todo, CONC, async (p) => {
  const [c1, c2] = p.candidate_first
    ? [p.candidate.text, p.incoming.text]
    : [p.incoming.text, p.candidate.text];
  const sem = lexCos(c1, c2);
  const w1 = new Set(c1.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []),
    w2 = new Set(c2.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []);
  const overlap =
    [...w1].filter((w) => w2.has(w)).length / Math.max(w1.size, w2.size, 1);
  const weighted = sem * 0.7 + overlap * 0.2 + 0.5 * 0.1;
  const prompt = `You are a memory deduplication expert. Classify the relationship between these two memory entries.

Memory 1:
"${c1}"

Memory 2:
"${c2}"

Signal scores (informational — use your judgment):
- Semantic similarity : ${(sem * 100).toFixed(1)}%
- Entity overlap      : ${(overlap * 100).toFixed(1)}%
- Weighted score      : ${(weighted * 100).toFixed(1)}%

Classify as exactly one of:
- DUPLICATE    — nearly identical content, same meaning
- SUPPORTING   — one expands or supports the other
- OVERLAPPING  — partially overlapping, each has unique content
- CONFLICTING  — contradictory information
- RELATED      — related topic but clearly distinct

Respond with ONLY valid JSON (no markdown fences):
{
  "classification": "<one of the five labels above>",
  "confidence": <0.0-1.0>,
  "merged_content": "<best combined version for DUPLICATE/SUPPORTING/OVERLAPPING, else null>",
  "reasoning": "<one sentence>"
}`;
  const t0 = performance.now();
  let rec = { id: p.id, system: 'engram-prompt-' + MODEL, sem };
  try {
    const j = await claude(prompt);
    rec.latency_ms = performance.now() - t0;
    rec.api_ms = j.duration_api_ms;
    rec.cost_usd = j.total_cost_usd;
    rec.in_tok =
      (j.usage.input_tokens ?? 0) +
      (j.usage.cache_creation_input_tokens ?? 0) +
      (j.usage.cache_read_input_tokens ?? 0);
    rec.out_tok = j.usage.output_tokens;
    if (j.is_error) rec.error = String(j.result).slice(0, 200);
    else {
      try {
        Object.assign(rec, parse(j.result));
      } catch (e) {
        rec.parse_error = String(e.message);
        rec.raw = j.result.slice(0, 200);
      }
    }
  } catch (e) {
    rec.latency_ms = performance.now() - t0;
    rec.error = String(e.message);
  }
  appendJsonl(OUT, rec);
});
console.log('done', readJsonl(OUT).length);
