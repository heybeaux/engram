# Experiment Spec: LLM-Assisted Memory Formation & Query Transformation

**Status:** planning only — no experiments run yet.
**Base repo:** `/Users/beauxwalton/projects/engram` (branch `staging`, no `main`).
**Downstream harness:** `/Users/beauxwalton/projects/mnemon` (v0.2).
**Date:** 2026-08-23

---

## 0. Question & interventions

- **B — LLM-assisted memory formation:** at store time, an LLM rewrites each raw
  observation into a retrieval-optimized memory that **preserves exact technical
  constraints** (types, units, arg order, key formats, async behavior,
  sentinel/return semantics) before embedding. Stored as union (raw ∪ formed).
- **C — LLM-assisted query transformation:** at recall time, an LLM
  rewrites/expands/decomposes the query into sub-queries before retrieval.
  Engram already exposes `multiQuery` metadata + per-memory `explanations` in
  `StructuredQueryResult` (`response_format=structured`) — C instruments this
  existing seam rather than inventing infra.

Evaluated as an **A–E ablation matrix** against retrieval-quality metrics *and*
mnemon's downstream executable-code lift, on **graduated adversarial corpora**.

---

## 1. Datasets / corpora

Never hard-code mnemon's seeded wording. Each condition is **generated
programmatically** from first-party fact templates (project name, symbol names,
units, key formats), disjoint from `tasks/seed-manifest.ts`. mnemon's 20 target
memories stay the ground-truth positives; all variation lives in the
distractor/perturbation pool seeded into an isolated `ENGRAM_USER_ID`
(`abl-<condition>-<seed>`). Mirrors the `scripts/noisy-corpus.ts` receipt pattern
(per-item write, receipt JSON, targeted cleanup) so every seeded ID is deletable.

| # | Condition | ~Memories | Construction |
|---|---|---|---|
| G0 | Clean | 20 + 0 | Only the 20 targets. Ceiling baseline. |
| G1 | Ordinary-unrelated noise | 20 + 400 | Off-topic facts from unrelated synthetic projects; distinct vocabulary. |
| G2 | Near-duplicate noise | 20 + 200 | 10 near-topic distractors/target, perturbed contract (reuse `distractor()` shape, template-generated). |
| G3 | Stale / superseded | 20 + 200 | 2–5 older versions/target, `source=HISTORICAL` + earlier `observedAt`, superseded by target. |
| G4 | Directly-contradictory | 20 + 100 | 1–3 opposite-contract memories/target, equal apparent authority. |
| G5 | Ambiguous cross-project | 20 + 200 | Same symbols across 3 fictional projects, different contracts; one is current. |
| F1 | Formation-quality (raw obs) | 20 raw + noise | Positives seeded as verbose raw observations burying the exact constraint in prose a naive summarizer would drop. **The condition B is designed to win.** |

**Sizing vs saturation:** largest corpus ≈ 420 memories/user. Serialized
single-POST ingestion keeps us far under the ~3.5k-parallel-chunk ceiling that
saturates `engram-embed`. See §5.

---

## 2. Ablation matrix (A–E)

Storage path and query path are orthogonal switches. B/C are **harness-owned
pre-processing shims** (call an LLM, then hit the same endpoints), so A is
byte-for-byte today's behavior.

| Cell | Storage | Query | Flags |
|---|---|---|---|
| **A (baseline)** | `POST /v1/memories`, `raw` verbatim, `layer=PROJECT` | original query → `POST /v1/memories/query?scope=user` | `formation=off`, `queryTransform=off`, `--recall-top-k 10` |
| **B** | LLM-formed: `content`=formed text, `raw` retained as provenance | original query | `formation=on`, `queryTransform=off` |
| **C** | current | transformed: {rewrite, expansions, decomposed}; issue each, RRF-fuse client-side, reapply top-k | `formation=off`, `queryTransform=on`, `fusion=rrf` |
| **D (both)** | LLM-formed | transformed | both on, `fusion=rrf` |
| **E (both + rerank)** | LLM-formed | transformed + rerank/context-composition over fused set (cross-encoder or LLM-listwise; dedup; contradiction/stale demotion) | all on, `rerank=on`. **Run only if D shows a positive CI-excludes-zero retrieval gain.** |

