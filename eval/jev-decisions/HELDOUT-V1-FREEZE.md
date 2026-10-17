# ENG-122 classifier split freeze (2026-10-15)

This record was written before any prompt, threshold, label, or pipeline change for ENG-122.

| Role                              | Artifact                   | SHA-256                                                            |                                               Size |
| --------------------------------- | -------------------------- | ------------------------------------------------------------------ | -------------------------------------------------: |
| Development only, previously seen | `data/pairs.json`          | `8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c` |                 70 items, 420 pairs (70 positives) |
| Held-out classifier set v1        | `fixtures/heldout-v1.json` | `f8865f457e3c03bb3ca2e03caae835ebc1e7c94d6582cba282e32fd3ebca2e6d` | 20 clusters, 80 pairs (20 positives, 60 negatives) |

The baseline repository HEAD at freeze was `089491eac33288246d4767b9f12a6f7f3cd2d880`. The development set came from public LongMemEval-S knowledge-update items and was already used in ENG-19 and ENG-115. The held-out set is separately authored synthetic material. It includes current-fact updates and three still-true, related candidates per item. Names and organizations are fictional. A credential-pattern scan found zero hits. No production or local database data was used.

## Fixed pair protocol

For each held-out item, compare `old` and each `stillTrue` text as a candidate against `incoming`. The old candidate is the sole gold supersession (`gold_conflict=true`); the three still-true candidates are negatives. Use `candidateDate` and `incomingDate` from the fixture. Present candidate first when `(item index + candidate index) % 2 === 0`, with candidate index 0 for `old` and 1–3 for the listed negatives. Keep all four pairs in an item together when bootstrapping. Evaluate all 80 pairs; do not filter on embedding similarity for the classifier metric. A separate pipeline test must account for candidate selection.

Use the same frozen pairs, provider, model, and prompt except for the flag-gated change when comparing flag off and on. Pin the Engram SHA of each arm. Report TP, FP, FN, TN, precision, recall, F1, item-cluster bootstrap 95% CI (2,000 resamples, seed 7), and the paired F1 difference with its item-cluster CI. Report false-supersession count / 60 and its 95% interval, latency distribution, tokens, and estimated API cost per classification. Failed and invalid calls remain in the raw table and are not silently scored as negatives.

## Falsifier, fixed before the held-out run

The flag-on candidate fails the classifier gate if **any** of these occurs on the held-out set: F1 below 0.60; the lower bound of the paired flag-on minus flag-off F1 bootstrap CI is at or below zero; more than one of the 60 still-true facts is superseded; any flagged-off path changes an existing row; or supersession deletes an older row or cannot be reversed. Also report the false-supersession interval even if the point estimate passes. A passed classifier gate supports only a classifier claim. It does not establish LongMemEval answer lift. Any failed held-out result is reported as a failure; do not tune against this version and rerun it as if unseen.

The fixture is synthetic and visible to its author, so it tests generalization beyond the seen 70-item dev set but is not a blinded real-use or production evaluation. An end-to-end LongMemEval knowledge-update A/B must be separately requested from Eval if this gate passes.

## First held-out run code pin

The dev-only prompt and parser iterations finished before the first held-out call. At that point the shared worktree HEAD was `ee8bfcbaea91b36bfc575f4d02d1c962e774c859` (uncommitted changes are included in the file hashes below): classifier `5ad21f729a5ba35341b9eb1032ca8486351bda646df064e8685b45a0e410a23a`, resolver `792dd09572865af4a4b3a0c2ac0066a90b84a63b833963d8c9e29b9b0d6d0153`, runner `4e9cd880ddfb102cb92899f73e35a3ebf0dd5a00d1389ee3ce943335c570990b`. The flag-on action threshold is 0.8 confidence. The first dev prompt produced 0/70 true positives; the revised prompt and exact-label spelling normalization were selected using dev only. The held-out falsifier above remains unchanged.
