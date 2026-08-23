# Research Memo: LLM-Assisted Memory Formation and Query Transformation in Engram

**Audience:** Engram R&D / architecture decision
**Scope:** Research and analysis only. No code or data was modified.
**Date:** 2026-08-23

---

## 0. Framing and the evidence we already own

We are evaluating two interventions in Engram's memory lifecycle:

- **(A) LLM-assisted memory formation** at store time — spend an LLM call when a memory is written to produce a richer representation (canonical fact, retrieval synopsis, structured entities/relations, temporal scope, provenance, confidence, predicted queries).
- **(B) LLM-assisted query transformation** at recall time — rewrite/expand/decompose the user's query before retrieval.

Our own prior evidence (mnemon benchmark, `/Users/beauxwalton/projects/mnemon`, `RESULTS.md` + `reports/*.json`) is the anchor and, notably, it is *not* about either intervention — it measures the value of *relevant* retrieved memory on executable coding output:

- Qwen 3.8 27B, clean corpus: **0.820 vs 0.601, +0.219 lift**, 95% CI [0.117, 0.317], target memory rank-1 on 20/20 tasks.
- Qwen, 200 distractors: **+0.101 lift**, CI [0.014, 0.195], rank-1 on only 13/20.
- Gemma 4 31B, 200 distractors: **+0.117 lift**, CI [0.041, 0.203], rank-1 on 12/20.

The brief also records four uncomfortable findings from the seeded/ablation runs: near-duplicate memories roughly **halved** the benefit; incomplete memories could **harm** output; the grader produced **out-of-range scores (1.10, 1.25)**; and wrong distractors sometimes **tied** correct memories at rank 1. I could confirm the headline lifts and the noisy-corpus rank degradation directly in `RESULTS.md`; the duplicate-halving, incomplete-harm, and >1.0 score figures are stated in the brief's prior-evidence summary and I did not independently re-derive them from the raw `reports/*.json` in the time available. They should be treated as reported-by-us, not yet re-verified here.

**The single most important thing this data already tells us:** the binding constraint in our own system is *retrieval ranking under noise* (rank-1 fell from 20/20 to 12–13/20), and the biggest observed harms come from *corpus quality* (duplicates, incompleteness), not from a shortage of representation cleverness. Keep this in mind through the whole memo — it directly predicts which of the two interventions will pay off.

---

## 1. Approaches reviewed — Memory Formation

For each: mechanism, evidence/claims, limitations, source. **Published evidence** and **my inference** are separated explicitly.

**Raw + derived multi-representation storage.** *Mechanism:* keep the verbatim text AND store derived artifacts (summary, entities, synthetic queries) alongside, retrieving over either. *Evidence:* the strongest recent controlled result argues *for keeping raw and against replacing it* — see "Verbatim Chunks" below. *Limitation:* storage and index bloat, and you must decide what to embed. *My inference:* this is the safe default; it dominates "replace raw with derived."

**Proposition / atomic-fact decomposition.** *Mechanism:* an LLM rewrites a passage into self-contained atomic propositions, each embedded and retrieved as its own unit. *Evidence:* "Dense X Retrieval: What Retrieval Granularity Should We Use?" (Chen et al., arXiv:2312.06648, Dec 2023) reports proposition-level units outperform sentence/passage units for dense retrieval and downstream QA, because each unit is denser in query-relevant information. *Limitation:* decomposition is itself an LLM step that can drop or distort facts; propositions lose surrounding context; more units = more index. *Source:* Chen et al., 2023.

**Entity-relation extraction (triples / knowledge graph).** *Mechanism:* extract (subject, relation, object) triples and store a graph, retrieving by graph traversal + vector. *Evidence:* used in Mem0g and Zep/Graphiti (below); helps multi-hop and temporal reasoning. *Limitation:* extraction error compounds; graph construction is expensive and brittle; a 1-hop graph did *not* recover the loss from discarding verbatim text in the CogCanvas ablation. *Source:* see Mem0/Zep.

