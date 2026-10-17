# ENG-122 dev-only verifier revision

The first held-out v1 result remains a failed classifier gate: 23/60 false supersessions. None of the revisions below were run on v1. The new check was designed and measured against the previously seen 70-item dev set only. [ENG-125](/ENG/issues/ENG-125) assigns Engram Eval an independent blinded replacement set; the new result must be reported on its first run, pass or fail.

## Dev evidence and change

The first flag-on classifier had five false supersessions among 350 dev negatives. Two treated a weekly writing target as replaced by a later short-story count; another treated consideration of a Fitbit Inspire HR as replaced by use of a Fitbit Charge 3. Separate travel plans and a wake-up routine produced the other false positives. These are different properties, plans, or continuing facts. The flag-on path now asks a second `gpt-4o-mini` call to check the same subject, same property, latest value, and exact quoted evidence. It runs only when the first call proposes `SUPERSEDES` at confidence at least 0.8. A missing date, ambiguous or malformed answer, unmatched quote, or negative evidence downgrades to a queued `OVERLAPPING` candidate at confidence 0.5. Flag off never invokes this check.

The first verifier wording was too strict about older historical statements: it retained 18 true positives and one false positive (F1 0.404494, 478 total API calls). A dev-only probe of 12 rejected pairs showed it marked evolving counts, durations, personal bests, and recurring schedules as `replacement=false` even when the newer value was the latest known one. The revised wording treats those as versioned properties while continuing to reject different people, properties, trips, projects, events, and prospective purchases.

## Current dev-only measurement

Input: `data/pairs.json`, SHA-256 `8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c`. The off arm is the previously measured raw `results/dev-off.jsonl`; the current on arm is `results/dev-on-verified.jsonl`. Both have 420 valid final rows and zero invalid calls. The on arm made 480 OpenAI chat calls, including 60 second checks. The `--dev-verified` scorer uses 2,000 item-cluster bootstrap resamples with seed 7, the same fixed threshold, and Wilson intervals for the harm rate.

| Arm               |  TP |  FP |  FN |  TN | Precision | Recall | F1 [95% cluster CI]  | False supersessions [95% Wilson CI] |
| ----------------- | --: | --: | --: | --: | --------: | -----: | -------------------- | ----------------------------------- |
| Flag off          |   0 |   0 |  70 | 350 |     0.000 |  0.000 | 0.000 [0.000, 0.000] | 0/350 [0.000, 0.011]                |
| Flag on, verified |  36 |   1 |  34 | 349 |     0.973 |  0.514 | 0.673 [0.566, 0.772] | 1/350 [0.001, 0.016]                |

Paired on-minus-off F1 is +0.673 [0.566, 0.772]. The one remaining dev false supersession is `08e075c7:dis1`, which compares consideration of one tracker with ownership of another. The point estimate improved the dev harm rate, but this small development sample does not predict the blind result reliably.

Median / p95 classifier latency is 930.859 / 1740.031 ms off and 918.758 / 1927.614 ms on with five concurrent pair workers. Mean input/output tokens per pair are 324.164 / 69.555 off and 574.962 / 67.702 on. At [OpenAI's published `gpt-4o-mini` rates](https://developers.openai.com/api/docs/models/gpt-4o-mini) of $0.15 per million input and $0.60 per million output tokens, estimated classifier cost per pair is $0.00009036 off and $0.00012687 on; these exclude embedding calls and any cached-input discount. Total estimated on-arm chat cost for 420 pairs is $0.05328360.

Reproduce the dev table with `node eval/jev-decisions/score-supersession.mjs --dev-verified`. The raw first verifier wording is preserved in `results/dev-on-verified-v1.jsonl`. To repeat model calls, use `node eval/jev-decisions/run-supersession.cjs dev on <output.jsonl>` with a valid OpenAI key. The runner checks the dev input hash and rejects credential-pattern items before sending anything. No database was used for the classifier measurement. The flag remains default off until a new independent held-out classifier gate and a database integration check pass; there is no end-answer lift claim.

## Pin for Eval's new independent set

After dev-only tuning and before any new held-out call, shared worktree HEAD was `ee8bfcbaea91b36bfc575f4d02d1c962e774c859`; the uncommitted classifier SHA-256 is `28b9275c53e2be327fa886e3a04a0a03fcef7c1fcb0f54d0373dbcb090f85378`, resolver `792dd09572865af4a4b3a0c2ac0066a90b84a63b833963d8c9e29b9b0d6d0153`, lineage rollback `01e4437fd13383476d46c0b1182779709b5afe79c295ebdbe51922d01b3cbc02`, runner `23048a363dd0dcc09e6fda3ec328c5df9f7f3fea7c4db7d11c80bb7b86878444`, and scorer `9feed5650d00d1ff425718a4e14d95846c2509ec38b61ee19b21224dc151a89d`. The dev-on raw SHA-256 is `e0ff078b6ca18aaa890968e9a46733d41e04c79c6b91a4924ffa9696e11ee30c`, and dev-off is `3fc8058e246637b2543b53ca5d396873bffce9946cb9a1aaaed31d1ab342a091`. This is a source-file pin because this role may not commit. Verify hashes before any new held-out run; report a mismatch rather than silently changing the arm. The unchanged harm gate remains at most one false supersession among 60 still-true negatives, with F1 at least 0.60 and a paired cluster-bootstrap F1 CI lower bound above zero.
