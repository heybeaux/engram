# Candidate-diversity production gate

Date: 2026-08-23

This gate independently validates commit `08be7a4` against the 81-query,
1,210-memory real-embedding benchmark. It compares the combined recall fixes
with candidate diversity disabled and enabled. Nothing was pushed, deployed, or
run against production data.

## Configuration

Both arms enabled:

- `RECALL_RERANK_SCALE_FIX=true`
- `RECALL_LEXICAL_COVERAGE_FLOOR=true`
- `RECALL_RESCUE_SQL_TIEBREAK=true`
- final result limit 10

The treatment additionally enabled:

- `RECALL_CANDIDATE_POOL_DEPTH=12`
- `RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT=2`
- token-set Jaccard threshold 0.90

The corpus used real `bge-base` 768-dimensional embeddings in a dedicated local
database. The raw artifact is
[`artifacts/diversity-production-gate/real-embedding-81.json`](artifacts/diversity-production-gate/real-embedding-81.json).

## Benchmark validity controls

Issue #326 identified two confounds in the existing harness. This run controls
both:

1. `seedCorpus` silently drops fixture tags, metadata, and memory type. The gate
   restored all declared values, then compared the stored values with the fixture
   definitions for all 1,210 memories. All 1,210 memories had their declared tags.
2. Recall mutates usage fields that can change later rankings. The gate took a
   persistent snapshot of `retrieval_count`, `used_count`, `unused_count`,
   `last_retrieved_at`, and `last_used_at`, then restored it before every query
   and every repeat.

Every query was executed twice in each arm. No query changed ranking between
identical repeats in either arm.

## Results

| metric | diversity off | diversity on | delta |
| --- | ---: | ---: | ---: |
| required hit rate@5 | 60/62 (96.77%) | 60/62 (96.77%) | 0 |
| relevant recall@10 | 71/73 (97.26%) | 71/73 (97.26%) | 0 |
| MRR@10 | 0.91262 | 0.91282 | +0.00020 |
| forbidden-memory injection | 0/91 | 0/91 | 0 |
| full-page rate | 73/80 (91.25%) | 73/80 (91.25%) | 0 |
| mean page size | 9.4375 | 9.4375 | 0 |
| latency p50 | 23 ms | 18 ms | -5 ms |
| latency p95 | 31 ms | 38 ms | +7 ms |
| latency mean | 21.83 ms | 21.46 ms | -0.36 ms |

There were no top-five gains and no top-five losses. Eight emotional-query
rankings changed. Only `emotional_003` changed a relevant rank: the second
required memory moved from rank 9 to rank 7, producing the small MRR increase.
The other seven changes reordered non-required results. Page sizes were
identical query by query.

The latency sample is an execution sanity check, not a performance claim. Arms
ran sequentially rather than in an interleaved latency experiment; the mixed
p50/p95 movement does not establish a speedup or regression.

## Relationship to the targeted near-duplicate result

The controlled mnemon near-duplicate matrix remains the positive efficacy
evidence. Depth alone did not move the 14/20 ceiling. Depth 12 plus a two-member
near-duplicate cluster cap retained 14/20 at rank 1 and moved all six remaining
gold memories into the returned page: 20/20 hit@5, 20/20 hit@10, and MRR 0.800.
Two independent repeats were exact.

The 81-query gate supplies the complementary safety evidence: the same setting
did not trade away required top-five hits, recall, tenant isolation, stability,
or page fullness on the ordinary real-embedding suite.

## Graduated-corpus gap

Phase 1 defines deterministic generators for the requested conditions in
mnemon:

- G1: 20 targets plus 400 ordinary unrelated memories
- G3: 20 targets plus 200 stale/superseded memories
- G4: 20 targets plus 100 directly contradictory memories
- G5: 20 targets plus 200 ambiguous cross-project memories

No materialized corpus with a successful embedding-gate receipt or completed
retrieval report exists for these conditions. The only attempted smoke run was
invalid: it produced no usable embeddings because the local embedding path
returned NaNs and mixed 384-dimensional output with the 1,536-dimensional test
configuration. The seeder cleaned that attempt up. These conditions therefore
have **no result**, not a passing or failing result.

The 81-query suite contains temporal, emotional, adversarial, cross-feature,
edge-case, and tenant-isolation queries, but it is not a causal substitute for
G1/G3/G4/G5.

## Verdict

Commit `08be7a4` earns a merge recommendation **behind its existing default-off
flags**. The targeted near-duplicate condition shows a large, replicated gain,
and the corrected 81-query real-embedding gate finds no quality, isolation,
stability, or page-fullness regression.

It does not yet earn default-on production rollout. Before changing defaults,
materialize and embedding-gate G1, G3, G4, and G5; run the same isolated on/off
comparison; then run an interleaved latency/load check. A small internal canary
with decision telemetry is reasonable after merge because rollback is a flag
change.
