# Finding: The Rescue Band Inverts Ranking, But It Is Not Why Gold Is Missing

**Date:** 2026-08-23
**Status:** measured on the noisy prefix corpus (retrieval-only, no LLM)
**Follows:** [`04-finding-tie-domination.md`](04-finding-tie-domination.md), fixed in `c905438`
**Instance:** research worktree @ `127.0.0.1:3007`, DB `engram_ablation_prefix`,
`RERANK_ENABLED` unset (so `applyReranking` takes the fallback-blend path),
`USAGE_WEIGHT=0.15`, corpus = 20 gold + 200 distractors, `userId
mnemon-v02-noise-prefix`

---

> ## ⚠️ UPDATE (2026-08-23, later the same day): the `RECALL_RELATIVE_RESCUE` prototype was REMOVED
>
> **The analysis in this document is still valid and is exactly why the prototype
> was killed. Only the prototype code is gone — `relativeRescueScore()`, the
> `RECALL_RELATIVE_RESCUE` flag and its branches, its unit tests, and
> `scripts/research/run-rescue-ab.sh`.**
>
> The 5-arm ablation that followed this write-up (20 tasks, noisy prefix corpus,
> `limit=10`, usage counters reset per arm) settled it:
>
> | arm | gold@1 | gold@5 | gold@10 | MRR@10 |
> | --- | --- | --- | --- | --- |
> | default | 0 | 6 | 6 | 0.150 |
> | scalefix (`RECALL_RERANK_SCALE_FIX`) | 0 | **14** | **14** | **0.350** |
> | relative (`RECALL_RELATIVE_RESCUE`) | 0 | 7 | 8 | 0.174 |
> | both | 0 | 7 | 8 | 0.174 |
> | vector-only (`RECALL_NO_RESCUE`) | 6 | 7 | 8 | 0.331 |
>
> The kill signal is that **`both` is numerically identical to `relative`**.
> `relativeRescueScore()` rewrites candidate scores into the rescaled scale
> *upstream*, so by the time `RECALL_RERANK_SCALE_FIX` runs there is no scale
> mismatch left for it to correct — the scale fix becomes a no-op. Enabling
> relative rescue therefore does not compose with the scale fix, it *replaces*
> it, dragging 14/20 gold@5 back down to 7/20. The two flags are mutually
> exclusive by construction, and the scale fix is strictly better on every
> metric.
>
> Keeping the prototype in the tree would only have tempted someone into a
> net-negative configuration. The sections below describe the removed code in the
> present tense; read them as a record of what was measured, not of what ships.
> The surviving fix is `RECALL_RERANK_SCALE_FIX` (commit `7cdf49d`, branch
> `fix/recall-rerank-scale-mixing`).

---

## TL;DR

1. **Gold is never missing from the candidate pool.** 20/20 tasks retrieve the
   gold memory. This is purely a *ranking* failure, not a recall failure. The
   two failure modes need different fixes and we have the ranking one.
2. **The band is a real defect** — it discards the cosine ordering, mixes score
   scales, and makes results non-monotonic in `limit`. Fixed under a flag.
3. **But the band is not the reason gold misses top-5.** With the band replaced
   by a relative boost, gold-in-top-5 moves 6/20 → 7/20. For 11 of the 20 tasks
   the gold memory is *behind all ten of its distractors in the semantic
   ordering too*. The premise "the gold memory can be the best semantic match
   and still never appear in the top-5" does not hold on this corpus; on the
   majority of tasks the gold is not the best semantic match.

## 1. Where the gold actually ranks

`scripts/research/retrieval-probe.mjs` replays the 20 task queries against a
live instance and reports, per query, the top-10 with the band each hit came
from and where the gold landed — both in the page the benchmark consumes
(`limit=10`) and in the full 221-memory pool.

