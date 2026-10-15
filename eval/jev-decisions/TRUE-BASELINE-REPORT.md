# ENG-19 true classifier baseline (ENG-115)

Run: 2026-10-15. Input: `data/pairs.json`, SHA-256
`8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c`.
This is a public LongMemEval-S-derived development set: 70 question items, six
pairs per item, 420 pairs, 70 gold updates. The credential-item scan found zero
matches before any external request. No database was used.

## Environment and method

- Railway production variables for service `proud-purpose` show
  `OPENAI_API_KEY` set, `ANTHROPIC_API_KEY` absent, and default chat provider
  OpenAI. The current classifier therefore falls back from its requested
  Anthropic provider to OpenAI. The live local checkout's `.env` has the same
  key-presence and routing pattern. These are configuration-derived routing
  conclusions, not observations of a live classification request. Production
  `/health` returned HTTP 200 after a redirect; no production write was made.
- The classifier explicitly requests `gpt-4o-mini`, temperature 0.2, and
  `maxTokens: 512`. This run calls its `classifyPair` method through the real
  `LLMService` and `OpenAIProvider`, including the same prompt and JSON parser.
  The OpenAI key was read at runtime from the live local checkout's `.env` and
  was neither printed nor copied into an artifact.
- Production's `cloud-ensemble` embedding service uses `openai-small`
  (`text-embedding-3-small`) for single-vector operations. This run used the
  repository's `OpenAIEmbedProvider` with that model on 486 distinct texts,
  then cosine similarity for each pair. Both pair memories were assigned
  `INFERRED` source authority, giving the same 0.5 authority hint as the
  previous comparator; the frozen pair file does not contain source labels.
- All 420 classifier calls returned a valid label. Results are in
  `data/true-baseline.jsonl` and `data/true-baseline-results.json` (local,
  ignored data files). Classification latency with five concurrent requests:
  p50 1000.440 ms; p95 1946.721 ms; mean 1116.313 ms. API token and dollar
  costs were not captured.

## Paired results

| System                                                             |  TP |  FP |  FN |  TN |       F1 | 95% item-cluster bootstrap CI |
| ------------------------------------------------------------------ | --: | --: | --: | --: | -------: | ----------------------------- |
| Engram deployed path: OpenAI `gpt-4o-mini`, real OpenAI embeddings |   0 |   0 |  70 | 350 | 0.000000 | [0.000000, 0.000000]          |
| Jev `noul > 0.5`                                                   |  42 |   1 |  28 | 349 | 0.743363 | [0.640777, 0.823529]          |

Paired F1 difference, Jev minus Engram: **+0.743363**, 95% item-cluster
bootstrap CI **[+0.640777, +0.823529]**. The CI resamples the 70 question
items 2,000 times with seed 7; all six pairs of an item stay together. The
Jev threshold is the fixed 0.5 threshold; no in-sample sweep selected it.

The Engram labels were 250 `RELATED`, 168 `OVERLAPPING`, and 2 `SUPPORTING`.
The prompt asks for contradictions, whereas the gold positives mark a newer
fact that updates an older one. For example, two different personal-best run
times at different dates can both be historically true. This is a plausible
reason for the zero conflict predictions, but the run alone does not prove
which part of the prompt or model causes them.

This measures the classifier on every frozen pair. The production candidate
detection stage applies its own similarity thresholds and may not send all
these pairs to classification. The score is therefore a classifier comparison,
not an end-to-end dedup pipeline score.

## Verification record

- The new routing spec failed before the fix: expected an OpenAI call, observed
  zero OpenAI calls while Anthropic was registered. After the fix, 9/9 targeted
  Jest tests passed. The Anthropic-only test verifies that no OpenAI model is
  sent to Anthropic when OpenAI is unavailable.
- `pnpm exec tsc --noEmit -p tsconfig.json`: exit 0.
- `pnpm exec prettier --write` on the five changed source, script, and report
  files: exit 0.
- `pnpm exec eslint` on the four source and script files: exit 0, zero warnings.
- First Jest attempt combined `--runInBand` with the package's `--maxWorkers=2`
  and failed at CLI argument validation. The second attempt failed because
  Watchman's socket path was too long; subsequent runs used `--watchman=false`.
- The first baseline attempt used the injected `OPENAI_API_KEY` and failed at
  the embedding request; it produced no rows. A separate embedding probe with
  that key returned HTTP 401. The valid local key returned HTTP 200 and
  completed 420/420 rows with zero API or parse errors.

Reproduction: load a valid `OPENAI_API_KEY` into the process, run
`node run-true-baseline.cjs data/true-baseline.jsonl`, then
`node score-true-baseline.mjs` from `eval/jev-decisions`. The runner checks the
input hash and rejects credential-related pair text before sending requests.
