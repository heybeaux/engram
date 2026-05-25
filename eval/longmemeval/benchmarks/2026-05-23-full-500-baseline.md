# LongMemEval Baseline 1

**Run date:** 2026-05-23  
**Status:** First official Engram benchmark baseline  
**Artifacts:** `eval/longmemeval/summary.json`, `eval/longmemeval/results/full-2026-05-23T17-55-19-246Z.jsonl`

## Headline Result

- Score: `266 / 500`
- Accuracy: `53.2%`
- Duration: `6h 20m 57s`

## Category Breakdown

- `single-session-user`: `68 / 100` (`68.0%`)
- `multi-session-user`: `56 / 133` (`42.1%`)
- `temporal-reasoning-ability`: `43 / 133` (`32.3%`)
- `knowledge-update`: `48 / 78` (`61.5%`)
- `single-session-assistant`: `51 / 56` (`91.1%`)

## What We Learned

- Engram is already strong at assistant-turn recall. `single-session-assistant` at `91.1%` says the core recall path can recover recent assistant-authored details well.
- The biggest product weakness is temporal reasoning, not raw semantic search. The worst category is `temporal-reasoning-ability`, and many failures explicitly mention that multiple memories share the same stored timestamp.
- Multi-session aggregation is the next real gap. Engram can often find one supporting memory but fails to sum, count, dedupe, or order facts across sessions.
- The benchmark is partially contaminated by non-product failures:
  - `32` failures from scorer/harness bug: `expected.trim is not a function`
  - `37` failures from empty predictions or HTTP `500`
- Because of that contamination, `53.2%` is a real baseline, but not yet a clean ceiling on recall quality.

## Top-10 Failed Questions By Fix Type

### 1. Harness / evaluator bug

1. `0a995998` — "How many items of clothing do I need to pick up or return from a store?"  
   Fix type: scorer must accept numeric gold answers without crashing on `expected.trim`.
2. `6d550036` — "How many projects have I led or am currently leading?"  
   Fix type: same scorer bug; this should be a judged answer, not a harness exception.

### 2. Infra / runtime failure

3. `60d45044` — "What type of rice is my favorite?"  
   Fix type: recall path stability; this row failed with HTTP `500`.
4. `21436231` — "How many largemouth bass did I catch on my fishing trip to Lake Michigan?"  
   Fix type: empty-prediction guardrails; the run returned no answer at all.

### 3. Temporal anchoring failure

5. `gpt4_59149c77` — "How many days passed between my visit to MoMA and the Met exhibit?"  
   Fix type: use event time, not only memory write time. Gold answer is `7 days`.
6. `gpt4_f49edff3` — "What is the order of three baby-shower / nursery / phone-case events?"  
   Fix type: preserve per-memory temporal anchors strongly enough to recover ordering.

### 4. Aggregation / reasoning over multiple memories

7. `28dc39ac` — "How many hours have I spent playing games in total?"  
   Fix type: multi-memory numeric aggregation; the answer hedged at `45+` instead of reaching `140`.
8. `gpt4_2f8be40d` — "How many weddings have I attended this year?"  
   Fix type: multi-memory event dedupe plus calendar anchoring; the model found the candidate events but would not commit.

### 5. Single-memory retrieval / preference grounding

9. `c5e8278d` — "What was my last name before I changed it?"  
   Fix type: missed fact recall for a single explicit answer (`Johnson`).
10. `32260d93` — "Can you recommend a show or movie for me to watch tonight?"  
    Fix type: preference retrieval. Engram missed stored recommendation context about Netflix stand-up specials with strong storytelling.

## Improvement Plan

### P0

- Fix the LongMemEval scorer so numeric or non-string gold answers do not throw `expected.trim`.
- Fix empty-answer and HTTP `500` failure modes before rerunning the official benchmark.

### P1

- Anchor temporal recall to `extraction.when` when available, with `createdAt` as fallback only.
- Persist richer temporal metadata at write time:
  - original relative expression, such as `yesterday`
  - reference timestamp used for resolution
  - resolved absolute date or date range

### P2

- Add aggregation helpers for count, sum, difference, and ordered-event reconstruction across multiple memories.
- Add stronger "latest valid fact wins" handling for knowledge updates and superseded state.

### P3

- Improve single-memory preference recall for recommendation-style prompts where the answer is not a bare fact but a user-shaped response policy.

## Continuity Arcs: Current Status

- Engram still has **timeline continuity scaffolding**, not a complete arc-driven recall system.
- Evidence in code:
  - `Timeline` records include `arcId` and `openThreadIds`
  - query DTOs still expose an `arc` filter
  - `traceTimeline` exists for date-range reconstruction
- But the active recall path does **not** currently build or traverse a first-class `Arc` model, and the query DTO itself labels arc filtering as "prep for Phase 3".
- Practical conclusion: the continuity feature should help this benchmark **eventually**, especially for multi-session and temporal questions, but in the current codebase it is mostly scaffolding plus timeline storage, not a decisive recall advantage yet.

## Decision

- Treat this run as the baseline to beat.
- Do not compare future improvements against smoke runs or partial runs.
- The next official rerun should happen only after:
  - harness scoring is fixed
  - runtime empty/500 failures are fixed
  - temporal recall uses resolved event dates, not just write timestamps
