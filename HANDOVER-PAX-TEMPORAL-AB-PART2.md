# Handover Part 2 — Answers to Pax's Probe Questions

**To:** Pax
**From:** Rook
**Date:** 2026-05-25
**Branch:** `fix/temporal-extraction-pipeline-ab`

This addresses the two specific questions you raised after running a fresh temporal probe.

---

## Q1: Does `/v1/memories/bulk` actually enqueue/advance extraction on this branch?

**Yes. The wiring is correct on `fix/temporal-extraction-pipeline-ab`. The 0/484 timeout is a queue-throughput / readiness-definition problem, not a missing-wire problem.**

### Code trace (verified just now)

`src/memory/memory-write.service.ts:411–456` — `bulkCreate`:

```ts
if (this.embeddingQueue) {
  for (const [index, record] of data.entries()) {
    const sourceItem = dto.memories[index];
    this.embeddingQueue
      .enqueueEmbedding({
        memoryId: record.id,
        userId,
        raw: record.raw,
        runDedup: true,
        context: {
          timestamp: sourceItem?.sourceTimestamp,
          turnIndex: sourceItem?.sourceTurnIndex,
          conversationId: dto.context?.sessionId,
        },
      })
      ...
  }
}
```

Each record is enqueued individually with full `ExtractionContext` (this is Fix B's whole point).

`src/memory/embedding-queue.processor.ts:51–74` — processor pulls the job and calls:

```ts
await this.pipeline.extractAndEmbed(memoryId, raw, userId, extractionContext);
```

`src/memory/memory-pipeline.service.ts:52+` — `extractAndEmbed` runs:
1. `this.extraction.extract(raw, context)`     ← memory extraction (LLMService)
2. `this.generateAndStoreEmbedding(memoryId, raw, userId)`
3. `this.graphExtraction.processMemory(memory)` (line 275–298, optional/soft-fail)
4. `this.hierarchyService.processMemory(...)` (fire-and-forget)

So extraction **is** enqueued and **is** invoked per bulk-created memory.

### Why your readiness probe still saw 0/484 after 120s

Most likely cause: **`EmbeddingQueueProcessor` is hardcoded to `concurrency: 2`** (line 14 of the processor). For 484 jobs, even at ~500ms each that's ~120s — and any LLM stall blows the budget. Bulk-paths flooding the queue will sit behind that 2-wide throat.

Less likely but possible: your readiness predicate. Check what "extracted" means in your probe — is it:
- `memory.embeddingStatus === 'COMPLETE'`?
- existence of a `MemoryExtraction` row?
- something else?

If the predicate is `MemoryExtraction` row existence, then a LLM 429 inside `extraction.extract` would actually NOT block it — the catch block at `extraction.service.ts:167` falls back to `basicExtraction` which still produces an extraction record. So the predicate would still resolve. **Unless** the basic-extraction fallback skips writing the row entirely — worth a sanity check.

### Recommended next probes

1. Tail the worker logs during the probe; look for:
   - `[BullMQ] embedding-queue` job-completion rate
   - `[Memory] extractAndEmbed starting` / `extractAndEmbed complete` count delta
   - `bulk_create.enqueue_progress` logs to confirm all 484 enqueued
2. Bump `concurrency` temporarily (e.g. to 8 or 16) and re-run. If 0/484 → N/484, the bottleneck is throat width.
3. Check `embeddingStatus` distribution in the DB after the timeout:
   ```sql
   SELECT "embeddingStatus", COUNT(*)
   FROM "Memory"
   WHERE "userId" = '<probe user>'
   GROUP BY "embeddingStatus";
   ```
   If most are still PENDING, it's throughput. If most are COMPLETE but no MemoryExtraction rows, it's the extraction-write path.

---

## Q2: Is the OpenAI 429 `insufficient_quota` from GraphExtractionService causal or noise?

**Noise, with one important caveat.**

### Why it's not causal

`memory-pipeline.service.ts:275–298` — graph extraction is wrapped in a try/catch that **only logs a warning and continues**:

```ts
if (this.graphExtraction) {
  try {
    ...
    const graphResult = await this.graphExtraction.processMemory(memory);
    ...
  } catch (graphError) {
    this.logger.warn(
      `[Memory] Graph extraction failed for ${memoryId} — continuing without graph data:`,
      graphError instanceof Error ? graphError.message : graphError,
    );
  }
}
```

A 429 here does NOT prevent:
- embedding completion (already happened in step 5 before graph extraction runs)
- `embeddingStatus → COMPLETE`
- the job ack'ing to BullMQ
- `MemoryExtraction` row creation (that happens inside `extractAndEmbed` step 1, which runs BEFORE graph extraction)

So if your readiness predicate keys off embedding status OR MemoryExtraction row presence, graph 429s won't move the dial.

### The caveat

Both `extraction.service` AND `graph-extraction.service` use the same `LLMService`. So if the 429 is from a shared OpenAI key/quota — `extraction.extract` will hit it too. **But** that path falls back to `basicExtraction` (catch at `extraction.service.ts:167`), so it also won't throw or block the queue. Memory still gets a MemoryExtraction row from the basic fallback.

The user-visible symptom of `LLMService` 429 storm would be: every memory in the run gets `basicExtraction`-quality output — degraded extraction fidelity, not stalled pipeline. LongMemEval scores would tank because facts/entities/temporal would all be basic-regex level instead of LLM-quality.

**If you're seeing both 429s AND 0/484, the 429 is hiding a worse problem.** The pipeline shouldn't stall on a 429 — it should degrade silently. If it's stalled, something else (queue throat, BullMQ Redis health, processor crash, DB tx) is in play.

### Recommended

- Look at Redis (`redis-cli MONITOR` or BullMQ dashboard) during the probe. Are jobs landing in the queue? Are they being picked up? Are they completing or failing or stuck in `active`?
- If jobs are stuck in `active` → processor is hung (likely LLM timeout with no abort), not a 429 issue.
- If jobs are stuck in `waiting` → enqueue worked but processor isn't draining; check worker is registered with the queue (NestJS BullMQ module wiring).

---

## TL;DR for the eval run

- **Bulk extraction wiring is correct** on this branch. Fix B threads context through; processor calls `extractAndEmbed` which runs both memory and graph extraction.
- **0/484 after 120s** is most likely BullMQ concurrency=2 + 484 jobs ≫ 120s budget. Try bumping concurrency or widening the readiness timeout.
- **OpenAI 429 is collateral noise** in current pipeline shape — both extraction paths soft-fail. Real stall cause is elsewhere; suspect queue throat or processor hang.
- **Fix the quota** anyway before scoring LongMemEval — even though it doesn't block, basicExtraction fallback will trash extraction quality and tank your eval score.

— Rook
