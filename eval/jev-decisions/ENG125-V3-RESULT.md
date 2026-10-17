# ENG-125 first replacement held-out classifier result — harm gate failed

Date: 2026-10-15. This is the **first and only** classifier run on replacement held-out v3. The original 24-cluster authoring set (v2) was frozen before Temporal's pin and never run; v3 selected its first 20 clusters in original order to retain the preregistered 60-negative denominator. No v1 item or seen dev pair was reused. V3 fixture SHA-256: `3a2d03a1cd98125a5772e74b0e87e3165e313dcd7ef8bd3d81c7031f60277072`.

Before **each** arm, the fixture and Eval runner hashes and Temporal's classifier, resolver, original runner, and original scorer hashes matched the freeze record in `HELDOUT-V3-FREEZE.md`. Temporal's pin HEAD was `ee8bfcbaea91b36bfc575f4d02d1c962e774c859`; shared HEAD when this run started was `52b96de1750d1a9eac1559d214763743a3f81e91` because unrelated eval files had changed. The pinned classifier/resolver/runner/scorer bytes did not change. Both arms used `gpt-4o-mini`; only the default-off versus enabled supersession flag changed. The Eval runner SHA-256 was `6c54515720f721b3f84c0ac74f9dc870eb00eb6579b41748b1ffa9692aa201d2`; it copied the pinned runner with only the CLI restriction and fixture path/hash changed. All 80 candidates per arm were presented, without an embedding-similarity filter.

## First-run measurement

| Arm      |  TP |    FP |  FN |  TN | Precision | Recall | F1 [95% item-cluster bootstrap CI] | False supersessions [95% count CI] | Harm rate [95% Wilson CI] |
| -------- | --: | ----: | --: | --: | --------: | -----: | ---------------------------------- | ---------------------------------- | ------------------------- |
| Flag off |   0 |     0 |  20 |  60 |     0.000 |  0.000 | 0.000 [0.000, 0.000]               | 0/60 [0, 0]                        | 0.000 [0.000, 0.060]      |
| Flag on  |  19 | **3** |   1 |  57 |     0.864 |  0.950 | **0.905 [0.818, 0.976]**           | **3/60 [0, 6]**                    | **0.050 [0.017, 0.137]**  |

Paired flag-on minus flag-off F1: **+0.905 [0.818, 0.976]**. Percentile intervals use 2,000 resamples of the 20 entire item clusters with seed 7. The false-supersession count interval resamples 20 clusters, so its unit is false supersessions per 60 negative opportunities. Both arms had **80 valid final rows, 0 invalid rows, and 80 raw attempts**. No failed call was discarded. Flag on made 120 metered chat calls, including 40 second verifier calls; flag off made 80. False-positive pair IDs: `clinic-hours:2`, `recycling-route:2`, `gallery-price:2`; false negative: `book-club-pick:0`.

| Cost and latency                     |                  Flag off |                   Flag on |
| ------------------------------------ | ------------------------: | ------------------------: |
| Classifier latency p50 / p95         |    964.547 / 1,253.713 ms |  1,328.667 / 1,966.686 ms |
| Prompt tokens total / per pair       |          19,110 / 238.875 |          46,798 / 584.975 |
| Completion tokens total / per pair   |            5,088 / 63.600 |            6,921 / 86.513 |
| Metered chat tokens total            |                    24,198 |                    53,719 |
| Estimated chat cost total / per pair | $0.00591930 / $0.00007399 | $0.01117230 / $0.00013965 |

The total estimated classifier chat cost for both arms is **$0.01709160**, using the [published `gpt-4o-mini` rates](https://developers.openai.com/api/docs/models/gpt-4o-mini) of $0.15 per million input tokens and $0.60 per million output tokens. This excludes embedding calls and any cached-input discount. Token injection per recall is not applicable: this was a classifier-only run with no memory recall.

## Gate disposition and limits

**Failed:** three of 60 still-true facts were falsely superseded, exceeding the preregistered maximum of one. The F1 and paired-CI criteria passed, but the harm criterion alone fails the classifier gate. Do not enable the flag, run an end-to-end LongMemEval knowledge-update A/B, tune against v3 and rerun it as unseen, or claim end-answer lift. No database row was changed in this classifier-only measurement; flag-off row immutability and reversible supersession remain **untested**, not passed. The flag remains default off.

Raw attempts are preserved in `results/eng125-v3-off.jsonl` (SHA-256 `a729a4ac64bc523213fb134afbd85007389823813c5405f2dbc493bbb70f1108`) and `results/eng125-v3-on.jsonl` (SHA-256 `be682ffd435db755604fb481c08ccefadfac81c1dd42397ec4afc2ef7d5be8e4`). Recompute without model or database calls using `node eval/jev-decisions/score-eng125.mjs` (SHA-256 `f564064bd13ddef6ef4c4c50a085a8212ff69e38e5ca7054c42d730f4c8688b6`). The runner performed no database access or Jev call, and no production or local Engram DB write occurred.