**Summarization-for-retrieval.** *Mechanism:* store an LLM summary as the retrievable representation. *Evidence:* helps when raw is long/noisy. *Limitation:* lossy — summaries discard the exact tokens a future query may need. *My inference:* summaries are a good *auxiliary* field, a poor *replacement*.

**HyDE-style synthetic queries stored at index time ("predicted queries").** *Mechanism:* at store time, generate the questions this memory would answer, embed those, and index them so a real query matches a synthetic query. *Evidence:* no clean published isolation of *store-time* synthetic-query indexing that I could verify; it is the inverse of HyDE (Sec 2), which generates a hypothetical *document* at query time. *Limitation:* predicted queries are guesses; they can bias the memory toward anticipated (and away from novel) uses. *My inference:* plausibly useful for FAQ-shaped memory, unproven for open-ended agent memory. **Flag as unverified.**

**Contextual Retrieval (Anthropic).** *Mechanism:* before embedding a chunk, prepend a 50–100 token LLM-generated context sentence situating the chunk in its parent document; index both contextual embeddings and contextual BM25. *Evidence (published):* Published **Sep 19, 2024**. Contextual embeddings alone cut top-20 retrieval failure **35%** (5.7%→3.7%); + contextual BM25 **49%** (→2.9%); + reranking **67%** (→1.9%). *Limitations (their own):* pointless under ~200k tokens (just stuff full content in context); results vary by embedding model, chunk size/overlap; reranking adds latency; "evaluate within your use case." *Source:* anthropic.com/engineering/contextual-retrieval, 2024-09-19. **This is the best-evidenced formation technique in the set** and is a formation-side (index-time) win, not a query-side one.

**RAPTOR (hierarchical summaries).** *Mechanism:* recursively cluster + summarize chunks bottom-up into a tree; retrieve from multiple abstraction levels. *Evidence (published):* Sarthi et al., ICLR 2024 — SOTA on multi-step QA (e.g., QuALITY, NarrativeQA) vs standard chunk RAG. *Limitation:* tree build is expensive and static; summary nodes are lossy; benefit concentrates on *holistic/multi-hop* questions, less on point-lookup. *Source:* Sarthi et al., ICLR 2024.

**MemGPT / Letta.** *Mechanism:* OS-style paging between in-context "main memory" and out-of-context external store; the LLM manages its own memory via tool calls. *Evidence (published):* Packer et al., arXiv:2310.08560 (Oct 2023) — extends effective context for long docs and multi-session chat. *Limitation:* it is a *control loop / context-management* pattern, not a representation recipe; adds many extra LLM calls and non-determinism. *Source:* Packer et al., 2023 (now the Letta framework).

**Mem0.** *Mechanism:* at store time an LLM extracts salient facts and issues ADD/UPDATE/DELETE/NOOP against existing records; Mem0g adds an entity/triple graph. *Evidence (published):* arXiv:2504.19413 (ECAI 2025). Vendor-reported LOCOMO ~67% LLM-judge in the paper (later vendor blog figures ~92.5 LOCOMO / ~94.4 LongMemEval), ~1,764 tokens/conversation vs ~26k full-context, p95 search ~0.2s. *Limitation:* benchmarks are largely vendor-run; the LLM UPDATE/DELETE step is exactly where silent corruption/over-deletion can enter. *Source:* Chhikara et al., 2025. **Treat vendor numbers as claims, not independent evidence.**

**Zep / Graphiti (temporal knowledge graph).** *Mechanism:* bi-temporal knowledge graph (tracks valid-time and system/ingestion-time; invalidates edges when facts change) synthesizing conversational + structured data. *Evidence (published):* Rasmussen et al., arXiv:2501.13956 (Jan 2025) — DMR 94.8% vs MemGPT 93.4%; LongMemEval up to +18.5% accuracy and ~90% lower latency vs baseline. *Limitation:* vendor-authored; graph construction cost/complexity; extraction errors propagate; DMR is near-saturated (94 vs 93 is a thin margin). *Source:* Rasmussen et al., 2025.

