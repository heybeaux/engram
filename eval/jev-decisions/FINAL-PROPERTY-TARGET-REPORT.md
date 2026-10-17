# ENG-122 final dev attempt: property-targeted evidence

## Protocol frozen before the model run

Date: 2026-10-16. This is the **one remaining dev-only attempt** authorized
by the Lead after the v1, v3, and v4 blind harm failures and both atomic-fact
dev failures. Do not tune the prompt, thresholds, or scorer after seeing this
attempt's output. The runner refuses to overwrite its raw result. This report
will receive the result below without changing this protocol.

Inputs: seen `data/pairs.json` SHA-256
`8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c`;
first-stage `results/dev-on.jsonl` SHA-256
`3e5ab3ef20bb2e58d5a3f5c5fda1358316eb43ceba777d71f15bb9df5d64ec6a`.
The latter proposes 60/420 pairs (55 gold updates, five negatives). All other
360 dev pairs are scored negative. The product classifier file remains SHA-256
`05aa974e4600a45147a3736da553b725370ddc474467688cb1e92a6dacb53637`;
its supersession flag defaults off and no product code changes for this run.

Pinned dev-only runner `run-property-target.cjs` SHA-256
`3ef7707915c8a6a107b83991f3b6e16dee33ead24d3f6c6a15e58524344c68b0`;
scorer `score-property-target.mjs` SHA-256
`2b1b2f1fd6b0cfb924c9d22a585cfae7a56641f70de9f2a89653bde8454f56a2`.
The runner sends both memories in a selected pair to `gpt-4o-mini` at
temperature 0, maximum 700 output tokens. It asks for one exact quoted old
and new value, each with separate subject, target, property, scope, and mode
fields. The model must say the property and scope match and that both values
cannot coexist as current. The scorer also requires literal quotes and
values in their source memory, matching normalized subject/target/property/
scope and mode, different values, and an older candidate timestamp. Missing,
ambiguous, invalid, or failed output abstains. No similarity threshold is
changed. Credential-pattern matches cause the entire call set to stop before
any request; no Jev, held-out, database, or production data is involved.

The preregistered **dev pass bar** is flag-on F1 **at least 0.60** and exactly
**0/350 false supersessions** on dev true negatives. Score all 420 pairs with
2,000 whole-item-cluster bootstrap resamples, seed 7, for F1 and false-count
intervals; report the Wilson harm-rate interval, invalid attempts, p50/p95
model-call latency, tokens, and fixed-rate estimated chat cost. Flag off is the
unchanged no-supersession baseline, F1 0. If either dev bar fails, stop
iterating and hand a measured negative to the Lead for review. If both pass,
ask the Lead for an Eval-owned, freshly frozen v5 blind holdout before any
claim of safety or flag enablement. The v1, v3, and v4 sets are spent.

## Result

The first and only dev run completed after the preregistration comment
`4e48e49c-ca55-4b6c-89b7-ac64512c3a0b`. Raw JSONL SHA-256:
`52d92b288fcffc2bc346eb27ebca6f07d915888ada5a15f3e3a7766036f88ec2`.
The pinned scorer returned TP/FP/FN/TN **28/1/42/349**, F1
**0.565657 [0.442105, 0.672897]**. The paired flag-on minus flag-off F1 is
the same because flag off predicts no supersessions. False supersessions were
**1/350** (whole-cluster count CI **[0,3]**, Wilson 95% rate CI
**[0.000505,0.016005]**). The one false-positive pair ID is
`7401057b:dis0`. Both frozen dev bars fail: F1 is below 0.60 and the harm
count is above zero. This result cannot support another blind holdout or flag
enablement.

There were 60 selected raw rows, 58 model calls and two pre-call timestamp
abstentions, zero API-call failures, zero invalid model JSON, zero invalid
response shapes, and zero failed retry attempts. The call p50/p95 latencies
were **2,454.113/2,973.963 ms**. Prompt/completion tokens were
**35,785/11,850**; estimated extra chat cost was **$0.01247775** under the
fixed rates above, excluding the first-stage calls and embeddings. This is
model-call latency, not end-to-end classifier latency.

Reproduce from raw without model or database calls:

```bash
node eval/jev-decisions/score-property-target.mjs 52d92b288fcffc2bc346eb27ebca6f07d915888ada5a15f3e3a7766036f88ec2
```

No product file was changed, no held-out call was made, and no end-answer
knowledge-update lift is claimed. Per the preregistered stopping rule, this
classifier iteration stops here.