| Measure (20 tasks, `limit=10`) | band (shipped) | relative (flag on) |
|---|---|---|
| gold anywhere in the candidate pool | **20/20** | **20/20** |
| gold in top-1 | 0/20 | 0/20 |
| gold in top-5 | 6/20 | 7/20 |
| gold in top-10 | 6/20 | 8/20 |
| MRR@10 | 0.150 | 0.174 |

Both arms were run against usage counters reset to the same cold snapshot
(`zz_probe_usage_snapshot`), because recall increments `retrieval_count` and
`applyUsageWeighting` feeds it straight back into the score — see §5.

## 2. The band inverts the cosine ordering it sits on top of

The decisive observation. For query *"…app config environment variables and
parsing"*, at `limit=250` (shipped code), the returned order was:

```
rank  score     vectorScore
1     0.42768   0.78597
2     0.42761   0.78600
...
10    0.42711   0.78982   <- highest cosine in the set, ranked last
```

Every one of those is an FTS-rescued distractor. Their final scores descend
monotonically while their cosines do not: the candidate with the **best** cosine
in the block (0.78982) is ranked **last** in the block. `ftsRescueScore()`
derives the band value from `ts_rank` and the RRF position and *overwrites*
`scoreMap`, so the semantic signal survives only as tie-break key #2 in
`compareByRankKeys` — and it never gets used, because the band values are
already distinct. Lexical rank does not merely win the tie; it replaces the
ordering.

Code path: `src/memory/memory-query.service.ts:478-500` (FTS,
`scoreMap.set(row.id, bandedScore)` on both the insert and the `Math.max`
branch), `:596-616` (ILIKE), `src/memory/memory-ranking.util.ts:76-123`.

## 3. What actually decides the top-5: post-rerank scale mixing

`applyReranking` (`src/memory/memory-query-ranking.service.ts:226-307`) rescales
**every** candidate. With the cross-encoder it emits `normalisedRerank * 0.85 +
importance * 0.15`; without it, the fallback blend is `(score * 0.85 +
importance * 0.15) * importanceMultiplier * sentimentPenalty`. Either way the
output is ≤ ~1.0 and usually ≤ 0.5.

The sticky keyword re-add immediately afterwards
(`src/memory/memory-query.service.ts:862-905`) re-injects every rescued memory
that fell out of the reranked top-N **with its raw pre-rerank band score**
(1.25 / 1.15 / 1.05), taken from `keywordRescueMap`. Those raw values are then
sorted against rescaled values. They win categorically. The final top-N is
whatever the lexical rescue produced, and the reranker's judgement is discarded.

This is directly observable as a **non-monotonicity in `limit`** — same query,
same instance, seconds apart:

| `limit` | top-1 score | what the page contains |
|---|---|---|
| 5 | 1.25000 | 5 FTS-band distractors |
| 10 | 1.24908 | 1 FTS-band + 9 ILIKE-band distractors |
| 50 | 0.90922 | pure reranked/blended scores, no band values at all |
| 250 | 0.90051 | pure reranked/blended scores |

At `limit=50` nothing is "missing" from the reranked top-50, so
`missingKeywordHits` is empty and the re-add never fires. **Asking for more
results changes which results rank first.** That is a correctness bug on its
own, independent of the band policy.

## 4. The two remaining flat constants

- **Identity rescue, `memory-query.service.ts:684/688` (pre-fix line 642/646)** —
  flat `1.15` for all ten rows. Confirmed live: `1.15` sits *inside* the FTS
  band `(1.10, 1.25]`, so identity hits interleave with FTS hits, and all ten
  identity rows tie with each other and fall back to `compareByRankKeys` keys
  2-5. Same defect class as the one `c905438` fixed. Fixed under the flag.
- **`forcedFts`, `memory-query.service.ts:774` (pre-fix line 709)** — flat
  `0.75`, and **unreachable**. `topIds` and `memoryMap` are both built from
  `sorted`, so `!topIds.has(id)` implies `memoryMap.get(id) === undefined` and
  the inner `if (mem)` never fires; `forcedFts` is always `[]`. This is dead
  code, not a live scoring path. Annotated in place rather than "fixed":
  making it live would inject FTS-only candidates at a flat constant, i.e.
  reintroduce exactly the defect `c905438` removed.