**Cross-cutting caution — "Verbatim Chunks Beat Extracted Artifacts" (CogCanvas).** *Mechanism:* a *controlled ablation* — same retriever/reranker/reasoner/judge, swap only the stored representation: LLM-extracted typed artifacts vs verbatim chunks. *Evidence (published):* An, arXiv:2601.00821 (2026). Verbatim beat extracted artifacts by **+15.9 pts LoCoMo (43.9 vs 28.0)** and **+22.0 pts LongMemEval-S (67.4 vs 45.4)**; a 1-hop semantic graph did not recover the gap; five confound controls reproduced it; extracted-artifacts alone *never beat naive RAG*. The one design that matched verbatim was **chunks ∪ artifacts (union)**. *Why load-bearing:* this is the closest published analogue to Intervention A, and it is a *negative* result for "replace raw with LLM-derived structure." *Source:* An, 2026.

---

## 2. Approaches reviewed — Query Transformation

**Single query rewrite.** *Mechanism:* LLM rewrites one query into one cleaner query (spelling, context resolution, term normalization). *Evidence:* "Not All Queries Need Rewriting" (arXiv:2603.13301, 2026) — rewriting helps some queries and *hurts others*; harm co-occurs with reduced lexical alignment to the gold doc (rewriting swaps domain terms on already-good queries). Controlled conversational rewrite + last-turn concatenation gave consistent gains; retrieval-oriented keyword rewrites consistently hurt. *Limitation:* on already-well-matched queries it is net-negative. *Source:* 2026.

**Multi-query expansion / RAG-Fusion.** *Mechanism:* generate N query variants, retrieve for each, fuse. *Evidence:* RAG-Fusion (Raudaschl, 2023/2024; GitHub Raudaschl/rag-fusion) reports robustness gains from diverse angles; the fusion step rests on RRF (below). *Limitation:* N× retrieval cost and latency; broadening the pool in the wrong direction just gives the reranker more wrong things to sort. *Source:* Raudaschl, 2023–24.

**Query decomposition (multi-hop / least-to-most).** *Mechanism:* split a complex query into sub-queries, retrieve per sub-query, compose. *Evidence:* helps multi-hop QA (MultiHop-RAG, arXiv:2401.15391; "Question Decomposition for RAG," arXiv:2507.00355). "When Should Queries Be Decomposed?" (arXiv:2606.08577, 2026) finds it is *stage-* and *condition-dependent* — decomposition helps multi-condition retrieval but is not universally good. *Limitation:* over-decomposition fragments intent; more calls, more latency; wrong on single-hop queries. *Source:* 2024–2026.

**Step-back prompting.** *Mechanism:* abstract the specific question to its general principle, retrieve/reason at that level, then descend. *Evidence:* Zheng et al. (Google DeepMind), arXiv:2310.06117 (Oct 9 2023) — e.g., +7%/+11% MMLU physics/chem, +27% TimeQA, +7% MuSiQue on the *reasoning* tasks tested. *Limitation:* the paper is about reasoning, not retrieval ranking per se; abstraction can retrieve too-general context for point lookups. *Source:* Zheng et al., 2023.

**HyDE (hypothetical document embeddings).** *Mechanism:* LLM writes a hypothetical answer/document; embed *that* to find real neighbors; the encoder's bottleneck filters hallucinated specifics. *Evidence:* Gao et al., "Precise Zero-Shot Dense Retrieval without Relevance Labels," arXiv:2212.10496 (Dec 2022, ACL 2023) — beats unsupervised Contriever, near fine-tuned retrievers, zero-shot, cross-lingual. *Limitation:* strongest exactly where you *lack* a tuned retriever/labels; on a well-tuned domain retriever the gain shrinks, and it can inject wrong terms. *Source:* Gao et al., 2022/23.