Every cell runs across G0–G5 + F1 and both models (Qwen 3.8 27B, Gemma 4 31B).

---

## 3. Retrieval metrics (independent of generation)

Computed from the recall response. Ground truth = mnemon's `expectedMemoryIds`
(the `allowed:true` items). Use `response_format=structured` to capture
`recallId`, `multiQuery`, `explanations`; capture `X-Query-Id` header. Harness
reads `items[]` (`id`, `score`, `source`, `content`, `allowed`) + mnemon's
`recall.precision@k`.

- **hit@k / recall@k** (k∈{1,3,5,10})
- **MRR** — mean 1/rank of first allowed target
- **nDCG@k** — binary gain, rank-discounted, ideal-normalized
- **precision@k** — mnemon already emits; null when no allowlist (exclude from means)
- **False-positive context-injection rate** (G3/G4/G5) — fraction of selected
  items that are stale/contradictory/wrong-project distractors. **The harm metric.**
- **Stability** — issue each query N=10× (fixed seed, no interleaved writes);
  report Jaccard of ID sets, rank-set variance, score variance
- **Score diagnostics** — `score` distribution, top1−top2 margin, **tie count**
  (the noisy report shows many `score:1.1` ties — real, must track)
- **Latency** — `latencyMs` envelope + wall-clock incl. transform call (C/D/E)
- **Cost** — transform + formation + rerank tokens × price

Retrieval is scored on mnemon's frozen recall snapshot without spending
generation calls.

---

## 4. Downstream metrics (mnemon)

**Run command** (from `package.json scripts.mnemon` / README):

```bash
export ENGRAM_API_KEY=... ENGRAM_USER_ID=abl-<condition>-<seed> ENGRAM_BASE_URL=http://localhost:3001
node dist/index.js run \
  --provider openai-compatible --provider-auth optional \
  --base-url http://127.0.0.1:11435/v1 \
  --model omlx/mlx-community--Qwen3.8-27B-8bit \  # or Gemma 4 31B id
  --thinking off --backend engram \
  --tasks .mnemon/<condition>-tasks --recall-top-k 10 \
  --trials 5 --seed abl-<condition>-<seed>-s1 \
  --bootstrap-samples 10000 --output json > report.json
```

C/D/E override recall via the transform shim; B/D/E re-seed formed memories first.

- **Paired executable-quality lift** — mnemon macro-mean overall delta
  (memory − no-memory), seeded 10k hierarchical bootstrap 95% CI.
  Overall = `0.25·convention + 0.60·executable + 0.15·securityReliability`.
- **Lift conditioned on retrieval hit vs miss** — partition by whether the
  allowed target was selected; report lift per stratum.
- **Regression metrics** — on G3/G4/G5, does memory *hurt*? Report memory-arm <
  no-memory-arm, correlate with false-positive injection.
- **Cross-model** — every cell × {Qwen, Gemma}. Gemma independently reproducing a
  B/C effect is the generalization bar RESULTS.md set.

---

## 5. Reproducibility controls

- **Seeds:** ≥3 preregistered run seeds/cell; corpus generation is seeded
  (deterministic templates → deterministic distractor text/IDs in a receipt).
- **Pinned versions:** fixed Qwen/Gemma IDs, oMLX build, `temperature=0.2`,
  `--thinking off`, digest-pinned gate image, mnemon commit, Engram `staging`
  commit. Formation/transform/rerank use a fixed LLM + **versioned prompt string**
  (`promptVersion`) recorded per record.
- **Embedding-provider pinning:** record per run. Local `engram-embed` only for
  small corpora (≤~420 mems) and **serialized ingestion**. Larger → **OpenAI
  embeddings** (documented workaround).
