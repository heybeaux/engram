# Replacement classifier holdout freeze (2026-10-15)

This is metadata for the Eval-owned sealed fixture. Pair text remains outside the shared worktree until Engram Temporal records the next classifier, prompt, threshold, and falsifier pin on [ENG-122](/ENG/issues/ENG-122). Neither arm has run on this set.

| Field                       | Frozen value                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                      | 24 independently authored fictional item clusters; no Engram database or production data; no Jev call                                                                                          |
| Size                        | 96 pairs: one newer-fact replacement and three related still-true candidates per cluster (24 positives, 72 negatives)                                                                          |
| SHA-256 of UTF-8 JSON bytes | `c98b820b2a5af9108d0dc30527d7c73c77ea35e7743b49c88ac72154a5951ab6`                                                                                                                             |
| Leakage checks              | 24 unique cluster IDs, 120 unique text fields; zero normalized exact text matches with the 70-item dev split or held-out v1; zero reused held-out v1 cluster IDs; zero credential-pattern hits |
| Freeze baseline             | shared worktree HEAD `ee8bfcbaea91b36bfc575f4d02d1c962e774c859`; uncommitted Temporal changes exist and are **not** a code pin                                                                 |

## Scoring protocol

Pair each cluster's earlier fact and three related still-true facts separately with its later fact. The earlier fact is the sole gold supersession. Present candidate first when `(cluster index + candidate index) % 2 === 0`, with candidate index zero for the earlier fact and one through three for the negatives. Use the fixture's candidate and incoming dates. Evaluate every pair; do not filter by embedding similarity. Keep all four pairs of an item together for resampling.

After Temporal posts the code pin, verify the fixture hash and credential scan immediately before a **single** flag-off and flag-on comparison. Pin the same model, prompt, threshold, source SHA/file hashes, and runner for both arms; only the flag changes. Preserve every raw attempt, including failed and invalid calls. Do not convert invalid calls to negatives or silently drop them. Report valid/invalid counts and the reason for each invalid call.

Report TP, FP, FN, TN, precision, recall, F1, and paired flag-on minus flag-off F1. Use 2,000 item-cluster bootstrap resamples with seed 7 for percentile 95% intervals on arm F1, paired F1 difference, and false-supersession **count**. Also report false supersessions out of 72 and its Wilson 95% rate interval. Report latency p50/p95, prompt and completion tokens per classification, total metered tokens, estimated API cost per classification, and total attempt cost. Record the exact classifier and runner pin in the result.

Keep the v1 harm falsifier's absolute tolerance: flag-on F1 must be at least 0.60, paired F1-difference CI lower bound must be above zero, and false supersessions must be at most **one of 72**. Flag-off must leave existing rows unchanged; supersession must not delete an older row and must be reversible. A classifier-only run cannot prove the row-mutation criteria; report those as not tested until an isolated database integration test runs. No end-to-end LongMemEval knowledge-update A/B proceeds before the classifier gate passes. A failed v2 result remains a failure and must not be tuned and rerun as unseen.