**Entity/keyword extraction for metadata filtering & self-query.** *Mechanism:* LLM extracts filters (source, date, type, entity) from the query and applies them as structured pre-filters. *Evidence:* Multi-Meta-RAG (Springer, 2024) — small-LLM metadata extraction restricting candidate sets improves multi-hop RAG; LangChain "self-query" is the widely-used reference implementation. *Limitation:* an over-tight filter can *exclude the gold doc entirely* (bounded-recall failure that no reranker can fix). *Source:* 2024.

**RRF / retrieval fusion.** *Mechanism:* combine multiple ranked lists by summing 1/(k+rank), score-agnostic. *Evidence:* Cormack, Clarke & Buettcher, SIGIR 2009 — RRF outperforms Condorcet and learned rank fusion; now the standard hybrid (BM25 + vector) merge. *Limitation:* purely rank-based; if all input lists miss the gold doc, fusion cannot recover it. *Source:* Cormack et al., 2009. **This is a candidate-generation/fusion mechanism, and its evidence is the most robust in the section — but it is not "LLM query transformation."**

---

## 3. Blind-spot pass — challenging the brief

### 3.1 Attribution: representation vs candidate-generation vs reranking vs "just more compute"

The brief treats A and B as two "memory-lifecycle interventions." The more useful decomposition of *why any RAG number moves* is four independent levers:

- **(a) Better representation** — what is stored/embedded (Intervention A; Contextual Retrieval; propositions).
- **(b) Better candidate generation** — how many/which candidates enter the pool (multi-query, HyDE, hybrid+RRF, self-query filters).
- **(c) Better reranking** — reordering a fixed pool (cross-encoder rerankers).
- **(d) Simply spending more inference compute** — any extra LLM call at store or query time.

Contextual Retrieval isolates (a) cleanly and it is the best-evidenced. RRF isolates fusion within (b). A cross-encoder reranker isolates (c) and, per Anthropic's own numbers, reranking alone drove a large chunk of the 49%→67% improvement — i.e. much of what people attribute to fancy formation is actually **reranking (c)** doing the work.

**Which intervention is most likely a dressed-up "more compute" effect? Intervention B (query transformation).** Query rewrite/expansion/decomposition each add LLM calls at recall time whose measured "lift" is easily confounded with (d). The "Not All Queries Need Rewriting" and "When Query Expansion Hurts RAG" evidence shows the *sign* of the effect is query-dependent — a hallmark of a weak, compute-driven intervention rather than a structural improvement. If we A/B B without a **latency- and call-count-matched control** (e.g., simple hybrid BM25+vector+RRF+reranker, no LLM rewrite), we will almost certainly misattribute a reranker/compute win to "smart queries."

Intervention A is *less* likely to be pure-compute, because the CogCanvas and Contextual-Retrieval ablations hold the pipeline fixed and vary only the stored representation. But A has its own trap: the CogCanvas result says the naive version of A (extract structured artifacts to *replace* raw) is *negative*. The only representation change with clean positive isolation is Contextual Retrieval's *additive context prepend on raw chunks* — which is closer to "augment raw" than to "the LLM synthesizes a canonical fact."

### 3.2 Failure modes the brief under-weights

- **Memory poisoning / persistent compromise.** Store-time LLM formation and recall-time transformation both widen the attack surface. PoisonedRAG (Zou et al., 2024) achieves >90% attack success with ~5 injected texts/question; AgentPoison (NeurIPS 2024) shows poisoned entries in *long-term memory* persist across sessions and users. An LLM that rewrites memories at store time can *launder* an injection into an authoritative-looking "canonical fact." The brief lists provenance/confidence as *features*; they are also *mitigations that must be load-bearing*, not metadata.
- **Hallucinated facts injected at formation.** This is the highest-severity A-specific risk. An extractor that emits a confident wrong "canonical fact" is worse than storing raw, because raw is at least faithful. Our own mnemon finding that *incomplete* memories can harm output is a direct empirical warning that low-fidelity formation degrades outputs.
- **Query drift / intent distortion.** Documented and quantified: expansion harm rates ~23–42% depending on aggressiveness; harm correlates with lost lexical alignment. B can silently answer a *different* question than the user asked.
- **Latency & cost.** A adds a synchronous (or queued) LLM call per write — at Engram's stated ~183k–344k memory scale this is a real ingestion-throughput and cost line, and our memory notes already record reembed/ingest pipelines saturating. B adds one-to-N LLM calls on the *hot recall path*, directly hitting TTFT.
- **Privacy leakage.** Sending memory contents (A) or user queries (B) to an LLM for reformulation is a new data-egress path; if that LLM is external, it is a compliance surface the brief does not mention.
- **Non-determinism / stability.** Both interventions inject LLM stochasticity into what should be a stable index. Our own out-of-range grader scores (1.10/1.25) and cross-run rank instability already show how fragile measurement is; adding non-deterministic formation/rewrite makes regression detection and reproducibility harder. Formation non-determinism is *permanent* (baked into the stored record); query non-determinism is at least per-request.

