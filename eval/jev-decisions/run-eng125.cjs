// ENG-125 classifier-only flag comparison. No database access.
// Usage: node run-eng125.cjs heldout off|on output.jsonl
const fs = require('node:fs');
const crypto = require('node:crypto');
require('ts-node/register/transpile-only');
require('dotenv').config({
  path: '../engram/.env',
  override: true,
  quiet: true,
});
const { LLMService } = require('../../src/llm/llm.service');
const {
  DedupClassificationService,
} = require('../../src/deduplication/automated/dedup-classification.service');
const {
  OpenAIEmbedProvider,
} = require('../../src/embedding/openai-embed.provider');

const [set, arm, out] = process.argv.slice(2);
if (set !== 'heldout' || !['off', 'on'].includes(arm) || !out)
  throw new Error('Usage: node run-eng125.cjs heldout off|on output.jsonl');
const inputs = {
  dev: [
    'data/pairs.json',
    '8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c',
  ],
  heldout: [
    'fixtures/heldout-v3.json',
    '3a2d03a1cd98125a5772e74b0e87e3165e313dcd7ef8bd3d81c7031f60277072',
  ],
};
const raw = fs.readFileSync(
  require('node:path').join(__dirname, inputs[set][0]),
);
if (crypto.createHash('sha256').update(raw).digest('hex') !== inputs[set][1])
  throw new Error('Input hash mismatch');
const data = JSON.parse(raw);
const pairs =
  set === 'dev'
    ? data.pairs.map((p) => ({
        id: p.id,
        cluster: p.question_id,
        gold: p.gold_conflict,
        candidate: p.candidate.text,
        incoming: p.incoming.text,
        candidateDate: p.candidate.date,
        incomingDate: p.incoming.date,
        candidateFirst: p.candidate_first,
      }))
    : data.items.flatMap((item, i) =>
        [item.old, ...item.stillTrue].map((candidate, j) => ({
          id: `${item.id}:${j}`,
          cluster: item.id,
          gold: j === 0,
          candidate,
          incoming: item.incoming,
          candidateDate: data.candidateDate,
          incomingDate: data.incomingDate,
          candidateFirst: (i + j) % 2 === 0,
        })),
      );
const credential =
  /(api[_ -]?key|password|passwd|secret|token|credential|sk-[A-Za-z0-9]{10,}|bearer\s+[A-Za-z0-9._-]{10,})/i;
if (pairs.some((p) => credential.test(p.candidate + p.incoming)))
  throw new Error('Credential item detected');
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required');
process.env.DEDUP_SUPERSESSION_ENABLED = arm === 'on' ? 'true' : 'false';
const config = {
  get: (key, fallback) =>
    ({
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'gpt-4o-mini',
      OPENAI_EMBED_MODEL: 'text-embedding-3-small',
    })[key] ?? fallback,
};
const llm = new LLMService(config);
const embedder = new OpenAIEmbedProvider(config);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retry = async (fn) => {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!/429|500|502|503|504/.test(String(error))) break;
      await sleep(1000 * 2 ** i);
    }
  }
  throw last;
};
const cosine = (a, b) => {
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return dot / Math.sqrt(aa * bb);
};
const parseDate = (s) => new Date(s.replace(/ \([A-Za-z]{3}\)/, ''));

(async () => {
  const texts = [...new Set(pairs.flatMap((p) => [p.candidate, p.incoming]))];
  const vectors = new Map();
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const embedded = await retry(() => embedder.embed(batch));
    batch.forEach((t, j) => vectors.set(t, embedded[j]));
  }
  const previous = fs.existsSync(out)
    ? fs
        .readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
    : [];
  const completed = new Set(previous.filter((r) => !r.error).map((r) => r.id));
  const todo = pairs.filter((p) => !completed.has(p.id));
  let next = 0;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (next < todo.length) {
        const p = todo[next++];
        const [a, b] = p.candidateFirst
          ? [p.candidate, p.incoming]
          : [p.incoming, p.candidate];
        const [dateA, dateB] = p.candidateFirst
          ? [p.candidateDate, p.incomingDate]
          : [p.incomingDate, p.candidateDate];
        const row = {
          id: p.id,
          cluster: p.cluster,
          gold: p.gold,
          arm,
          set,
          similarity: cosine(vectors.get(a), vectors.get(b)),
        };
        const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
        const meteredLlm = {
          getProvider: (provider) => llm.getProvider(provider),
          chat: async (...args) => {
            const response = await llm.chat(...args);
            usage.promptTokens += response.usage?.promptTokens ?? 0;
            usage.completionTokens += response.usage?.completionTokens ?? 0;
            usage.calls++;
            return response;
          },
        };
        const classifier = new DedupClassificationService({}, meteredLlm);
        const start = performance.now();
        try {
          const result = await retry(() =>
            classifier.classifyPair(
              a,
              b,
              row.similarity,
              'INFERRED',
              'INFERRED',
              parseDate(dateA),
              parseDate(dateB),
            ),
          );
          row.label = result.classification;
          row.confidence = result.confidence;
          row.predicted =
            arm === 'on' && row.label === 'SUPERSEDES' && row.confidence >= 0.8;
        } catch (error) {
          row.error =
            /429|500|502|503|504/.exec(String(error))?.[0] ||
            error?.constructor?.name ||
            'Error';
          row.error_detail = String(error).slice(0, 160);
        }
        row.latency_ms = performance.now() - start;
        row.prompt_tokens = usage.calls ? usage.promptTokens : null;
        row.completion_tokens = usage.calls ? usage.completionTokens : null;
        row.api_calls = usage.calls;
        fs.appendFileSync(out, JSON.stringify(row) + '\n');
        if (next % 50 === 0) console.log(set, arm, next, '/', todo.length);
      }
    }),
  );
  console.log('complete', set, arm, todo.length, 'new attempts');
})().catch((error) => {
  console.error(
    'Run failed:',
    error?.constructor?.name || 'Error',
    /401|403|429|500|502|503|504/.exec(String(error))?.[0] || '',
  );
  process.exitCode = 1;
});
