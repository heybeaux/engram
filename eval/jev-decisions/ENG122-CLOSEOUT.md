# ENG-122 close-out: measured negative for automatic supersession

Date: 2026-10-16. The default-off `SUPERSEDES` path and reversible old-row
lineage were built in the shared working tree. A throwaway PostgreSQL check
confirmed that flag off leaves rows unchanged, flag on keeps both rows and
records the supersession, and rollback clears the link. That proves the row
mechanics in isolation. The classifier's safety gate failed on three
independent held-out sets, so the flag must remain **off** and the
uncommitted product path must not be enabled or merged as a validated update
solution. No LongMemEval knowledge-update A/B or end-answer lift was run.

## All measured classifier decisions

Each row scores a flag-on or proposed supersession decision against 70 gold
updates/350 still-true negatives for seen dev, or 20 gold updates/60 negatives
for a held-out set. Flag off always predicts no supersessions: dev TP/FP/FN/TN
0/0/70/350, F1 0; each held-out 0/0/20/60, F1 0. The F1 intervals are 95%
whole-item-cluster bootstrap intervals (2,000 resamples, seed 7). A zero dev
false count is not a safety claim on unseen data.

| Version and split                                      | TP/FP/FN/TN     | F1 [95% CI]              | False supersessions | Gate                     |
| ------------------------------------------------------ | --------------- | ------------------------ | ------------------- | ------------------------ |
| Deployed label set, seen dev                           | 0/0/70/350      | 0.000 [0, 0]             | 0/350               | No supersession path     |
| First-stage classifier, seen dev                       | 55/5/15/345     | 0.846 [0.780, 0.906]     | 5/350               | Dev only                 |
| First classifier, held-out v1                          | 20/23/0/37      | 0.635 [0.597, 0.678]     | **23/60**           | Failed harm              |
| Initial strict verifier wording, seen dev              | 18/1/52/349     | 0.404 [CI not recorded]  | 1/350               | Dev probe                |
| Evidence verifier, seen dev                            | 36/1/34/349     | 0.673 [0.566, 0.772]     | 1/350               | Dev only                 |
| Evidence verifier, held-out v3                         | 19/3/1/57       | 0.905 [0.818, 0.976]     | **3/60**            | Failed harm              |
| Current-property verifier, seen dev                    | 31/0/39/350     | 0.614 [0.495, 0.716]     | 0/350               | Dev only                 |
| Current-property verifier, held-out v4                 | 20/6/0/54       | 0.870 [0.800, 0.952]     | **6/60**            | Failed harm              |
| Independent atomic facts v1, exact join, seen dev      | 9/0/61/350      | 0.228 [0.108, 0.353]     | 0/350               | Failed recall            |
| Independent atomic facts v1, model alignment, seen dev | 13/0/57/350     | 0.313 [0.182, 0.444]     | 0/350               | Failed recall            |
| Independent atomic facts v2, exact join, seen dev      | 9/0/61/350      | 0.228 [0.108, 0.353]     | 0/350               | Failed recall            |
| Independent atomic facts v2, model alignment, seen dev | 12/0/58/350     | 0.293 [0.158, 0.409]     | 0/350               | Failed recall            |
| **Final property-targeted check, seen dev**            | **28/1/42/349** | **0.566 [0.442, 0.673]** | **1/350**           | **Failed both dev bars** |

The frozen blind harm ceiling was at most **1/60**. The Lead's final dev
timebox required **F1 >= 0.60 and 0/350** false supersessions, preregistered
before the property-targeted model call in
`FINAL-PROPERTY-TARGET-REPORT.md` (pre-run SHA-256
`034d46ba2daf550d2e32c0d8ba7822530c796e9f3360c062ea66877787f57de8`)
and on the issue. Its first and only raw result was SHA-256
`52d92b288fcffc2bc346eb27ebca6f07d915888ada5a15f3e3a7766036f88ec2`.
The final false-supersession count interval was [0,3] by item-cluster
bootstrap; Wilson 95% rate interval was [0.000505,0.016005]. It used 58
model calls, 35,785 prompt and 11,850 completion tokens, estimated
$0.01247775 extra chat cost at the fixed prior rates, and p50/p95 call
latency 2,454.113/2,973.963 ms. Two selected pairs abstained before a call;
zero API calls failed and zero responses had invalid JSON or shape. This
attempt is stopped under its preregistered rule.

An earlier first-stage prompt trial (`dev-on-v0.jsonl`) found **0/70** dev
updates, but its complete confusion table and CI were not reported; it is
therefore not represented as a fully scored row above. The initial strict
verifier wording reported TP 18 and FP 1 with F1 0.404494, but no bootstrap
interval, so the table does not invent one.

## Why the flag stays off

The v1/v3/v4 held-out sets were frozen and run once, then spent. All three
exceeded the harm ceiling despite positive F1. Their pair text and model
outputs show a recurrent error: a related entity or object is treated as the
same exact property and scope. The final dev false positive is a concrete
case: a **solo Europe trip next spring** and a later **Europe trip in
November** were assigned the same target `Europe` and scope `general`, so the
model falsely treated the plans as mutually exclusive. They could be two
separate trips. More elaborate prompts and independent fact extraction either
retained such scope risk or lost too many true updates.

The v2 24-cluster authoring set was never measured; v3 was a deterministic
20-cluster subset selected before calls. None of the three spent held-outs
may be reused as unseen. There was no production or live local Engram DB
write, no Jev call for this work, and no end-to-end KU measurement. Classifier
F1 is a supporting metric, not Memory Lift.

## Reproduction and disposition

- First dev and v1 held-out: `SUPERSESSION-REPORT.md` and
  `score-supersession.mjs`.
- Evidence verifier dev: `DEV-VERIFIER-REPORT.md`; v3 blind:
  `ENG125-V3-RESULT.md` and `score-eng125.mjs`.
- Current-property dev: `DEV-PROPERTY-REPORT.md`; v4 blind:
  `ENG127-V4-RESULT.md` and `score-eng127.mjs`.
- Atomic-fact dev variants: `DEV-ATOMIC-SCOPE-REPORT.md`,
  `DEV-ATOMIC-SCOPE-V2-REPORT.md`, and their pinned scorers.
- Final dev attempt: `FINAL-PROPERTY-TARGET-REPORT.md`, raw
  `results/dev-property-target.jsonl`, and
  `node eval/jev-decisions/score-property-target.mjs 52d92b288fcffc2bc346eb27ebca6f07d915888ada5a15f3e3a7766036f88ec2`.
- Isolated row mechanics: `ENG122-DB-INTEGRATION-REPORT.md`.

The appropriate issue outcome is **measured negative, Lead review**. Keep the
flag default off. Any future automatic supersession design needs a new
independent holdout frozen before its first run, and would need an end-to-end
knowledge-update A/B before a Memory Lift claim.