### 3.3 What's missing entirely

- **Update / conflict / invalidation semantics.** The brief is store-and-recall. Real memory *changes* — facts get superseded (our own memory files are full of "SUPERSEDED" notes). Mem0's ADD/UPDATE/DELETE and Zep's bi-temporal invalidation exist precisely for this. Without it, LLM formation just manufactures more contradictory records faster.
- **Deduplication as a first-class control.** Our own data says near-duplicates *halved* the benefit. That makes dedup/canonicalization a higher-ROI formation-time lever than richer per-record representation — and it is barely implied by the brief.
- **Evaluation harness for the interventions themselves.** mnemon measures memory *value*, not A or B. We need call-count/latency-matched controls, and end-to-end task metrics (not just retrieval recall), before committing.
- **The recall-quality ceiling.** Our binding constraint is ranking under noise. Neither A nor B is the most direct fix — a **cross-encoder reranker + hybrid BM25/vector + RRF** is, and it has the strongest, most independent evidence.

---

## 4. Promising vs. fashionable-but-unsupported

**Real evidence, worth building (in priority order):**

1. **Reranking + hybrid (BM25+vector) + RRF.** Not one of the two proposed interventions, but the most robustly evidenced fix for our actual bottleneck (rank-1 collapsing under distractors). RRF: Cormack 2009. Reranking's large marginal effect: Anthropic 2024. **Do this first.**
2. **Contextual Retrieval (additive context prepend on raw chunks).** Best-evidenced *formation* technique (Anthropic 2024, clean isolation, 35–49% failure reduction). It is a conservative form of Intervention A: it *augments* raw, does not replace it.
3. **Deduplication / canonicalization at store time.** Directly targets our own strongest negative finding (duplicates halved the benefit). Cheap, deterministic, high-ROI.
4. **Union storage (raw ∪ derived), never derived-only.** CogCanvas (2026) shows replace-raw is a *negative* result; union matched verbatim. If we do A, do it additively.
5. **HyDE / step-back — situationally.** HyDE helps most where a *tuned* domain retriever is absent (Gao 2022/23); step-back helps *reasoning-heavy multi-hop* (Zheng 2023). Deploy behind a router, not globally.

**Fashionable but weakly/negatively supported for our case:**

- **Replacing raw memory with LLM-extracted "canonical facts"/typed artifacts** — the headline framing of Intervention A. Closest controlled evidence (CogCanvas) is *negative*: extraction is lossy distillation and alone never beat naive RAG. High hallucination/poisoning risk. **Do not ship as a replacement.**
- **Store-time "predicted queries" (HyDE-in-reverse) as a primary index** — I could not verify clean published evidence isolating this for open-ended agent memory. **Unverified; prototype-and-measure only.**
- **Global LLM query rewrite/expansion (Intervention B) applied unconditionally** — evidence is explicitly mixed and sign-flips per query (23–42% harm rates; "Not All Queries Need Rewriting," 2026). Most likely to be a **dressed-up "more compute" effect**. If pursued, gate it (selective/router-based) and always test against a compute-matched reranker baseline.
- **Full temporal knowledge graphs (Zep/Graphiti, Mem0g) as the near-term bet** — real and interesting, but the supporting benchmarks are largely vendor-run and near-saturated (DMR 94.8 vs 93.4), and graph construction adds cost/error propagation. Adopt the *idea* we're missing (update/invalidation semantics) before adopting the heavyweight graph.

