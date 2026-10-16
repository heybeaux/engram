// Dev-only ENG-122 prototype: compare independently extracted atomic facts.
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
const output = path.join(base, 'results/dev-atomic-align.jsonl');
if (fs.existsSync(output))
  throw new Error('Refusing to overwrite dev alignment raw');
const checked = (name, expectedHash) => {
  const bytes = fs.readFileSync(path.join(base, name));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash)
    throw new Error(`${name}: hash mismatch`);
  return bytes.toString('utf8');
};
const pairs = JSON.parse(
  checked(
    'data/pairs.json',
    '8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c',
  ),
).pairs;
const baseline = new Map(
  checked(
    'results/dev-on.jsonl',
    '3e5ab3ef20bb2e58d5a3f5c5fda1358316eb43ceba777d71f15bb9df5d64ec6a',
  )
    .trim()
    .split('\n')
    .map(JSON.parse)
    .map((row) => [row.id, row]),
);
const extractions = new Map(
  checked(
    'results/dev-atomic-facts.jsonl',
    '9a52dd9d98d0ed0fe0d63d10dcd56b4e2f38fb0839be8c71fc2098fa583e12e4',
  )
    .trim()
    .split('\n')
    .map(JSON.parse)
    .map((row) => [row.text_sha256, row]),
);
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const facts = (text) => {
  const row = extractions.get(sha(text));
  if (!row || row.error) return null;
  try {
    const parsed = JSON.parse(row.response.match(/\{[\s\S]*\}/)[0]);
    if (!Array.isArray(parsed.facts)) return null;
    return parsed.facts.filter(
      (fact) =>
        ['current', 'planned'].includes(fact.mode) &&
        ['subject_key', 'attribute_key', 'scope_key', 'value', 'quote'].every(
          (key) => typeof fact[key] === 'string' && fact[key].length > 0,
        ) &&
        text.includes(fact.quote),
    );
  } catch {
    return null;
  }
};
const selected = pairs.filter((pair) => baseline.get(pair.id)?.predicted);
if (pairs.length !== 420 || selected.length !== 60)
  throw new Error('Unexpected dev baseline counts');
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
) => `Two fact lists were extracted independently, one memory at a time. Decide whether exactly one newer fact replaces the latest value of exactly the same subject, attribute, and qualifying scope in an older fact. A shared topic, unit, number, or organization is insufficient. An item's variant (e.g. which device or person), event, time window, and plan-versus-actual status are part of scope. If either list lacks an explicit matching fact, abstain.

OLDER FACTS (zero-based indices):
${JSON.stringify(older)}

NEWER FACTS (zero-based indices):
${JSON.stringify(newer)}

Return only JSON: {"supersedes":boolean,"older_index":number|null,"newer_index":number|null,"reason":"short explanation of the exact shared property scope or why none matches"}. Choose supersedes true only for one exact current-property replacement; historical truth at the older date does not make a versioned current value still current.`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (older, newer) => {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const start = performance.now();
      const response = await llm.chat(
        [{ role: 'user', content: prompt(older, newer) }],
        {
          provider: 'openai',
          model: 'gpt-4o-mini',
          temperature: 0,
          maxTokens: 400,
        },
      );
      return {
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
  return { error: String(lastError) };
};
(async () => {
  let next = 0;
  let completed = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < selected.length) {
        const pair = selected[next++];
        const candidateFacts = facts(pair.candidate.text);
        const incomingFacts = facts(pair.incoming.text);
        const row = {
          id: pair.id,
          gold: pair.gold_conflict,
          candidate_facts: candidateFacts,
          incoming_facts: incomingFacts,
        };
        const candidateTime = new Date(
          pair.candidate.date.replace(/ \([A-Za-z]{3}\)/, ''),
        ).getTime();
        const incomingTime = new Date(
          pair.incoming.date.replace(/ \([A-Za-z]{3}\)/, ''),
        ).getTime();
        if (
          Number.isFinite(candidateTime) &&
          Number.isFinite(incomingTime) &&
          candidateTime < incomingTime &&
          candidateFacts &&
          incomingFacts
        )
          Object.assign(row, await call(candidateFacts, incomingFacts));
        else row.error = 'not older or missing independent extraction';
        fs.appendFileSync(output, `${JSON.stringify(row)}\n`);
        completed++;
        if (completed % 20 === 0)
          process.stdout.write(
            `dev alignment ${completed}/${selected.length}\n`,
          );
      }
    }),
  );
  process.stdout.write(`complete: ${completed} selected dev pairs\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
