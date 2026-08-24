# Engram R&D: LLM-Assisted Memory Formation & Query Transformation — Phase 1

**Owner:** Rook · **Requested by:** Kit (brief) / Beaux (approval) · **Date:** 2026-08-23
**Phase:** 1 (read-only research). No code, data, or migrations touched.
**Base branch:** `staging` (there is no `main`; staging is newest + our R&D target).

This directory holds the Phase 1 deliverables for the initiative to evaluate two
interventions in Engram's memory lifecycle:

- **Formation** — use an LLM at *store* time to produce a more precise, retrievable
  memory representation.
- **Query transformation** — use an LLM at *recall* time to rewrite/expand/decompose
  the query before retrieval.

## Documents

| # | File | What it is |
|---|---|---|
| 1 | [`01-current-state-map.md`](01-current-state-map.md) | Ingestion→recall data-flow audit, score semantics, data model, intervention points, existing LLM usage |
| 2 | [`02-research-memo.md`](02-research-memo.md) | Literature review (formation + query-transform), blind-spot pass, promising-vs-hype read, cited primary sources |
| 3 | [`03-experiment-spec.md`](03-experiment-spec.md) | A–E ablation matrix, graduated corpora, retrieval + downstream metrics, reproducibility controls, budgets |
| 4 | [`04-finding-tie-domination.md`](04-finding-tie-domination.md) | **Blocking finding.** Retrieval ranking is decided by array order among tied scores, not by score. Changes the required sequencing. |

## Executive summary

**The mnemon evidence points at ranking-under-noise and corpus hygiene as our
binding constraint — not representation poverty.** Rank-1 retrieval collapsed
20/20 → 12–13/20 once distractors were added; the biggest observed harms came
from duplicate and incomplete memories. This shapes which intervention is likely
to pay off.

**Formation (store-time):** the closest published analogue to "replace raw text
with LLM-extracted structure" is a *negative* result — CogCanvas (arXiv:2601.00821,
2026), a controlled ablation where extracted artifacts **never beat naive RAG** and
lost 15.9–22 pts to verbatim chunks; the only design that matched verbatim was
**raw ∪ derived (union)**. Anthropic's **Contextual Retrieval** (Sep 2024) is the
best-evidenced *additive* formation win (35–67% retrieval-failure reductions).
**Implication: pursue formation as union storage + a contextualizing prepend,
never as raw-replacement.** Engram's schema already supports this (retain `raw`,
fill `content`) with no migration.

**Query transformation (recall-time):** the intervention most at risk of being a
dressed-up "more inference compute" effect. Published evidence shows the *sign*
of the effect flips per-query (rewriting helps some, harms 23–42% of others). It
**must** be tested against a latency/call-count-matched reranker baseline, not
just against A. Engram already exposes `multiQuery` + `explanations` plumbing to
instrument this without new infra.

**Findings from the prototype build that corrected this research** (see
`01-current-state-map.md` errata + §7):
- Local Engram is on port **47291**, not 3001 (3001 is whalehawk provider-server).
- **`content` is a legacy alias for `raw`, not a second field.** The original plan
  to "store formed text in `content`, keep `raw` for provenance" would have been a
  **silent no-op**. Union is instead realized inside the single embedded string
  (contextual prefix + verbatim observation, `prefixLength` recorded so the
  original is recoverable byte-for-byte) — which is Anthropic's Contextual
  Retrieval shape and still satisfies raw ∪ derived.
- The local embedder **500s under parallel recall**, which silently degraded arm C
  into the baseline on the first smoke run — a bias against the intervention we
  are trying to measure. Now mitigated with concurrency limiting.
- A **pre-existing pgvector dimension mismatch (1536 vs 384)** is logged on write.
  Unrelated to this work; recommend a separate ticket.

**Correctness smell found during the audit (independent of the R&D):** recall
scores exceed [0,1] because keyword-rescue hits are hard-coded to **1.25** (FTS)
and **1.1** (ILIKE) and graph hits get **×1.2**. This is why wrong distractors
tie correct memories at 1.25. Scores are relative sort ranks, not probabilities.
Recommend a ticket to document/calibrate this regardless of the initiative.

## Recommended sequencing (REVISED after the tie-domination finding)

Phase 2 measurement work produced a blocking result (see
[`04`](04-finding-tie-domination.md)): **18/20 queries end in a 5-way tie at the
top score, and only 2/20 top-1 results are decided by score at all.** Better
candidates cannot move top-1 when the tie-break decides it, so the A–E matrix
would largely measure Postgres row order.

Sequencing is therefore now:

1. **Fix score semantics / tie-breaking first** (was step 2, now mandatory and
   first). The hard-coded rescue constants (FTS `1.25`, ILIKE `1.1`) and the
   `×1.2` graph boost collapse distinct candidates onto identical scores.
2. **Re-establish baseline (cell A)** with tie-aware metrics — always report the
   four-way tie envelope, never `asReturned` alone.
3. **Formation as union + contextual prepend** (cell B) on the F1 corpus it's
   designed to win.
4. **Query transform** (cell C) **only vs the compute-matched control.**
5. Cells D/E only if D shows a CI-excludes-zero retrieval gain.

## Hard constraints honored

- No production deploy, no destructive migrations, no `prisma migrate dev`.
- Raw memories + API compatibility preserved (union storage, additive metadata).
- All prototypes will be feature-flagged and reversible.
- Large-corpus experiments route around the **`engram-embed` saturation bug**
  (serialized ingestion + `embedding-status` gate + OpenAI-embedding fallback).

## Open questions for Beaux (only the ones that change architecture/cost)

1. **Formation scope:** OK to constrain formation to **union storage + contextual
   prepend** (evidence-backed) and explicitly *rule out* raw-replacement and
   store-time "predicted queries" (unverified) for the prototype?
2. **Query-transform fairness bar:** agree that C must beat a **compute-matched
   reranker baseline**, not just cell A, before it earns complexity?
3. **Prototype green-light:** the brief authorizes proceeding into the smallest
   feature-flagged vertical slice after Phase 1. Want me to proceed to that
   (instrumentation + baseline run on the small/safe corpora), or hold for your
   review of these docs first?