**Bottom line for the architecture decision:** Our own numbers say the problem is *ranking under noise* and *corpus hygiene*, not representation poverty. The highest-confidence moves (reranker+hybrid+RRF, dedup, additive contextual embeddings) are largely *outside* the two proposed interventions or are the *conservative additive* form of A. Intervention A as literally framed (replace raw with LLM-synthesized canonical facts) runs against the best controlled evidence; Intervention B is the one most at risk of being a compute mirage and should only be tested selectively against a compute-matched control. Verify every vendor number and any claim marked "unverified" above before it enters a design doc.

---

## Sources

- Anthropic, "Contextual Retrieval," Sep 19 2024 — https://www.anthropic.com/engineering/contextual-retrieval
- Sarthi et al., "RAPTOR," ICLR 2024 — https://openreview.net/forum?id=GN921JHCRw
- Gao et al., "Precise Zero-Shot Dense Retrieval without Relevance Labels" (HyDE), arXiv:2212.10496, Dec 2022 / ACL 2023 — https://arxiv.org/abs/2212.10496
- Chen et al., "Dense X Retrieval: What Retrieval Granularity Should We Use?", arXiv:2312.06648, Dec 2023 — https://arxiv.org/abs/2312.06648
- Chhikara et al., "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory," arXiv:2504.19413, ECAI 2025 — https://arxiv.org/abs/2504.19413
- Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture for Agent Memory," arXiv:2501.13956, Jan 2025 — https://arxiv.org/abs/2501.13956
- Packer et al., "MemGPT: Towards LLMs as Operating Systems," arXiv:2310.08560, Oct 2023 — https://arxiv.org/abs/2310.08560
- Zheng et al. (Google DeepMind), "Take a Step Back: Evoking Reasoning via Abstraction in LLMs," arXiv:2310.06117, Oct 2023 — https://arxiv.org/abs/2310.06117
- Cormack, Clarke, Buettcher, "Reciprocal Rank Fusion...," SIGIR 2009 — https://dl.acm.org/doi/10.1145/1571941.1572114
- Raudaschl, "RAG-Fusion" — https://github.com/Raudaschl/rag-fusion
- MultiHop-RAG, arXiv:2401.15391 — https://arxiv.org/abs/2401.15391
- "Question Decomposition for RAG," arXiv:2507.00355 — https://arxiv.org/abs/2507.00355
- "When Should Queries Be Decomposed?", arXiv:2606.08577, 2026 — https://arxiv.org/abs/2606.08577
- "Not All Queries Need Rewriting...", arXiv:2603.13301, 2026 — https://arxiv.org/html/2603.13301
- Multi-Meta-RAG (self-query metadata filtering), Springer 2024 — https://link.springer.com/chapter/10.1007/978-3-031-81372-6_25
- An, "Verbatim Chunks Beat Extracted Artifacts / CogCanvas," arXiv:2601.00821, 2026 — https://arxiv.org/abs/2601.00821
- Zou et al., "PoisonedRAG," 2024 — https://arxiv.org/abs/2402.07867
- Chen et al., "AgentPoison," NeurIPS 2024 — https://proceedings.neurips.cc/paper_files/paper/2024/file/eb113910e9c3f6242541c1652e30dfd6-Paper-Conference.pdf
- mnemon benchmark (internal), `/Users/beauxwalton/projects/mnemon/RESULTS.md` + `reports/*.json`

*Note on dating: several arXiv IDs above carry 2026-style identifiers (e.g., 2601.*, 2603.*, 2605.*) as surfaced by search in Aug 2026. Where a claim rests on one of these very recent, not-yet-widely-cited preprints (CogCanvas, the query-rewrite-harm papers), I have flagged it as recent/single-source rather than settled.*
