// Run the actual dedup classifier on the frozen ENG-19 pairs with the deployed
// OpenAI chat and primary embedding models. Requires OPENAI_API_KEY in env.
const fs = require('node:fs');
const crypto = require('node:crypto');
require('ts-node/register/transpile-only');
const { LLMService } = require('../../src/llm/llm.service');
const {
  DedupClassificationService,
} = require('../../src/deduplication/automated/dedup-classification.service');
const {
  OpenAIEmbedProvider,
} = require('../../src/embedding/openai-embed.provider');

const DATA = new URL('./data/pairs.json', `file://${__filename}`).pathname;
const OUT = process.argv[2] || 'data/true-baseline.jsonl';
const HASH = '8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c';
const raw = fs.readFileSync(DATA);
if (crypto.createHash('sha256').update(raw).digest('hex') !== HASH)
  throw new Error('pairs.json hash mismatch');
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
const data = JSON.parse(raw);
const credential =
  /(api[_ -]?key|password|passwd|secret|token|credential|sk-[A-Za-z0-9]{10,}|bearer\s+[A-Za-z0-9._-]{10,})/i;
if (data.pairs.some((p) => credential.test(p.candidate.text + p.incoming.text)))
  throw new Error('Credential item detected; remove it before running');

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
const classifier = new DedupClassificationService({}, llm);
const embedder = new OpenAIEmbedProvider(config);
const texts = [
  ...new Set(data.pairs.flatMap((p) => [p.candidate.text, p.incoming.text])),
];
const vectors = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retry = async (fn) => {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!/429|500|502|503|504/.test(String(error))) break;
      await sleep(1000 * 2 ** attempt);
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
let completed = 0;

(async () => {
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const embedded = await retry(() => embedder.embed(batch));
    batch.forEach((text, j) => vectors.set(text, embedded[j]));
    console.log('embedded', Math.min(i + 32, texts.length), '/', texts.length);
  }
  const done = new Set(
    fs.existsSync(OUT)
      ? fs
          .readFileSync(OUT, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line).id)
      : [],
  );
  const todo = data.pairs.filter((p) => !done.has(p.id));
  let next = 0;
  await Promise.all(
    Array.from({ length: Number(process.env.CONC || 5) }, async () => {
      while (next < todo.length) {
        const p = todo[next++];
        const [c1, c2] = p.candidate_first
          ? [p.candidate.text, p.incoming.text]
          : [p.incoming.text, p.candidate.text];
        const sem = cosine(vectors.get(c1), vectors.get(c2));
        const started = performance.now();
        const row = { id: p.id, sem, system: 'openai/gpt-4o-mini' };
        try {
          const result = await retry(() =>
            classifier.classifyPair(c1, c2, sem, 'INFERRED', 'INFERRED'),
          );
          row.label = result.classification;
          row.confidence = result.confidence;
        } catch (error) {
          row.error =
            /429|500|502|503|504/.exec(String(error))?.[0] ||
            error?.constructor?.name ||
            'Error';
        }
        row.latency_ms = performance.now() - started;
        fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
        if ((done.size + ++completed) % 25 === 0)
          console.log(
            'classified',
            done.size + completed,
            '/',
            data.pairs.length,
          );
      }
    }),
  );
  console.log('complete', done.size + completed, '/', data.pairs.length);
})().catch((error) => {
  console.error(
    'Baseline run failed:',
    error?.constructor?.name || 'Error',
    /401|403|429|500|502|503|504/.exec(String(error))?.[0] || '',
  );
  process.exitCode = 1;
});
