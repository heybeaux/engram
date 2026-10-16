# ENG-122 independent atomic-fact prototype: dev failure

Date: 2026-10-16. This is a **dev-only** diagnostic after the Lead confirmed
the v3 and v4 held-out harm failures. No production classifier, resolver,
lineage, feature flag, held-out fixture, or database row was changed. The
working-tree classifier at the v4 pin still has SHA-256
`05aa974e4600a45147a3736da553b725370ddc474467688cb1e92a6dacb53637`.
The Lead saved the full source pin as `ENG122-SRC-PIN-V4.patch`, SHA-256
`ac03ccf4d3d9bf822a04bf01129cb28b8eb9a6c651ed695730b0f08d673ccafc`.

## Prototype and frozen dev inputs

The prototype starts with the preserved first-stage `gpt-4o-mini` dev output
(`results/dev-on.jsonl`, SHA-256
`3e5ab3ef20bb2e58d5a3f5c5fda1358316eb43ceba777d71f15bb9df5d64ec6a`):
60 of 420 pairs were proposed as updates, comprising 55 gold updates and
five still-true negatives. The underlying 420-pair dev input has SHA-256
`8656dd5980e817f262e9f8dd37972ad03a5318c1a9f2def87b5b5b1eacf3612c`.

For only those 60 pairs, `run-atomic-scope.cjs` asked the model to extract
subject, attribute, qualifier/scope, value, assertion status, and exact quote
from each memory **independently**, with no other memory shown. It made 111
unique-memory calls, with zero API errors and one unparseable JSON result.
`run-atomic-align.cjs` then showed the independently extracted fact lists to
the model, asking it to select an exact same-scope replacement or abstain.
The scorer also requires equal normalized subjects, equal current/planned
status, different values, and the candidate memory to be older. Three of the
60 alignments abstained before a call because of invalid extraction or time
order; 57 calls completed, with zero invalid comparison JSON results. The
public dev text passed the credential-pattern guard before extraction. No
Jev, held-out, local Engram DB, or production call occurred.

## Dev-only result, 420 pairs / 70 clusters

| Decision rule after first-stage proposal                           |     TP |    FP |     FN |      TN | F1 [95% item-cluster CI] |
| ------------------------------------------------------------------ | -----: | ----: | -----: | ------: | ------------------------ |
| First stage alone (preserved raw)                                  |     55 |     5 |     15 |     345 | 0.846 [0.780, 0.906]     |
| Independent extraction, exact subject/attribute/scope/status keys  |      9 |     0 |     61 |     350 | 0.228 [0.108, 0.353]     |
| Independent extraction, model alignment plus subject/status checks | **13** | **0** | **57** | **350** | **0.313 [0.182, 0.444]** |

The last rule had a zero false-supersession count interval [0,0] over 2,000
whole-cluster bootstrap resamples with seed 7. It misses 57/70 gold updates
and falls far below the preregistered 0.60 F1 threshold. It is **not a viable
replacement** and must not be handed to Eval as a new held-out candidate.

The exact-key rule loses true positives because separately extracted keys
vary for the same property. Seen dev examples include `mcu_films` versus
`mcu_films_watched_last_3_months`, `Emma's recipes` versus `emma_recipes`, and
`general` versus the value `suburbs` in a location scope. The model alignment
recovers only four more positives. These observations come only from seen dev
material; v3 and v4 were not scored again. The risk of accepting different
qualifiers remains unresolved on unseen data.

## Raw artifacts, cost, and next step

- `results/dev-atomic-facts.jsonl` SHA-256
  `9a52dd9d98d0ed0fe0d63d10dcd56b4e2f38fb0839be8c71fc2098fa583e12e4`.
- `results/dev-atomic-align.jsonl` SHA-256
  `68a7fa57ba64f72f0a4d75192481c724bddba6262d5f94612cdfbcda20984cb5`.
- Recompute without model or database calls using
  `node eval/jev-decisions/score-atomic-scope.mjs` and
  `node eval/jev-decisions/score-atomic-align.mjs`.

The extraction and alignment calls consumed **70,125 prompt tokens** and
**30,528 completion tokens**, estimated **$0.02883555** total at the existing
`gpt-4o-mini` chat rates, or about $0.00006866 extra per original dev pair.
This is additional to first-stage classification and excludes embeddings.
Extraction-call latency p50/p95 was 2,364.810/3,915.416 ms; alignment-call
latency p50/p95 was 767.464/1,176.372 ms. These are per-call figures, not a
measured end-to-end classification latency because extractions were cached
across pairs.

The next design should improve **single-memory fact extraction consistency**
on seen dev before adding any automatic mutation path. A stricter exact-key
join alone is safe on these dev negatives but loses too much recall. Keep
automatic supersession off and do not request another blind holdout until a
fixed design reaches a credible dev safety and F1 margin. Preserve the v1,
v3, and v4 failures as failures; no LongMemEval answer lift is established.
