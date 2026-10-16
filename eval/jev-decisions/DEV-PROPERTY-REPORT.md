# ENG-122 dev-only current-property check

Date: 2026-10-15. This is a **dev** iteration after held-out v3 failed its
false-supersession gate. V3 is seen diagnostic material and was not run again.
The frozen 420-pair / 70-cluster ENG-19 dev set remains SHA-256
`8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c`.

The prior verifier incorrectly superseded one dev pair in which the old memory
considered buying a device and the later memory reported using a different
device. Both claims can remain true. The verifier now asks whether both claims
can coexist as current claims about their respective properties and requires
an explicit `can_coexist_as_current: false` result before emitting
`SUPERSEDES`. The classifier's first stage, 0.8 confidence threshold, resolver,
default-off flag, and lineage code are unchanged. Rejection still queues
`OVERLAPPING` at 0.5. The model remains `gpt-4o-mini`, with first-stage
temperature 0.2 / 512 max tokens and verifier temperature 0 / 384 max tokens.

## Dev result, 420 pairs / 70 clusters

| Arm                       |  TP |  FP |  FN |  TN | F1 [95% cluster bootstrap CI]  | False supersessions [Wilson 95% rate CI] |
| ------------------------- | --: | --: | --: | --: | ------------------------------ | ---------------------------------------- |
| Flag off (preserved raw)  |   0 |   0 |  70 | 350 | 0.000 [0, 0]                   | 0/350 [0, 0.01086]                       |
| Prior verifier            |  36 |   1 |  34 | 349 | 0.67290 [0.56566, 0.77193]     | 1/350 [0.00050, 0.01600]                 |
| Current-property verifier |  31 |   0 |  39 | 350 | **0.61386 [0.49462, 0.71560]** | **0/350 [0, 0.01086]**                   |

The paired flag-on minus flag-off dev F1 difference is +0.61386 [0.49462,
0.71560], using 2,000 item-cluster bootstrap resamples with seed 7. The
current-property verifier removed the prior false positive but lost eight
prior true positives and gained three other true positives, for a net loss of
five. This is a safety/recall tradeoff, not proof of unseen safety.

The new on arm had 420 valid final rows, zero invalid final rows, and 420 raw
attempts. It had p50/p95 classification latency 929.892/1,958.501 ms; 249,571
prompt tokens and 28,957 completion tokens; estimated chat cost $0.05480985
total or $0.00013050 per pair. The preserved off arm had p50/p95
930.859/1,740.031 ms, 136,149 prompt and 29,213 completion tokens, and
estimated $0.03795015 total or $0.00009036 per pair. Estimates exclude
embedding calls and cached-input discounts.

Raw on attempts: `results/dev-on-property.jsonl`, SHA-256
`39d735b6aff05313e5d3010f5ea3ce3b78786a4256ff4ec29ddd32171d65581f`.
Reproduce scores without model or database calls with
`node eval/jev-decisions/score-supersession.mjs --dev-property`.

## Pin before any new independent holdout

Shared HEAD when measured: `52b96de1750d1a9eac1559d214763743a3f81e91`.
File SHA-256 values:

- Classifier: `05aa974e4600a45147a3736da553b725370ddc474467688cb1e92a6dacb53637`
- Resolver: `792dd09572865af4a4b3a0c2ac0066a90b84a63b833963d8c9e29b9b0d6d0153`
- Lineage: `01e4437fd13383476d46c0b1182779709b5afe79c295ebdbe51922d01b3cbc02`
- Runner: `297d44c189fce93a2e328359920fec89da14a15d218140f80aa180a59c70831b`
- Scorer: `873f8ef8165394fe0ddc745222d49b3bf476e699bf7e90f44ff70de321b043be`

The unchanged held-out falsifier is flag-on F1 >= 0.60, paired F1-difference
95% cluster-bootstrap lower bound > 0, and no more than **1/60** false
supersessions among still-true negatives. The new independent holdout must be
frozen before any run, use no v1/v3 item or pair, and be measured once off/on.
If it fails, retain the result and keep the flag off. Do not infer LongMemEval
answer lift from classifier scores.
