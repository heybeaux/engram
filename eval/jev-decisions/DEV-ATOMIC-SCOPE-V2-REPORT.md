# ENG-122 atomic-fact extraction v2: dev-only failure

Date: 2026-10-16. This is a second, **seen-dev-only** attempt after the first
atomic-fact prototype missed the F1 gate. The product classifier, resolver,
lineage, and default-off supersession flag were not changed. No held-out, Jev,
Engram database, or production call occurred. The prior raw results remain
unchanged.

## Method

The pinned first-stage `gpt-4o-mini` dev output proposed 60 of 420 pairs:
55 gold updates and five still-true negatives. The v2 extraction prompt asked
for every explicit value-bearing clause and gave stable attribute examples.
It processed the same 111 unique selected memories independently with
`gpt-4o-mini`, temperature 0 and 1,100 maximum output tokens. The existing
alignment prompt then compared only the newly extracted fact lists. The
scorer retained the existing subject, assertion-mode, different-value, and
older-before-newer guards. Input hashes are checked by the versioned scripts.
The public dev text passed the existing credential-pattern guard before any
model call.

| Seen-dev rule (420 pairs, 70 clusters) |     TP |    FP |     FN |      TN |      F1 [95% cluster CI] |
| -------------------------------------- | -----: | ----: | -----: | ------: | -----------------------: |
| First stage alone, preserved raw       |     55 |     5 |     15 |     345 |     0.846 [0.780, 0.906] |
| Original exact extracted keys          |      9 |     0 |     61 |     350 |     0.228 [0.108, 0.353] |
| Original model alignment               |     13 |     0 |     57 |     350 |     0.313 [0.182, 0.444] |
| **V2 exact extracted keys**            |  **9** | **0** | **61** | **350** | **0.228 [0.108, 0.353]** |
| **V2 model alignment**                 | **12** | **0** | **58** | **350** | **0.293 [0.158, 0.409]** |

Intervals use 2,000 whole-item-cluster bootstrap resamples, seed 7. The v2
alignment has 0/350 false supersessions on this seen dev set, with cluster
count interval [0,0]. This is not evidence of unseen safety: the expensive
comparison reached only three of the five first-stage false positives; two
abstained before the call. The v2 alignment loses one true positive against
the original prototype and falls far below the 0.60 F1 gate.

## Why recall remains low

`diagnose-atomic-align.mjs` recounts the preserved raw outputs. Among 55
first-stage gold proposals, both versions have 52 pairs with nonempty
extracted fact lists and 51 with at least one same-subject, same-mode,
different-value combination. Exact attribute-key matches fell from **14**
original to **10** in v2; exact attribute **and** scope matches stayed at
**9**. The alignment model abstained on 38 original versus 39 v2 gold rows.
These stage counts overlap and are not a partition of the 55 cases.

V2 recovered the old/new pre-approval amounts and a device usage duration in
specific seen examples, but other facts became inconsistent or wrong. In one
seen pair, Rachel's move from Chicago to the suburbs was extracted with the
newer location assigned to the user and labeled `ownership_status`. An exact
join cannot repair a changed subject or omitted property; relaxing that join
would increase the risk of superseding an unrelated true fact. This error
analysis is based on the seen dev set only.

## Raw results and cost

- V2 extraction: `results/dev-atomic-facts-v2.jsonl`, SHA-256
  `1e790a678d13986df0580f3f0d8f517277950139a20afd957ccd46e13e9106c4`;
  111 calls, zero API errors, one invalid JSON response, 63,388 prompt and
  24,142 completion tokens, p50/p95 call latency 1,884.599/3,652.186 ms.
- V2 alignment: `results/dev-atomic-align-v2.jsonl`, SHA-256
  `64d4b5fb95a74e741f510766aa0f5cc29375a948520a518bb9adb535206bce4b`;
  57 calls, three pre-call abstentions, zero invalid comparison JSON, 22,812
  prompt and 2,547 completion tokens, p50/p95 call latency
  732.390/855.090 ms.
- Combined extra model use: 86,200 prompt and 26,689 completion tokens;
  estimated **$0.02894340** under the same fixed $0.15/$0.60 per million
  token accounting as the original prototype. This excludes first-stage
  classifier, embeddings, and any cached-input discount. The call latencies
  are not end-to-end classifier latency because extractions were cached.

Reproduce the scores and stage counts without model or database calls:

```bash
node eval/jev-decisions/score-atomic-scope-v2.mjs
node eval/jev-decisions/score-atomic-align-v2.mjs
node eval/jev-decisions/diagnose-atomic-align.mjs --v2
```

The next design needs a more reliable subject and property representation
before any new independent holdout. The v1, v3, and v4 held-out harm failures
remain failed measurements. Supersession stays default off; no end-answer
lift is claimed.
