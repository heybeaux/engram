# ENG-122 false-supersession analysis after v4

Date: 2026-10-16. The flag remains **default off**. The current-property
verifier passed its seen dev set's false-supersession count (0/350), then
failed the first independent v4 holdout at **6/60**. V4 was frozen and run once
by Eval under [ENG-127](/ENG/issues/ENG-127). It is now seen diagnostic data,
and its score cannot be repaired by tuning and rerunning v4 as unseen.

## Measured sequence

| Version and split                     | Gold updates |  TP | FP / still-true negatives |        F1 | Gate             |
| ------------------------------------- | -----------: | --: | ------------------------: | --------: | ---------------- |
| Initial flag-on, v1 holdout           |           20 |  20 |                     23/60 |     0.635 | Failed           |
| First evidence verifier, v3 holdout   |           20 |  19 |                      3/60 |     0.905 | Failed           |
| Current-property verifier, seen dev   |           70 |  31 |                     0/350 |     0.614 | Development only |
| Current-property verifier, v4 holdout |           20 |  20 |                  **6/60** | **0.870** | **Failed**       |

These are different fixtures and classifier revisions, so differences across
rows are descriptive and not paired treatment effects. The v4 gate was F1

> =0.60, paired item-cluster bootstrap F1-difference lower bound >0, and at
> most **1/60** false supersessions. Only the harm condition failed. Eval's
> raw scorer reproduced TP/FP/FN/TN 20/6/0/54, F1 0.869565 [0.800000,
> 0.952381], false-supersession count CI [2,10], Wilson rate CI [0.04664,
> 0.20150], and 80/80 valid results in both arms. The input SHA-256 was
> `f47958036d493bb49c85778b325fa466838e1a8e38fad17c39de7e63102cc447`;
> off/on raw hashes were
> `e7eec6742c7ae50452dba376864c594621a8a782cd1f227456c806d4c6de6a5d`
> and `272c0d9be8f58ce5befe49bcd5a8ef6873171c0fc4eb1ed84d61e568b6190f61`.

## What the six v4 errors share

All six negatives relate to the same organization or object as the newer
memory, but assert a different **property scope**. The pair's shared words or
numbers are insufficient evidence that one current fact replaces the other.

| False-positive pair    | Still-true property                        | Updated property              |
| ---------------------- | ------------------------------------------ | ----------------------------- |
| `bird-count-method:2`  | Heron census recording day                 | Heron counting method         |
| `postage-weight:1`     | Letter-label weight limit                  | Parcel-label weight limit     |
| `cistern-capacity:2`   | Seedlings watered with collected rainwater | Rainwater cistern capacity    |
| `drone-altitude:1`     | Inspection-drone flight altitude           | Mapping-drone flight altitude |
| `ball-inflation:1`     | Training-ball pressure                     | Match-ball pressure           |
| `solar-charge-limit:1` | Spare-battery charge limit                 | Main-battery charge limit     |

The classifier's second verifier accepted these pairs even though its prompt
asks for same subject, same property, latest-value replacement, exact quotes,
and `can_coexist_as_current: false`. The on arm used 110 chat calls for 80
pairs, consistent with 30 second-verifier calls. This supports the inference
that a self-reported same-property boolean from one model is not a reliable
automatic mutation gate on closely related facts. The raw records do not
contain the verifier's JSON evidence, so the exact internal reason for each
acceptance is unobserved.

## Next design and evidence required

Keep automatic supersession disabled. Prototype **independent per-memory
atomic-fact extraction** on seen dev material, with explicit subject,
attribute, and qualifier/scope fields. Compare the extracted scope fields in
code before allowing a supersession; abstain to review if either side is
ambiguous or scopes differ. Use sibling-property negatives as development
stress cases, and report lost true positives alongside false supersessions.
Avoid another blind holdout until a fixed design has a credible dev safety
margin and source hashes are pinned. Then ask Eval to author a new independent
fixture, freeze it before any model call, and apply the original harm gate once.
The v1, v3, and v4 failures remain part of the record. No LongMemEval
knowledge-update A/B, production change, or Memory Lift claim is supported.

The row effect itself has a separate passing isolated PostgreSQL check in
`ENG122-DB-INTEGRATION-REPORT.md`: with the flag off, existing rows were
unchanged; with it on, older rows were preserved and could be restored by
rollback. That check does not reduce the classifier's false-supersession harm.
