# Synthetic lifecycle diagnostic

Run only against dedicated containers, never a restored/live database. The harness refuses URLs other than `127.0.0.1:55441/engram_lifecycle_synthetic` and Redis `127.0.0.1:16391`. Start `pgvector/pgvector:pg16` with `POSTGRES_DB=engram_lifecycle_synthetic`, `POSTGRES_PASSWORD=lifecycle_scratch`, publishing 55441, and `redis:7-alpine` publishing 16391. Deploy repository migrations into that empty database. Each arm needs a freshly recreated DB and empty dedicated Redis.

From the repository root:

```sh
DATABASE_URL=postgresql://postgres:lifecycle_scratch@127.0.0.1:55441/engram_lifecycle_synthetic \
REDIS_URL=redis://127.0.0.1:16391 EMBEDDING_PROVIDER=local \
EMBEDDING_MODEL=bge-base-en-v1.5 VECTOR_SEARCH_MODEL=bge-base-en-v1.5 \
LOCAL_EMBED_URL=http://127.0.0.1:8080 LOCAL_EMBED_MODEL=bge-base-en-v1.5 \
LOCAL_EMBED_DIMENSIONS=768 ENSEMBLE_ENABLED=true RERANK_ENABLED=false \
NODE_ENV=test OPENAI_API_KEY=unused-local-test LLM_PROVIDER=lmstudio \
LMSTUDIO_URL=http://127.0.0.1:11435/v1 LLM_MODEL=openchat-3.6-8b-20240522-8bit \
node scripts/audit/lifecycle-evaluation.cjs
```

The first run must be unchanged. Optional separate diagnostic arm: set `LIFECYCLE_SERIAL_EMBED=1 LIFECYCLE_DIAGNOSTIC_ENUM=1`. These serialize actual embedding HTTP requests and add missing DREAM_CYCLE enum **only to the guarded scratch database**. This is an intentionally modified configuration, not staging success. Existing local services must be available; no model downloads/restarts occur.

Inputs are frozen `lifecycle-corpus.json`. They have never been used to tune product ranking. HTTP ingestion includes actual async extraction/dedup; queries use actual HTTP memory-query endpoint. Elasticsearch is the existing test helper's no-keyword-hit override. Real consolidation stage runs at default cluster threshold .82/minimum 3, not full dream orchestration. A subsequent artificial aged/unused/low-importance state tests the actual archival stage. Source creation times are changed only in this synthetic DB. Neither tiering nor the dream scheduler is exercised.

Output defaults `/tmp/lifecycle-results.json`; override `LIFECYCLE_OUTPUT`. It records all raw results, extraction, sources and eligibility at each boundary. `matchedFacts` are lexical anchors, **not semantic entailment**. `relevant` means original labelled source only; a semantically valid generated summary is not automatically judged irrelevant. Human/independent review must judge all summaries and returned records, including negation, attribution and date provenance. Non-2xx queries cannot count as abstention. No-answer describes retrieval abstention, not an answer generator.

`appCloseReturned` does not imply process exit: check process termination separately. The observed full app required SIGTERM after close returned. Remove only the two dedicated containers when finished. Original September 6 results used an earlier harness revision whose misleading `cleanShutdown:true` field meant only app.close returned; the accompanying report corrects it. Controlled enum repair was executed manually while the run was ingesting; the final reusable harness now gates that exact repair behind its explicit flag.

## September 8 independent holdout and safety gate

`lifecycle-independent-corpus.json` was independently authored and labelled before
any results, with conditional revocation, conjunctive prerequisites, ownership
versus mention, a unique collection receipt, and explicit unknown evidence.
Its canonical JSON SHA256 is
`3aa677065228336cf3287ea13d94eabac80c2aff7c20b370185e9ba86c355d02`.
`lifecycle-heldout-corpus.json` is only an entity/value variant of the original
scenario templates; do not call it independent held-out evidence.

`run-lifecycle-diagnostic.py` recreates ONLY the dedicated synthetic database in
containers named `engram-eval-pg-20260908` and `engram-eval-redis-20260908`.
It records process exit independently, allowing 20 seconds after app.close and a
900-second overall deadline. Create those dedicated containers as above first.
Use an isolated checkout with no live `.env` file. Example:

```sh
python3 scripts/audit/run-lifecycle-diagnostic.py \
  --repo "$PWD" --output /tmp/independent-candidate.json \
  --corpus scripts/audit/lifecycle-independent-corpus.json \
  --native-embedding --omission-control
node scripts/audit/summarize-lifecycle.cjs /tmp/independent-candidate.json
```

For pre-fix baseline only, omit `--native-embedding` (harness-level serialization)
and add `--enum-repair`. Candidate uses product-level admission and real migration.
These are controlled configurations, not identical deployment environments.
No ranking, thresholds, or generated answers are tuned to the corpus. Generation
is nondeterministic and baseline/candidate ingestions are separate; this is a
small diagnostic, not a statistically powered improvement claim.

The optional omission control finds an **actually consolidated** source,
deliberately replaces its linked summary with a text omitting all source facts,
ages/lowers the source, and calls the actual archival stage. It records source
search eligibility before restoring the summary body. It does not claim semantic
retrieval quality for that manipulated summary. Baseline source archival remains
in force for later checkpoints, so the final archived snapshot includes both this
control's source and the normal `archive_*` scenario. If no real consolidation
occurs the control reports not executed.

No-answer zero-result rate is descriptive: explicit unknown phone/budget records
are useful refusal evidence. Judge them separately from unrelated results on the
absent-topic query. Automated anchor matches are not semantic equivalence; inspect
negation, attribution, dates and scope in sources and generated summaries.

The archival fix intentionally makes age/low-importance automated hiding fail
closed until validated information-preservation evidence exists. It preserves
normal search eligibility and explicit user deletion semantics; storage/recall
volume can grow. It does not recover already hidden historical sources.
