# ENG-127 independent v4 classifier holdout: harm gate failed

Date: 2026-10-15. This is the first and only flag-off/on classifier comparison on the 20-cluster, 80-pair v4 fixture. The fixture was authored independently from fictional cases, frozen before calls at SHA-256 `f47958036d493bb49c85778b325fa466838e1a8e38fad17c39de7e63102cc447`, and kept private until both arms finished. It is now published at `fixtures/heldout-v4.json` with identical bytes. See `ENG127-V4-FREEZE.md` for construction, leakage checks, source hashes, exact runner/scorer copy diffs, protocol, and unchanged falsifier.

All eight frozen hashes (classifier, resolver, lineage, original runner, original scorer, fixture-only runner, fixture-only scorer, and input) matched immediately before **each** arm. Each runner command exited 0 and appended 80 raw attempts. The flag was off for the first arm and on for the second; `gpt-4o-mini`, inputs, dates, orientation, 0.8 action threshold, and pinned source bytes were the same. No database or Jev call occurred, and the classifier-only runner performed no row mutations.

## First-run measurement

| Arm      |  TP |    FP |  FN |  TN | Precision | Recall | F1 [95% item-cluster bootstrap CI] | False supersessions [95% count CI] | Harm rate [95% Wilson CI] |
| -------- | --: | ----: | --: | --: | --------: | -----: | ---------------------------------: | ---------------------------------: | ------------------------: |
| Flag off |   0 |     0 |  20 |  60 |     0.000 |  0.000 |               0.000 [0.000, 0.000] |                        0/60 [0, 0] |      0.000 [0.000, 0.060] |
| Flag on  |  20 | **6** |   0 |  54 |     0.769 |  1.000 |           **0.870 [0.800, 0.952]** |                   **6/60 [2, 10]** |  **0.100 [0.047, 0.201]** |

Paired flag-on minus flag-off F1: **+0.869565 [0.800000, 0.952381]**. Percentile intervals resample the 20 whole item clusters 2,000 times with seed 7; each resample carries all four pairs of its selected clusters. The count interval is false supersessions per 60 resampled negative opportunities. The Wilson interval uses six false supersessions in 60 negative pairs. The six false-positive IDs are `bird-count-method:2`, `postage-weight:1`, `cistern-capacity:2`, `drone-altitude:1`, `ball-inflation:1`, and `solar-charge-limit:1`; there were no false negatives. Every pair had a valid final classification: **80/80 valid, zero invalid, 80 raw attempts per arm** (160 total). No failed attempt was discarded.

| Cost and latency                     |                  Flag off |                   Flag on |
| ------------------------------------ | ------------------------: | ------------------------: |
| Classification latency p50 / p95     |  1,017.603 / 1,252.303 ms |  1,089.595 / 2,162.400 ms |
| Prompt tokens total / per pair       |          19,129 / 239.113 |          47,798 / 597.475 |
| Completion tokens total / per pair   |            5,149 / 64.363 |            7,106 / 88.825 |
| Total metered chat tokens            |                    24,278 |                    54,904 |
| Metered chat calls                   |                        80 |                       110 |
| Estimated chat cost total / per pair | $0.00595875 / $0.00007448 | $0.01143330 / $0.00014292 |

Combined estimated chat cost: **$0.01739205 for both arms** (190 metered calls, 79,182 tokens). Estimates use $0.15 per million prompt and $0.60 per million completion tokens, and exclude embedding calls and any cached-input discount. Tokens injected per recall are not applicable because no memory recall occurred.

## Gate and reproducibility

**Failed:** 6 of 60 still-true facts were falsely superseded, exceeding the frozen maximum of **1 of 60**. The F1 and paired-CI criteria passed, but the harm criterion fails the classifier gate. Keep the flag default off; do not enable it, run an end-to-end LongMemEval knowledge-update A/B, or claim end-answer Memory Lift from this result. The isolated database integration evidence for row immutability and reversibility is separate; this run measures only classifier decisions. V4 is now seen and must not be tuned and rerun as unseen.

Raw JSONL attempts: `results/heldout-v4-off.jsonl` SHA-256 `e7eec6742c7ae50452dba376864c594621a8a782cd1f227456c806d4c6de6a5d`, and `results/heldout-v4-on.jsonl` SHA-256 `272c0d9be8f58ce5befe49bcd5a8ef6873171c0fc4eb1ed84d61e568b6190f61`. Recompute without model or database calls with `node eval/jev-decisions/score-eng127.mjs`. That scorer reads the frozen input from `~/.engram-team/scorecard/holdouts/eng127-v4.json`; on another checkout, copy the published identical fixture to that path first. The scorer SHA-256 is `fc01ffc741b8085d543a7bcefb270904795ff9b16a79d6cdfd4a64ed59ad7530`; the original pinned scorer and exact copy diff are listed in the freeze document.
