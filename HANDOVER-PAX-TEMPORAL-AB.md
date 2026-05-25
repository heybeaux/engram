# Handover — Engram Temporal Extraction A+B → LongMemEval

**To:** Pax
**From:** Rook
**Date:** 2026-05-25
**Status:** Code committed and pushed. Eval not yet run. Branch ready for you to drive home.

---

## TL;DR

Fix A and Fix B are both committed and pushed to `fix/temporal-extraction-pipeline-ab` (off `staging`). 153 unit tests pass for the affected files. **What's not done:** opening the PR, running LongMemEval, capturing the score delta, and writing the result memory. Your job from here.

I lost time to subagent visibility issues — the work landed but I couldn't see milestones in real time, leading to a bunch of bad updates to Beaux. The actual code is fine. Don't trust my prior status messages; trust git.

---

## Branch state

- **Branch:** `fix/temporal-extraction-pipeline-ab`
- **Base:** `staging` (NOT on top of your WIP `wip/pax-longmemeval-eval-fixes` — fresh branch as Beaux requested)
- **Commits ahead of staging:** 2
  - `5c35733` — `fix(temporal): wire TemporalParserService into extraction pipeline (Fix A)`
  - `7248b66` — `fix(temporal): synchronous BullMQ enqueue + thread ExtractionContext through queue (Fix B)`
- **Pushed:** yes (`origin/fix/temporal-extraction-pipeline-ab`)
- **PR:** not opened — your call on description / reviewers

---

## What Fix A does

Wires `TemporalParserService` into the extraction pipeline via `buildTemporalMetadata`. Previously the parser existed but wasn't actually invoked during memory write — so temporal expressions in conversation content never produced temporal metadata on the memory record. Now they do.

- New helper `buildTemporalMetadata(text, context)` produces the temporal block from the source text + extraction context.
- `TemporalParserService` is injected into the pipeline service.
- 5 new temporal-extraction tests + existing temporal tests all pass.

## What Fix B does

Fixes the bigger architectural bug: temporal metadata was being **lost across the BullMQ queue boundary**.

Before: write path created the memory row, then a cron (`EmbeddingRetryCron`) periodically swept the DB for unembedded memories and ran them through the embedding pipeline. That sweep had no access to the original `ExtractionContext` (timestamp, turnIndex, conversationId, userName) — so by the time embedding ran, we'd lost the temporal anchoring needed for time-aware recall.

After:
- Write path enqueues directly into BullMQ at write time, with `ExtractionContext` packed into the job payload.
- `embedding-queue.processor.ts` deserializes the context and passes it to the pipeline, so timestamps survive the queue boundary.
- `EmbeddingRetryCron` is now a pure janitor for transient embedding failures — no more DB sweep.
- Bulk-write DTO (`bulk.dto.ts`) gains `sourceTimestamp` + `sourceTurnIndex` per-item.

### Files touched (Fix B)

```
src/memory/dto/bulk.dto.ts                   | +16
src/memory/embedding-queue.processor.spec.ts | +30
src/memory/embedding-queue.processor.ts      | +26
src/memory/embedding-retry.cron.ts           |  -2 / +2
src/memory/embedding.queue.ts                | +8
src/memory/memory-bulk.controller.spec.ts    |  -1 / +1
src/memory/memory-bulk.controller.ts         | -1
src/memory/memory-pipeline-embedding.spec.ts |  -2 / +8
src/memory/memory-pipeline.service.{ts,spec} | ~273 lines
src/memory/memory-write.service.{ts,spec}    | ~50 lines
```

---

## What's verified

- `pnpm test -- --testPathPatterns='(embedding-queue.processor|memory-write.service|memory-pipeline-embedding|memory-bulk.controller|temporal)'` → **7 suites, 153/153 tests pass** as of 2026-05-25 09:17 PT.
- Branch pushes cleanly to origin.
- Diff vs staging is contained to `src/memory/` (no spillover).

## What's NOT verified

- **Full test suite** (`pnpm test` without filter) — I only ran the affected scope. Run it before opening the PR.
- **Linter / typecheck** — not run.
- **LongMemEval score delta** — the whole point of this work. Not run.
- **End-to-end ingest probe** against a fresh DB to confirm temporal metadata actually lands on memories now.

---

## What you need to do

1. **Sanity check the diff** (`git diff staging..fix/temporal-extraction-pipeline-ab`). Look at `memory-pipeline.service.ts` especially — that's the biggest change (~273 lines). Verify the queue context plumbing matches what you'd have done.
2. **Full test suite:** `pnpm test` (will take a while; jest has `--forceExit --detectOpenHandles --maxWorkers=2` per package.json).
3. **Lint + build:** `pnpm lint && pnpm build`.
4. **Run LongMemEval against the branch.** Per the most recent run (2026-05-23) we scored 1/10 with the engram-embed saturation bug. With:
   - bug-side workaround: switched to OpenAI embeddings (the saturation note `engram-embed-saturation.md` covers this).
   - this branch's pipeline fixes: temporal metadata should actually land on memories now.
   Expect a meaningful jump. Capture the score + which subset/limit you ran.
5. **Open the PR against `staging`.** Title suggestion: `fix(temporal): A+B — wire parser + thread ExtractionContext through queue`. Body should cite Fix A and Fix B commits, the test results, and the LongMemEval delta.
6. **Post a memory** to Engram (kit-local key works, prod cloud is 401ing — see `engram-cloud-401.md`) summarizing the outcome, so next session has ground truth.

---

## Context / linked memories

- `engram-ingest-pipeline-tx-bug.md` — the original symptom Fix B addresses.
- `engram-embed-saturation.md` — eval-side workaround (OpenAI embeds) you'll want active during the eval run.
- `engram-cloud-401.md` — cloud API is rejecting keys; use local 3007 or kit-local key for memory writes.
- Your own checkpoint: `wip/pax-longmemeval-eval-fixes` @ `a45e23253f66c550540a3dc0422ebeba3629e494` — eval-side WIP (sessionId gating fix, temporal timestamp projection, readiness timeout, fresh temporal probe). You may want to cherry-pick from there or branch the eval-runner work on top of this A+B branch.

---

## Honest postmortem (for context, not action)

The subagent runtime didn't checkpoint mid-task messages the way I assumed it would, so I had no visibility into the recovery child for 26 minutes and gave Beaux a bunch of bad "still running, no update" reports. Git showed both fixes had actually landed — the work was real, the comms were broken. Killed the subagent, pushed the work, wrote this handover. Going forward I'm not delegating long-running engram work to disposable subagents without `git log` polling as the source of truth.

Good luck. Branch is yours.

— Rook
