# ENG-122 classifier-only result: held-out harm gate failed

Run date: 2026-10-15. Inputs and the falsifier were frozen in `HELDOUT-V1-FREEZE.md` before held-out calls. The seen dev input SHA-256 is `8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c`; synthetic held-out v1 is `f8865f457e3c03bb3ca2e03caae835ebc1e7c94d6582cba282e32fd3ebca2e6d`. First held-out code and runner hashes are recorded in that freeze document. The shared worktree had uncommitted changes, so the file hashes, not HEAD alone, pin the evaluated code.

The flag `DEDUP_SUPERSESSION_ENABLED` is default off. Flag on adds `SUPERSEDES`, then resolves a predicted pair only at confidence >= 0.8. Resolution sets the older row's `supersededById` and `supersededAt`, retains both rows, and records a `SUPERSEDE` merge event. The lineage rollback clears that link only when it still points to this event's newer row. These row effects have unit tests, not a database integration result. Flag off rejects the new label during classification and queues a previously classified `SUPERSEDES` candidate without touching memories.

## Classifier metrics

The scorer groups pairs by question/item, draws 2,000 item-cluster bootstrap samples with seed 7, and reports percentile 95% intervals. A separate Wilson 95% interval covers the false-supersession rate. Every final scored row has a valid classifier result; raw invalid attempts remain in the JSONL. All pairs were presented to the classifier, independent of candidate detection.

| Split                            | Flag |  TP |  FP |  FN |  TN | Precision | Recall | F1 [95% CI]          | False supersessions [95% Wilson CI] |
| -------------------------------- | ---- | --: | --: | --: | --: | --------: | -----: | -------------------- | ----------------------------------- |
| Dev, 420 pairs / 70 items        | Off  |   0 |   0 |  70 | 350 |     0.000 |  0.000 | 0.000 [0.000, 0.000] | 0/350, 0.000 [0.000, 0.011]         |
| Dev                              | On   |  55 |   5 |  15 | 345 |     0.917 |  0.786 | 0.846 [0.780, 0.906] | 5/350, 0.014 [0.006, 0.033]         |
| Held-out v1, 80 pairs / 20 items | Off  |   0 |   0 |  20 |  60 |     0.000 |  0.000 | 0.000 [0.000, 0.000] | 0/60, 0.000 [0.000, 0.060]          |
| Held-out v1                      | On   |  20 |  23 |   0 |  37 |     0.465 |  1.000 | 0.635 [0.597, 0.678] | 23/60, 0.383 [0.271, 0.510]         |

Paired flag-on minus flag-off F1: dev +0.846 [0.780, 0.906]; held-out +0.635 [0.597, 0.678]. The held-out F1 and paired CI pass their preregistered thresholds, but **23/60 false supersessions fail the harm gate of at most 1/60**. This is a failed held-out result. Do not enable the flag, claim LongMemEval answer lift, or tune and rerun this held-out version as unseen data.

## Latency, tokens, and estimated classification cost

| Split    | Flag | Latency p50 / p95 (ms) | Mean input / output tokens | Estimated USD per final classification | Raw attempts / failed attempts |
| -------- | ---- | ---------------------: | -------------------------: | -------------------------------------: | -----------------------------: |
| Dev      | Off  |     930.859 / 1740.031 |           324.164 / 69.555 |                            $0.00009036 |                        420 / 0 |
| Dev      | On   |     917.080 / 1183.838 |           517.164 / 59.010 |                            $0.00011298 |                       448 / 28 |
| Held-out | Off  |     907.940 / 1111.598 |           231.288 / 60.650 |                            $0.00007108 |                         80 / 0 |
| Held-out | On   |     923.471 / 1209.707 |           424.288 / 59.350 |                            $0.00009925 |                         80 / 0 |

These estimates use $0.15 per million input tokens and $0.60 per million output tokens for `gpt-4o-mini` as listed in the [official model pricing](https://developers.openai.com/api/docs/models/gpt-4o-mini). They exclude embedding calls and any cached-input discount. The dev-on raw file has 448 attempts because 28 invalid-label responses from the dev prompt/parser iterations were retained and retried; the final row per ID is scored. Estimated spend across all attempts in that file is $0.05071170, compared with $0.04745175 for one final classification per pair. A separate initial dev prompt run (`dev-on-v0.jsonl`) produced 0/70 true positives and was retained. No held-out call was made until dev-only tuning ended.

## Interpretation and reproduction

On the held-out negatives, the classifier confused related facts about a different property, person, or time with a replacement. For example, it marked the still-true `home-city:2` and `job-title:1` candidates as superseded. This is an inference from the pair IDs and labels; no manual audit of every error has been completed. The input is synthetic, not a blinded real-use sample. The candidate-detection stage and database mutation path were not exercised in this classifier run. No production or local database write occurred.

Raw data are in `results/dev-{off,on}.jsonl` and `results/heldout-{off,on}.jsonl`; `dev-on-v0.jsonl` and `dev-on-v1.jsonl` preserve earlier dev iterations. Recompute the table with `node eval/jev-decisions/score-supersession.mjs`. Repeating the model calls requires a valid OpenAI key and `node eval/jev-decisions/run-supersession.cjs <dev|heldout> <off|on> <output.jsonl>` from the worktree root. The runner verifies both input hashes and scans all pair text for credential patterns before sending any request. It does not access a database. **Do not rerun held-out v1 to select a new rule.** A revised classifier needs dev-only design work and a separately preregistered, independent held-out set.

The SHA-256 hashes of the four scored raw files are, in order dev-off, dev-on, heldout-off, heldout-on: `3fc8058e246637b2543b53ca5d396873bffce9946cb9a1aaaed31d1ab342a091`, `3e5ab3ef20bb2e58d5a3f5c5fda1358316eb43ceba777d71f15bb9df5d64ec6a`, `5a34e71de56f52a0166f3e913a65495955d628f3f2c4896f7418bb5da8c5ba0c`, `49fa55e79930320dd0f28ccf383b712a343960c559c041ed8ac81f9c48e05aa7`.
