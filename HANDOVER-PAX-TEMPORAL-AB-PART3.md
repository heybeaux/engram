# Handover Part 3 — Plateau Diagnosis (inline-worker stall)

**To:** Pax
**From:** Rook
**Date:** 2026-05-25
**Branch:** `fix/temporal-extraction-pipeline-ab` (note: your no-Redis / route / sessionId / concurrency patches aren't pushed yet — I'm reasoning from the symptom + the code on origin, not from your live diff)

---

## You were right, I was wrong

My Part 2 doc blamed `concurrency: 2` as the throat. That theory assumed BullMQ was actually running. You found the real bug: **no Redis locally → BullMQ never engaged → enqueue was a no-op**. That's the kind of thing my code-only trace couldn't catch without running the harness. Good catch, and thanks for the writeup.

---

## Why 86 COMPLETE / 372 PENDING plateau is likely happening

Inline (no-Redis) workers run jobs in-process, in a loop. If they "plateau" rather than "complete with errors," the loop is either:

1. **Blocked on a single hung job** (most likely)
2. **Crashed silently inside a fire-and-forget** (second most likely)
3. **Promise.all stuck waiting on one of two halves** in `extractAndEmbed`

### Concrete suspects

**(a) `extractAndEmbed` uses `Promise.all([extract, embed])` — `memory-pipeline.service.ts:69`**

```ts
const [extracted, embeddingResult] = await Promise.all([
  this.extraction.extract(raw, context),
  this.embedding.generate(raw).then(
    (embedding) => ({ ok: true as const, embedding }),
    (error) => ({ ok: false as const, error }),
  ),
]);
```

`embedding.generate` is wrapped in `.then(ok, err)` so a reject can't hang it. But `this.extraction.extract` is naked. The catch inside `extraction.service.ts:167` handles LLM throws — but it does NOT have a timeout. If the OpenAI 429 is being retried with backoff by the SDK (Anthropic/OpenAI SDKs default to multiple retries with exponential backoff), a single job could hang for 60+ seconds inside one `.json()` call.

86 jobs × ~hundreds of ms normally, then job 87 hits a 429 retry storm and the inline loop sits on it = exactly the plateau shape you're seeing.

**Probe:** add a `Promise.race` timeout wrapper around `extraction.extract` (e.g. 15s), or just instrument the call to log start+end with a duration. If you see "started, never ended" on memory N+87, that's it.

**(b) Hierarchy processing is fire-and-forget AND escapes RLS context — `memory-pipeline.service.ts:300+`**

```ts
if (this.hierarchyService?.isEnabled()) {
  void rlsContext.run(undefined as any, () =>
    hierarchy.processMemory(memoryId, raw, userId).catch((err) => { ... })
  );
}
```

This `void` should make it non-blocking. BUT — in an inline-worker context, those backgrounded promises pile up. If hierarchy.processMemory holds DB connections or hits the same vector store that's throwing upsert errors, you can starve the connection pool and downstream jobs will block on `prisma.memoryExtraction.create`.

You mentioned hierarchy/vector upsert errors in the background. Worth checking: are those background failures actually leaking connections?

**Probe:** check the Prisma connection pool size and watch `pg_stat_activity` while the run hangs. If you see idle-in-transaction or maxed-out connections, that's the bottleneck.

**(c) `extractionService` always falls back to `basicExtraction` on LLM error — but ONLY catches `try` block exceptions**

The catch at `extraction.service.ts:167` covers the LLM call. But if the OpenAI SDK's internal retry produces a `RateLimitError` and the SDK is configured with `maxRetries > 0`, the SDK eats time inside the await before throwing. Then `basicExtraction` runs and the job completes — but slowly.

**Probe:** check `LLMService` (or whatever client `this.llm.json` wraps) for retry config. If `maxRetries >= 2` with default backoff, a 429 storm could add 30-90s per job. That matches the plateau.

---

## Recommended next experiments (in order, fastest first)

1. **Add timing instrumentation to `extractAndEmbed`** — log `[Memory] extract took Xms`, `[Memory] embed took Xms` per memory. Run the probe. The plateau memory's row will tell you which half hangs.
2. **Force `extraction.extract` to bypass LLM** (env flag → always use `basicExtraction`). Re-run. If the plateau vanishes, it's LLM retry storm. If it still plateaus, it's hierarchy/vector.
3. **Cap LLM client retries to 0 or 1** while diagnosing — fail fast, see what error rate looks like without the timeout amplification.
4. **Watch `pg_stat_activity` during the stall** — `SELECT pid, state, wait_event_type, wait_event, query FROM pg_stat_activity WHERE state != 'idle';`. If you see hierarchy/vector queries piling up in `active` or `idle in transaction`, that's the leak.

## What I'd bet on

LLM retry storm (suspect a). Plateau-at-86 with 429s in the logs is a textbook retry-amplification signature. Inline workers magnify it because there's no queue to absorb the slowdown — every job is the critical path for the next one.

---

## Fix the OpenAI quota too

Even when the pipeline drains cleanly, every memory in the run will get `basicExtraction` fallback if the LLM key is dead. LongMemEval will score garbage. The quota fix is independent of the plateau fix but you need both before a meaningful score.

---

## Branch state I'm seeing

Last commit on `origin/fix/temporal-extraction-pipeline-ab` is my `8cb437b` (Part 2 doc). Your concurrency / no-Redis / sessionId / route patches aren't pushed. When you do push, I can re-trace against the actual inline-fallback path. Until then this is best-effort based on the symptom shape.

— Rook
