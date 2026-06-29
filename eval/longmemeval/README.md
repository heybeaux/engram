# LongMemEval Eval Harness

End-to-end benchmark for Engram's memory recall quality using the [LongMemEval](https://arxiv.org/abs/2410.10813) dataset (ICLR 2025).

## Quick Start (Smoke Fixture)

```bash
# Run against the 20-question smoke fixture (no HuggingFace token needed)
ENGRAM_API_KEY=<your-key> \
ANTHROPIC_API_KEY=<your-key> \
pnpm longmemeval --subset smoke
```

Output: `eval/longmemeval/summary.json`

## Full Dataset

```bash
ENGRAM_API_KEY=<your-key> \
ANTHROPIC_API_KEY=<your-key> \
HUGGINGFACE_TOKEN=<your-token> \
pnpm longmemeval --subset full
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--subset smoke\|full` | `smoke` | Dataset source. `smoke` uses the local 20-question fixture; `full` downloads from HuggingFace |
| `--limit N` | all | Evaluate only the first N questions |
| `--category CATEGORY` | all | Filter to one category: `single-session-user`, `multi-session-user`, `temporal-reasoning-ability`, `knowledge-update`, `single-session-assistant` |
| `--output PATH` | `eval/longmemeval/summary.json` | Output file path for final aggregate |
| `--results-dir DIR` | `eval/longmemeval/results/` | Directory for streamed per-question JSONL files (used when `--resume` is absent) |
| `--resume PATH` | — | Resume an in-progress run from a JSONL file; skips already-completed `question_id`s and continues appending |

## Resume & Checkpoint

Every run streams one JSON line per completed question to a JSONL file, so a 500-question run can survive crashes, kills, or transient API outages.

```bash
# Fresh run — the JSONL path is printed on the FIRST line of stdout
pnpm longmemeval --subset full
# Results JSONL: eval/longmemeval/results/full-2026-05-22T19-03-12-345Z.jsonl

# Process killed at question 247? Resume from where it left off:
pnpm longmemeval --subset full --resume eval/longmemeval/results/full-2026-05-22T19-03-12-345Z.jsonl
```

Behavior:

- Each completed question appends one JSON line (sync `fs.appendFileSync` — durability over throughput).
- `SIGINT` / `SIGTERM` set a `shouldStop` flag and let the in-flight question finish before exiting — the judge call alone is the longest piece of work, no reason to throw it away.
- A second Ctrl-C forces immediate exit.
- The final `summary.json` is rebuilt from the JSONL after the loop completes, so it always reflects on-disk truth (not in-memory state).

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENGRAM_API_KEY` | Yes | — | API key for the Engram instance |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key for judge + reading model |
| `ENGRAM_API_BASE` | No | `http://localhost:3000` | Engram API base URL |
| `LONGMEMEVAL_READ_MODEL` | No | `claude-opus-4-7` | Reading model (CoN step) |
| `LONGMEMEVAL_FIXTURE_PATH` | No | `fixtures/smoke-20.json` | Override smoke fixture path (e.g. `fixtures/stratified-50-normalized.json` for the 50-question stratified eval set) |
| `HUGGINGFACE_TOKEN` | Only for `--subset full` | — | HuggingFace token to download full dataset |

## Architecture

```
Per question:
  1. Ingest  — POST /v1/memories/bulk-text
               granularity:"ROUND" (S1/HEY-573)
               sessionId: "lme-{question_id}" (isolation)

  2. Recall  — POST /v1/memories/query
               sessionId filter (HEY-578)
               response_format:"structured", chainOfNote:true (S4/HEY-576)

  3. Read    — Call reading model (Opus 4.7) with Chain-of-Note prompt
               Extract answer from JSON envelope

  4. Judge   — Call judge model (Opus 4.7, hard-coded)
               Binary correct/incorrect with reasoning

  5. Score   — Aggregate by category, write summary.json
```

## summary.json Shape

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
  "questions": [ ... ]
}
```

## Unit Tests

```bash
pnpm longmemeval:test
```

Tests cover: dataset loader, CoN answer extraction, scorer/aggregation.

## Smoke Fixture Selection

`fixtures/smoke-20.json` contains 20 hand-curated synthetic questions stratified across all 5 LongMemEval categories:

| Category | Count |
|---|---|
| single-session-user | 5 |
| multi-session-user | 4 |
| temporal-reasoning-ability | 4 |
| knowledge-update | 3 |
| single-session-assistant | 4 |

Questions are representative of real LongMemEval tasks but synthetic (no dataset licensing concerns for CI). Auto-stratification from the real dataset is deferred to Phase 2.

## Deferred to Phase 2/3

- `--cleanup` flag to delete ingested memories after a run
- Ablation flags (`--no-con`, `--granularity=CHUNK`, etc.)
- Markdown report generation
- History tracking / regression detection
- GitHub Actions CI workflow
- OpenAI fallback for judge/reading models
- Auto-stratified fixture generation from the full dataset
