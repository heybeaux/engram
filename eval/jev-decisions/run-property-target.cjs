// One preregistered ENG-122 dev-only property-targeted evidence run.
// Usage: node eval/jev-decisions/run-property-target.cjs
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
const output = path.join(base, 'results/dev-property-target.jsonl');
if (fs.existsSync(output)) throw new Error('Refusing to overwrite raw result');
const checked = (name, expected) => {
  const bytes = fs.readFileSync(path.join(base, name));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error(`${name}: input hash mismatch`);
  return bytes.toString('utf8');
};
const pairs = JSON.parse(
  checked(
    'data/pairs.json',
    '8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c',
  ),
).pairs;
const firstStage = new Map(
  checked(
    'results/dev-on.jsonl',
    '3e5ab3ef20bb2e58d5a3f5c5fda1358316eb43ceba777d71f15bb9df5d64ec6a',
  )
    .trim()
    .split('\n')
    .map(JSON.parse)
    .map((row) => [row.id, row]),
);
const selected = pairs.filter((pair) => firstStage.get(pair.id)?.predicted);
if (pairs.length !== 420 || firstStage.size !== 420 || selected.length !== 60)
  throw new Error('Unexpected dev baseline counts');
const credential =
  /(api[_ -]?key|password|passwd|secret|token|credential|sk-[A-Za-z0-9]{10,}|bearer\s+[A-Za-z0-9._-]{10,})/i;
if (
  selected.some(
    (pair) =>
      credential.test(pair.candidate.text) ||
      credential.test(pair.incoming.text),
  )
)
  throw new Error('Credential item detected; do not send it');
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required');
const llm = new LLMService({
  get: (key, fallback) =>
    ({ OPENAI_API_KEY: process.env.OPENAI_API_KEY, LLM_PROVIDER: 'openai' })[
      key
    ] ?? fallback,
});
const prompt = (
  older,
  newer,
) => `Compare these two memories for exactly one newer value replacing an older value. Return ONLY JSON. Extract the proposed old and new claims separately. If there is no explicit matching pair of claims, return null for both claims and set same_property_scope to false.

Each claim has: quote (exact contiguous substring of its memory), subject_key (person or organization whose property changes; "user" for first-person), target_key (specific object/person/project/event the property is ABOUT), property_key (smallest precise attribute or measurement, such as current_location, opening_time, price, usage_duration, pre_approval_amount, schedule_day), scope_key (qualifier that distinguishes variants, roles, purpose, or time window; "general" only when none), value (literal substring of quote), mode (current or planned). The old and new claims must have separately stated values. Never invent an unstated value or promote a question into a claim.

Use the SAME normalized subject, target, property, and scope keys only if the quoted claims truly concern the same property of the same target under the same qualifier. Distinguish a main item from a spare, a price from what the price includes, an opening time from a closing time, a route from its collection day, one event from another, and a current state from a contemplated plan. Two related facts can both remain true; shared words or units do not make them replacements. A historical one-off event is not a current property. For a cumulative duration or count, compare values as of each memory's time.

same_property_scope is true only if all four identities match. can_coexist_as_current is true if both quoted values could still be true at the later memory's time, including when they describe different properties or scopes. When uncertain, set same_property_scope to false and can_coexist_as_current to true.

OLDER MEMORY:
${JSON.stringify(older)}

NEWER MEMORY:
${JSON.stringify(newer)}

Return {"older":null|{"quote":"...","subject_key":"...","target_key":"...","property_key":"...","scope_key":"...","value":"...","mode":"current|planned"},"newer":null|{"quote":"...","subject_key":"...","target_key":"...","property_key":"...","scope_key":"...","value":"...","mode":"current|planned"},"same_property_scope":boolean,"can_coexist_as_current":boolean,"reason":"brief"}.`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (pair) => {
  const candidateTime = new Date(
    pair.candidate.date.replace(/ \([A-Za-z]{3}\)/, ''),
  ).getTime();
  const incomingTime = new Date(
    pair.incoming.date.replace(/ \([A-Za-z]{3}\)/, ''),
  ).getTime();
  if (
    !Number.isFinite(candidateTime) ||
    !Number.isFinite(incomingTime) ||
    candidateTime >= incomingTime
  )
    return { id: pair.id, error: 'candidate is not older' };
  const attempts = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const start = performance.now();
      const response = await llm.chat(
        [
          {
            role: 'user',
            content: prompt(pair.candidate.text, pair.incoming.text),
          },
        ],
        {
          provider: 'openai',
          model: 'gpt-4o-mini',
          temperature: 0,
          maxTokens: 700,
        },
      );
      return {
        id: pair.id,
        response: response.content,
        prompt_tokens: response.usage?.promptTokens ?? null,
        completion_tokens: response.usage?.completionTokens ?? null,
        latency_ms: performance.now() - start,
        attempts,
      };
    } catch (error) {
      attempts.push({ error: String(error) });
      if (!/429|500|502|503|504/.test(String(error))) break;
      await sleep(1000 * 2 ** attempt);
    }
  }
  return { id: pair.id, error: 'model call failed', attempts };
};
(async () => {
  let next = 0;
  let completed = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < selected.length) {
        const row = await call(selected[next++]);
        fs.appendFileSync(output, `${JSON.stringify(row)}\n`);
        completed++;
        if (completed % 20 === 0)
          process.stdout.write(`dev property target ${completed}/60\n`);
      }
    }),
  );
  process.stdout.write(`complete: ${completed} selected dev pairs\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
