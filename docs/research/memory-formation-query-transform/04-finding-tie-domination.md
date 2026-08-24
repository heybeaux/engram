# Finding: Retrieval Ranking Is Tie-Dominated, Not Score-Decided

**Date:** 2026-08-23
**Status:** verified independently (twice, by separate analyses of the same
committed report)
**Severity:** blocks meaningful evaluation of both interventions
**Source data:** `mnemon/reports/mnemon-v0.2-qwen-engram-noisy-20task-3x-t02.json`

---

## The finding

On the 20-task noisy corpus, Engram's top-1 retrieval result is almost never
determined by the score. It is determined by **array order among tied scores.**

| Measure | Value |
|---|---|
| Unique task-snapshots analyzed | 20 |
| Snapshots with a **5-or-more-way tie at the top score** | **18 / 20** |
| Snapshots where top-1 was **uniquely decided by score** | **2 / 20** |
| `hit@1` as returned (matches `RESULTS.md` "13/20 rank 1") | 13 / 20 = **0.65** |
| `hit@1` expected under fair tie-breaking | **≈ 0.21** |
| `hit@1` pessimistic | **≈ 0.10** |
| Context false-positive injection rate | **0.87** |

**11 of the 13 "rank 1" successes were not earned by ranking.** They are the
consequence of the correct memory happening to sit earlier in a tied block. Under
random tie-breaking the same system scores ~0.21; under adversarial ordering,
~0.10.

Separately: **87% of items injected into the model's context are distractors**
(`allowed: false`).

## Why this happens

This traces directly to the score semantics documented in
[`01-current-state-map.md` §3](01-current-state-map.md). Engram's recall score is
not a similarity measure end-to-end:

- cosine path → `1 - distance`, genuinely in [0,1] and continuous
- **full-text-search rescue → hard-coded `1.25`**
- **ILIKE rescue → hard-coded `1.1`**
- graph-recall hits → `× 1.2`

The rescue paths assign **constants**. Every memory that qualifies via keyword
rescue receives *the identical score*, regardless of how well it matches. In a
noisy corpus, many near-duplicate distractors qualify — so they all land on 1.25
together with the correct memory, and the tie is broken by whatever order the
rows came back in.

The scoring function has **almost no discriminative power in exactly the regime we
care about.**

## Why this blocks the study

The ablation matrix (A–E) measures whether better *representation* (formation, B)
or better *candidate generation* (query transformation, C) improves retrieval.
Both interventions work by putting better candidates into the result set.

**If 18/20 queries end in a 5-way tie at the top, a better candidate does not
change top-1 — the tie-break does.** Any measured improvement or regression would
be dominated by ordering noise rather than by the intervention. We would be
measuring the row order of a Postgres result set.

Concretely, this invalidates:
- `hit@1` and MRR as primary endpoints (both are tie-sensitive)
- any A-vs-B or A-vs-C comparison whose delta is smaller than the tie envelope
- the previously reported rank-1 counts as a baseline to improve on

It also explains a prior anomaly we had attributed to index settling: identical
corpora scoring **13/20 one run and 12/20 another**. That is not drift in
retrieval quality; it is the tie order resolving differently.

## Consequences for prior results

The **downstream** lift numbers in `RESULTS.md` (+0.219 clean, +0.101/+0.117
noisy, CIs excluding zero) are **not invalidated** — those are paired
executable-code measurements and stand on their own. What is invalidated is the
*retrieval-quality* narrative attached to them: we reported 13/20 rank-1 as
evidence that retrieval was mostly working under noise. It was not. Retrieval was
producing a 5-way tie and getting lucky.

If anything this **strengthens** the case that memory helps — the downstream lift
was achieved *despite* an 87% context false-positive rate and essentially
arbitrary top-1 selection.

## Recommended sequencing change

The Phase 1 memo already argued (from the CogCanvas and query-rewrite-harm
literature) that reranking should come before either LLM intervention. This
finding makes that ordering **mandatory rather than advisory**:

1. **Fix score semantics first.** The rescue constants (1.25 / 1.1) and the ×1.2
   graph boost must produce a continuous, discriminative ordering — or ties must
   be broken by an explicit, principled secondary key (e.g. cosine similarity)
   rather than result-set order. Until then the system cannot express a
   preference between candidates.
2. **Re-establish the baseline** with tie-aware metrics. Report the four-way tie
   envelope (`expected` / `optimistic` / `pessimistic` / `asReturned`), never a
   bare scalar.
3. **Then** run the A–E matrix. Only once ranking is discriminative can formation
   or query transformation be credited or blamed for a change in top-k.

## Measurement requirements going forward

- **Never report `asReturned` alone.** It flattered our previous results by 3×.
  The harness (`ablation/metrics/`) emits the tie envelope by construction.
- **Deduplicate trial copies.** All 3 trials share one `snapshotHash` per task;
  treating them as independent narrows every CI by ~√3 for zero added
  information.
- **Stability needs pooled runs.** It cannot be measured within a single report,
  because the snapshot is frozen per task.
- **Track the tie count and top1−top2 margin as first-class metrics**, not
  diagnostics. They are the leading indicator of whether any retrieval delta is
  real.

## Verification

Confirmed twice by independent paths: once by the metrics implementation against
hand-computed fixtures, and once by a direct recomputation over the raw report
JSON. Both produced identical numbers (18/20 five-way ties, 2/20 score-decided,
13/20 `asReturned`, 0.87 false-positive rate).
