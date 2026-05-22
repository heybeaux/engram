# H1 — LongMemEval Eval Harness (MVP)

## Summary

End-to-end evaluation harness for measuring Engram's memory recall quality on the LongMemEval benchmark (ICLR 2025). The harness ingests per-question session histories via `bulkTextImport` with `granularity:"ROUND"` (S1), runs recall with `sessionId` filter (HEY-578), applies Chain-of-Note reading (S4), and judges answers with Anthropic Opus 4.7. Outputs a `summary.json` with per-question scores and aggregate metrics by category.

## Motivation

S1–S4 features are merged. We need an automated eval harness to:
1. Measure baseline accuracy before further optimisation.
2. Gate future changes — a regression in `summary.json` blocks a merge.
3. Generate category-level breakdowns for targeted improvement.

## File Layout

```
eval/longmemeval/
  src/
    types.ts           — dataset types (LongMemEvalQuestion, RoundEntry, etc.)
    loader.ts          — fetch + parse LongMemEval JSON; build smoke fixture
    ingest.ts          — per-question bulkTextImport via HTTP
    recall.ts          — recall + CoN answer extraction
    judge.ts           — Opus 4.7 correctness judge
    scorer.ts          — aggregate scoring (exact-match, judge, by-category)
    runner.ts          — CLI entry point
  fixtures/
    smoke-20.json      — 20-question hand-curated smoke fixture
  __tests__/
    loader.spec.ts     — loader unit tests
    scorer.spec.ts     — scorer unit tests
    con-extraction.spec.ts  — CoN answer extraction unit tests
  README.md            — how to run
```

## Phase 1 Scope

### Dataset

- Source: HuggingFace `xiaowu0162/longmemeval` (JSON download via HTTPS).
- Fallback: local `fixtures/smoke-20.json` when `--subset=smoke` or no network.
- Each question has: `question_id`, `question`, `answer`, `category`, `session_history` (array of `{role, content}` rounds).

### Ingest

- Per question: create isolated `agentId` + `userId` pair (format: `lme-{question_id}`).
- POST `bulkTextImport` with `granularity:"ROUND"`, `context.sessionId: "lme-{question_id}"`.
- Store returned `sessionId` for the recall step.

### Recall

- POST `/v1/memories/query` with `sessionId: "lme-{question_id}"`, `response_format:"structured"`, `chainOfNote:true`, `question` in the `note` field.
- Extract the final answer from the CoN structured JSON envelope (open question #2).

### CoN Answer Extraction (open question #2)

S4's Chain-of-Note prompt instructs the reading model to output a JSON envelope. The harness reads the `chainOfNotePrompt` from the structured recall response, calls the reading model (Opus 4.7, configurable via `LONGMEMEVAL_READ_MODEL`), and extracts the `answer:` field from the structured JSON response.

Expected reading model output shape:
```json
{
  "notes": [
    { "memory_id": "...", "note": "relevant / not relevant / partially relevant because …" }
  ],
  "answer": "The final answer to the question."
}
```

Post-processor: if the response contains a JSON block, parse it and return `answer`. If parsing fails, fall back to the last paragraph of the raw response.

### Judge

- Model: `claude-opus-4-7` (hard-coded, no override).
- Prompt: binary correctness judge. System prompt specifies exact-match + semantic equivalence rules.
- Returns `{ correct: boolean, reasoning: string }`.

### Scoring

- Per-question: `correct` (bool), `predicted` (string), `expected` (string), `category`, `latencyMs`.
- Aggregate: `accuracy` (%), `byCategory` (category → accuracy), `totalQuestions`, `correctCount`.

### CLI

```
pnpm longmemeval [--limit N] [--category CATEGORY] [--subset smoke|full]
```

- `--limit N`: process first N questions only (default: all).
- `--category CATEGORY`: filter to one category (single-session-user, multi-session-user, temporal-reasoning-ability, knowledge-update, single-session-assistant).
- `--subset smoke`: use `fixtures/smoke-20.json` (default when no network or for CI).
- Output: `eval/longmemeval/summary.json`.

### summary.json Shape

```json
{
  "runAt": "2026-05-22T12:00:00.000Z",
  "subset": "smoke",
  "totalQuestions": 20,
  "correctCount": 14,
  "accuracy": 0.70,
  "byCategory": {
    "single-session-user": { "total": 5, "correct": 4, "accuracy": 0.80 },
    "temporal-reasoning-ability": { "total": 4, "correct": 2, "accuracy": 0.50 }
  },
  "questions": [
    {
      "questionId": "lme_001",
      "question": "What color is the user's car?",
      "expected": "red",
      "predicted": "red",
      "correct": true,
      "category": "single-session-user",
      "latencyMs": 1234
    }
  ]
}
```

## Open Questions / Risks

1. **Dataset access**: LongMemEval is gated on HuggingFace. The harness falls back to `smoke-20.json` when the download fails. Full eval requires `HUGGINGFACE_TOKEN` env var.
2. **CoN final-answer extraction**: S4 returns a `chainOfNotePrompt` string for the reading model to follow. The harness sends this + the question to the reading model and parses the structured JSON output. If the model returns malformed JSON, the fallback is the last paragraph of the raw text response.
3. **Isolated ingest cost**: Each question creates ~10–50 memory rows. A 500-question run ≈ 25,000 DB rows and 25,000 embedding calls. The smoke-20 fixture is safe; full eval should run against a throw-away DB.
4. **Cleanup**: The harness does NOT delete ingested memories after the run. Add `--cleanup` in Phase 2.
5. **HEY-578 sessionId filter**: Merged in PR #250. Use it on the recall path — each question's memories are isolated by `sessionId: "lme-{question_id}"`.

## Deferred to Phase 2 / 3

- OpenAI fallback for judge/reading models.
- Ablation flag (`--no-con`, `--no-s2`, `--no-s3`, `--granularity=CHUNK`) for component-level attribution.
- Markdown report generation.
- History tracking (compare current run vs. prior runs, like the benchmark harness).
- Abstention precision/recall (when the model says "I don't know").
- Stratification logic for smoke fixture (currently hand-curated; Phase 2 will auto-stratify from full dataset).
- `--cleanup` flag to remove ingested memories after run.
- CI workflow integration (GitHub Actions step that runs smoke-20 on PR).

## References

- LongMemEval (ICLR 2025) — `xiaowu0162/longmemeval` on HuggingFace
- HEY-573 / PR #247 — S1 round-level granularity
- HEY-574 / PR #248 — S2 fact-key expansion
- HEY-575 / PR #246 — S3 time-aware query expansion
- HEY-576 / PR #249 — S4 Chain-of-Note structured reading
- HEY-578 / PR #250 — sessionId filter on recall query path