- **Saturation guardrail (mandatory pre-run gate):** never bulk/parallel-ingest
  graduated corpora against local `engram-embed` — it saturates ~3.5k parallel
  chunks, emits malformed sparse vectors pgvector rejects (`22P02`), leaving no
  embedding → empty recall (tanked a prior LongMemEval to 1/10). Controls:
  (a) serialize writes one-POST-at-a-time;
  (b) after seeding, poll `GET /v1/memories/embedding-status` and **abort if any
  seeded memory lacks an embedding** (call `POST /v1/memories/embedding-retry`,
  re-verify);
  (c) prefer OpenAI embeddings above the ceiling.
  **No experiment starts until embedding-status is 100% green for that user.**
- **Provenance capture (per query, run-scoped JSONL):** original query;
  transformed queries + sub-queries; `layers`/filters/`agentBoost`; candidate set
  per sub-query w/ `score`/`source`; fusion strategy + RRF params; rerank
  decisions (kept/demoted/deduped + reason); selected `context` + `snapshotHash`;
  `recallId` + `X-Query-Id`; formation input→output pairs; model + `promptVersion`;
  latency; token cost.

---

## 6. Success thresholds (finalized after baseline)

Thresholds are set **after** cell A establishes baseline distribution + CI width.
Illustrative framing:

- **Ship B** if, on F1 + G2–G5, B beats A on retrieval hit@5 **and** downstream
  lift with 95% bootstrap CI excluding zero, on **both** models, with **no**
  regression on G0.
- **Ship C** if C beats A on MRR/nDCG@5 + downstream lift, CI excluding zero,
  without raising false-positive injection on G3/G4/G5 beyond a set tolerance.
- **Ship D over B or C** only if D's lift exceeds the better single intervention
  by a margin whose CI excludes zero (guards against additive-cost-no-benefit).
- **Ship E** only if it reduces false-positive injection on G3/G4/G5 *and*
  preserves G0/F1 lift.
- A single positive seed is never sufficient — claims require CI-excludes-zero
  across preregistered seeds.

---

## 7. Cost & latency budgets

- **Generation calls/cell:** `valid_tasks × trials × 2` = 20×5×2 = 200/run. Full
  matrix ≈ 5 cells × 7 corpora × 2 models × 3 seeds ≈ 210 runs ≈ 42k generation
  calls — local oMLX, compute-bound not $-bound. `--gate-timeout 60000`,
  `--model-timeout 120000`.
- **Intervention LLM overhead:** formation = one call/seeded memory (~420 max,
  one-time/seed). Transform = one call/task-query (×20). Rerank (E) = one
  call/query over ≤k candidates. Hard cost cap/full-matrix on a small hosted
  model, recorded per record; abort a cell if projected cost exceeds cap.
- **Latency budget:** added recall latency ≤ transform p95 + fusion (target <2s/q
  for C; <4s for E). Report recall `latencyMs` separately from transform
  wall-clock.

---

## Implementer notes (from repo inspection)

- Engram already has query-expansion plumbing: `StructuredQueryResult.multiQuery`
  + per-memory `explanations` via `POST /v1/memories/query?response_format=structured`.
  C should populate/consume these, not build parallel infra. `X-Query-Id` +
  `recallId` give free retrieval-signal correlation.
- Score ties are common (`score:1.1` across many items) and `allowed:false`
  distractors get injected into `context` — false-positive-injection and
  tie-count metrics are load-bearing, not theoretical.
- `GET /v1/memories/embedding-status` + `POST /v1/memories/embedding-retry` exist
  — the concrete hooks for the saturation guardrail.
- `CreateMemoryDto` accepts both `raw` and `content` (+ `source`, `layer`); B
  stores formed text in `content`, retains `raw` for provenance — **no schema
  change.**
- Run: `node dist/index.js run` (built) / `npm run mnemon -- run` (tsx).
  Seed/cleanup: `npm run seed:noisy` / `cleanup:noisy` (`scripts/noisy-corpus.ts`).
