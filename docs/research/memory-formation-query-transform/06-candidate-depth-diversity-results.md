# Candidate Depth and Near-Duplicate Diversity Ablation

Date: 2026-08-23

Status: research result; no deployment or production data changes

## Question

The lexical coverage floor raised the noisy-prefix corpus to 14/20 gold at
rank one. All six remaining gold memories were at 0-based pool rank 10: the
first item excluded from a final top-10 page. Each was preceded by ten
almost-identical archived neighboring-service notes.

This ablation separated two hypotheses:

1. A deeper candidate pool alone lets the existing ranker resolve the cluster.
2. The result page needs an explicit diversity constraint so one
   near-duplicate cluster cannot consume every slot.

## Controls

- Base commit: `47e8c82`
- Required flags in every arm: `RECALL_RERANK_SCALE_FIX`,
  `RECALL_LEXICAL_COVERAGE_FLOOR`, and `RECALL_RESCUE_SQL_TIEBREAK`
- Final caller-visible top-K: 10
- Candidate depths: 10, 12, 20, 50
- Existing 20-task `mnemon-v02-noise-prefix` receipt and tasks
- Usage counters restored from `zz_probe_usage_snapshot` before every page and
  deep-pool query, preventing cross-query usage-weight feedback
- Two independent server restarts/runs per arm; no LLM generation

An initial pilot reset usage only once per arm. It exposed a harness confound:
arms returning different memories produced different usage state for later
queries. Those pilot numbers are excluded below.

## Depth-only result (negative)

| Candidate depth | gold@1 | gold@5 | gold@10 | MRR@10 | Former misses |
| ---: | ---: | ---: | ---: | ---: | --- |
| 10 | 14/20 | 14/20 | 14/20 | 0.700 | absent |
| 12 | 14/20 | 14/20 | 14/20 | 0.700 | pool rank 10 |
| 20 | 14/20 | 14/20 | 14/20 | 0.700 | pool rank 10 |
| 50 | 14/20 | 14/20 | 14/20 | 0.700 | pool rank 10 |

Depth makes gold available but does not change final ordering. More candidates
alone buy zero retrieval quality here.

## Diversity intervention

The research prototype greedily preserves relevance order while allowing at
most two members from any token-set Jaccard cluster at similarity >= 0.90.
Suppressed rows are then backfilled in original relevance order so the API
still returns a complete top-10 page. It does not delete or mutate memories.

The candidate controls explicitly depend on `RECALL_RERANK_SCALE_FIX=true`:
diversifying a mixture of raw rescue-band and post-rerank scores is undefined,
so both controls are ignored when the scale fix is off. Configured candidate
depth is a **minimum**, not a maximum: the effective depth is
`max(caller limit, configured depth)`, so a caller asking for more than 12 rows
is never truncated. If the cluster cap is enabled without an explicit depth,
the service uses a bounded 50-row scan (or the caller limit when larger).

The threshold is conservative for this failure mode: sampled decoy-to-decoy
similarity is 0.951 while gold-to-decoy similarity is 0.178. The mechanism
does not inspect benchmark IDs, `archived` wording, or gold labels.

| Candidate depth | cluster cap | gold@1 | gold@5 | gold@10 | MRR@10 | Page size |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 12 | 2 | 14/20 | **20/20** | **20/20** | **0.800** | 10 |
| 20 | 2 | 14/20 | **20/20** | **20/20** | **0.800** | 10 |

At the smallest winning depth (12), all six former misses moved from 0-based
pool rank 10 to page rank 2. No former hit regressed. Both repeats were
bit-identical: 0/20 query rankings changed.

The wider matrix tested caps 4 and 8. Cap 4 moved all former misses to rank 4
(20/20 gold@5, MRR 0.760). Cap 8 moved them to rank 8 (20/20 gold@10, MRR
0.7333). Cap 2 is strongest while retaining two cluster representatives.

## Latency

- depth-10 control: p50 39-43 ms; p95 69-73 ms
- depth-12 + cap-2: p50 30-42 ms; p95 77-83 ms

There is no demonstrated material latency cost at this scale. A larger corpus
and production load test are still required before making a latency claim.

## Recommendation

The smallest winner is candidate depth 12, final top-K 10, Jaccard threshold
0.90, and at most two initially selected rows per cluster followed by
relevance-order backfill.

Keep it feature-flagged. It improves gold@5 from 14/20 to 20/20 and MRR@10 from
0.700 to 0.800 with no observed regression, no model call, and stable repeats.

Do not ship from this benchmark alone. Boilerplate-heavy decoys are deliberate,
and near-identical text can encode real version/environment distinctions. Next
validate ordinary noise, stale/superseded facts, contradictions, ambiguous
cross-project facts, false-positive injection, and downstream executable
quality.

## Artifacts

Raw JSON, server logs, repeats, former-miss ranks, page sizes, and latency
summaries are under `artifacts/candidate-matrix/`. Final backfill validation is
in `isolated-backfill/`; the wider isolated sweep is in `isolated/`.