## 5. Measurement hazard found along the way

Every recall does `retrievalCount: { increment: 1 }` for every returned memory
(`memory-query.service.ts:912-920`), and `applyUsageWeighting` blends
`usageSignal` (a function of `retrievalCount`) back into the score at weight
0.15 once `retrievalCount >= 3`. Retrieval therefore reinforces whatever it
already returns — and on this corpus what it already returns is distractors. It
also means **the benchmark perturbs itself**: the same query, run twice, does
not return the same ranking. Any A/B on this corpus must reset the counters
between arms, which `scripts/research/run-rescue-ab.sh` does.

## 6. Should a lexical hit ever outrank a strong semantic hit?

**No — not categorically, which is what the band does.** But the band is not
merely a tuning error; there is a real use case underneath it, and removing it
outright would regress that case.

The case it serves: a *fresh exact-match write*. A memory ingested seconds ago
may have a stale, missing, or low-quality embedding, and a user querying an
exact rare token ("what's my Vercel project id", "ORD-4471") wants that memory
even though its cosine is unremarkable. The band guarantees it surfaces. That
guarantee is load-bearing — the sticky re-add comment says so explicitly.

The flaw is that the guarantee is written as a **priority stratum** rather than
as **evidence**. Absolute bands above the cosine ceiling encode "any lexical
match beats every semantic match, at any strength, forever". That is only the
right answer when the lexical match is *rare* — a discriminating token. On a
corpus where the distractors restate the query, the lexical signal has zero
discriminating power and the band hands the whole top-N to noise.

**Recommendation: make it relative, not absolute.** A lexical hit should buy a
bounded multiplicative promotion on the candidate's own semantic score:

```
score = cosine * (1 + maxBoost * lexicalQuality)
```

with `maxBoost` 0.2 for FTS, 0.1 for ILIKE, 0.15 for identity. Properties:

- a lexical hit still **promotes** (that is the use case), but a candidate with
  a materially better cosine can still beat it;
- the cosine ordering **inside** the rescued set is preserved instead of being
  overwritten by `ts_rank`;
- everything stays in one numeric scale, so usage weighting, the fallback
  blend and the cross-encoder compare like with like, and the sticky re-add
  stops being a scale-mixing bug;
- lexical-only candidates (matched by FTS/ILIKE but absent from the vector
  pool — the fresh-write case) get anchored at `0.9 * bestCosine`, so they are
  admitted to the pool and are recoverable, but cannot displace the best
  semantic hit.

Rejected alternatives: *removing* the band loses the fresh-write guarantee;
*capping* it at a lower constant keeps the categorical inversion and just moves
the threshold; *hard-gating* rescue on IDF/rarity of the matched terms is
probably the right long-term answer but needs corpus statistics Engram does not
currently keep.

## 7. What the fix does and does not buy

Flag `RECALL_RELATIVE_RESCUE=true` (default `false`, no change to shipped
behaviour):

- gold-in-top-5: 6/20 → 7/20
- gold-in-top-10: 6/20 → 8/20
- MRR@10: 0.150 → 0.174
- top-1: 0/20 → 0/20

Small, because after the fix the ranking *is* the semantic ranking, and on 11 of
the 20 tasks the gold memory sits behind all ten of its distractors in that
ordering (`rankInPool == 11` in `/tmp/probe-true.json`). The distractors are
constructed as verbatim restatements of the query plus a disclaimer; the gold is
the query prefix plus the actual fact. Under `bge-base` the restatement is the
closer match. No reranking policy can recover that — it needs a different
embedding, an IDF-aware lexical gate, or a corpus that is not adversarial in
exactly this way.

The honest read: **the band fix is worth shipping for determinism, scale
hygiene and `limit`-monotonicity, not for benchmark score.** The 5% gold-in-top-5
number is dominated by embedding discrimination, not by the ranking policy.
