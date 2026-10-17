// Dev-only ENG-122 prototype. Extract facts from each memory independently.
// Usage: node eval/jev-decisions/run-atomic-scope.cjs
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('ts-node/register/transpile-only');
require('dotenv').config({
  path: '../engram/.env',
  override: true,
  quiet: true,
});
const { LLMService } = require('../../src/llm/llm.service');

const base = __dirname;
const output = path.join(base, 'results/dev-atomic-facts.jsonl');
if (fs.existsSync(output))
  throw new Error('Refusing to overwrite dev extraction raw');
const checked = (relativePath, expectedHash) => {
  const bytes = fs.readFileSync(path.join(base, relativePath));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash)
    throw new Error(`${relativePath}: input hash mismatch`);
  return bytes.toString('utf8');
};
const data = JSON.parse(
  checked(
    'data/pairs.json',
    '8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c',
  ),
);
const attempts = checked(
  'results/dev-on.jsonl',
  '3e5ab3ef20bb2e58d5a3f5c5fda1358316eb43ceba777d71f15bb9df5d64ec6a',
)
  .trim()
  .split('\n')
  .map(JSON.parse);
const final = new Map(attempts.map((row) => [row.id, row]));
const selected = data.pairs.filter((pair) => final.get(pair.id)?.predicted);
if (data.pairs.length !== 420 || selected.length !== 60)
  throw new Error('Unexpected dev baseline counts');
const texts = [
  ...new Set(
    selected.flatMap((pair) => [pair.candidate.text, pair.incoming.text]),
  ),
];
const credential =
  /(api[_ -]?key|password|passwd|secret|token|credential|sk-[A-Za-z0-9]{10,}|bearer\s+[A-Za-z0-9._-]{10,})/i;
if (texts.some((value) => credential.test(value)))
  throw new Error('Credential item detected; do not send it');
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required');

const config = {
  get: (key, fallback) =>
    ({ OPENAI_API_KEY: process.env.OPENAI_API_KEY, LLM_PROVIDER: 'openai' })[
      key
    ] ?? fallback,
};
const llm = new LLMService(config);
const promptFor = (
  memory,
) => `Extract each explicit, atomic fact from this memory ALONE. You have not seen any other memory. Never infer or merge claims. Return only JSON with a facts array.

For each fact, provide:
- subject_key: the person, organization, or object whose property is asserted; use "user" for first-person claims. Keep other people distinct.
- attribute_key: a short canonical snake_case property name, excluding the value and the subject (e.g. current_location, cumulative_count, method, schedule_day, pressure, charge_limit, role, ownership_status).
- scope_key: a short canonical snake_case identity of the exact target or subcategory to which the attribute applies, excluding the value. Include distinctions such as main versus spare battery, match versus training balls, a specific person, project, event, or date. Use "general" only when no narrower target exists.
- value: the asserted value, as a string.
- mode: one of current, planned, past_event, hypothetical. A contemplated purchase is planned, not current ownership. A dated one-off event is past_event. A cumulative total at the memory's time is current.
- quote: an exact substring from the memory that states the fact.

Do not put the value inside subject_key, attribute_key, or scope_key. Do not emit a fact unless it has an exact quote. Keep different attributes separate even when they share a number or noun. An item may have multiple facts.

Memory:
"${memory}"

Return {"facts":[{"subject_key":"...","attribute_key":"...","scope_key":"...","value":"...","mode":"current|planned|past_event|hypothetical","quote":"..."}]}.`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (memory) => {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const start = performance.now();
      const response = await llm.chat(
        [{ role: 'user', content: promptFor(memory) }],
        {
          provider: 'openai',
          model: 'gpt-4o-mini',
          temperature: 0,
          maxTokens: 700,
        },
      );
      return {
        text_sha256: crypto.createHash('sha256').update(memory).digest('hex'),
        text: memory,
        response: response.content,
        prompt_tokens: response.usage?.promptTokens ?? null,
        completion_tokens: response.usage?.completionTokens ?? null,
        latency_ms: performance.now() - start,
      };
    } catch (error) {
      lastError = error;
      if (!/429|500|502|503|504/.test(String(error))) break;
      await sleep(1000 * 2 ** attempt);
    }
  }
  return {
    text_sha256: crypto.createHash('sha256').update(memory).digest('hex'),
    text: memory,
    error: String(lastError),
  };
};

(async () => {
  let next = 0;
  let completed = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < texts.length) {
        const memory = texts[next++];
        const row = await call(memory);
        fs.appendFileSync(output, `${JSON.stringify(row)}\n`);
        completed++;
        if (completed % 20 === 0)
          process.stdout.write(
            `dev atomic extraction ${completed}/${texts.length}\n`,
          );
      }
    }),
  );
  process.stdout.write(`complete: ${completed} unique dev memories\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
