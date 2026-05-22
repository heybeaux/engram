# S4 — Chain-of-Note + Structured JSON Reading

## Summary

ENG-134 / PR #245 shipped a structured JSON recall response (`StructuredRecallDto`) that serialises retrieved memories with metadata. The remaining gap is the *reading* side: the model receiving recall results must reason through them systematically before answering. Chain-of-Note (CoN) prompting instructs the model to write a brief relevance note for each retrieved memory before synthesising, improving reading accuracy ~10 absolute points on LongMemEval's QA tasks. This spec adds a CoN prompt template to the `POST /v1/memories/recall` response and the context-load endpoint.

## Motivation

**Paper finding:** Even with perfect retrieval (top-k oracle), models without structured reading miss the correct answer ~18% of the time. Chain-of-Note — requiring the model to write one sentence of relevance judgement per retrieved memory before answering — cuts that to ~8% (≈10 pt improvement). JSON output format is required for reliable parsing downstream.

**Current Engram state:**
- PR #245 (ENG-134) added `StructuredRecallDto` (`src/memory/dto/` — merged in PR diff) with structured JSON fields per memory: `id`, `raw`, `score`, `layer`, `memoryType`, `createdAt`, `extraction`.
- `GET /v1/memories/context` returns a flat text blob — no structure, no reading guidance.
- No system-prompt template ships with the API for CoN reasoning.
- `contextual-recall.service.ts` returns a raw memories array without reading instructions.

## Proposed Change

### 1. Add `chainOfNotePrompt` field to `StructuredRecallDto`

```typescript
// src/memory/dto/structured-recall.dto.ts (extending existing DTO from ENG-134)
@ApiPropertyOptional({ description: 'Chain-of-Note system prompt for the reading model' })
chainOfNotePrompt?: string;
```

Populate this field in `MemoryQueryController` (`src/memory/memory-query.controller.ts`) when `dto.structured === true` (the new flag from ENG-134) or when `dto.chainOfNote === true` explicitly.

### 2. Implement `ChainOfNoteService`

New service: `src/memory/chain-of-note.service.ts`

```typescript
@Injectable()
export class ChainOfNoteService {
  buildPrompt(memories: StructuredMemoryDto[], question: string): string {
    return CHAIN_OF_NOTE_TEMPLATE(memories, question);
  }
}
```

Template (`src/memory/chain-of-note.prompt.ts`):
```
You are reading memory search results to answer a question.

For each memory below, write one sentence: "[MEMORY <id>]: <relevance note — relevant / not relevant / partially relevant because …>"

Then answer the question based only on relevant memories. If no memory is relevant, say so.

Question: {{question}}

Memories:
{{memories_json}}
```

### 3. Extend `LoadContextDto` / `GET /v1/memories/context`

Add `chainOfNote: boolean` to `LoadContextDto` (`src/memory/dto/query-memory.dto.ts`). When `true`, append the CoN prompt template to the returned context string instead of raw memories. The consumer (e.g. Ginnung, Claude) uses this prompt directly as their system prompt.

### 4. Wire `ChainOfNoteService` into `MemoryQueryContextService`

```typescript
// src/memory/memory-query-context.service.ts
constructor(
  ...
  @Optional() private readonly chainOfNote?: ChainOfNoteService,
) {}
```

When `dto.chainOfNote === true`, call `chainOfNote.buildPrompt(memories, dto.query)` and embed in the context output.

### 5. Export CoN prompt via API spec

Update `api-spec.json` (via Swagger auto-generation) to document `chainOfNotePrompt` in the recall response schema.

## Acceptance Criteria

- `POST /v1/memories/recall` with `structured: true` returns a `chainOfNotePrompt` string when any memories are returned.
- `GET /v1/memories/context?chainOfNote=true` returns a context blob with the CoN template populated with the retrieved memories.
- Prompt template includes one placeholder slot per memory in JSON format.
- Benchmark: end-to-end QA accuracy on LongMemEval single-hop tasks must improve >= 5 pts vs. flat-context baseline (measure via automated eval harness).
- P@5 must stay >= 98.1% (retrieval unchanged; only reading layer changes).
- Unit tests: `ChainOfNoteService.buildPrompt` produces valid prompt for 0, 1, N memories; `MemoryQueryController` includes `chainOfNotePrompt` in structured response.

## Migration / Rollout Plan

- `chainOfNote` defaults to `false` — no behaviour change for existing callers.
- `chainOfNotePrompt` is an optional field in `StructuredRecallDto` — back-compat with existing consumers.
- Roll out to Ginnung first (internal consumer), measure QA accuracy improvement, then document for external API users.
- No Prisma migration, no DB changes.

## Open Questions / Risks

- **Prompt injection:** `Memory.raw` is user-controlled text. The CoN template must sanitise or escape memory content before embedding in the prompt. Consider wrapping each memory in XML-style delimiters (`<memory id="…">…</memory>`) to reduce injection surface.
- **Token budget:** 20 memories × ~100 tokens each + CoN template ≈ 2500 tokens added to every structured recall. Downstream models must have sufficient context. Consider `maxMemoriesForCoN` cap (default: 10).
- **Consumer adoption:** The prompt is only useful if the calling model actually follows it. Document the expected model behaviour in the API spec and add a warning when `chainOfNote=true` is set without `structured=true`.

## References

- LongMemEval (ICLR 2025), §3.4 Chain-of-Note reading accuracy (+10 pts)
- ENG-134 / PR #245 — `StructuredRecallDto`, `memory-query.controller.ts` structured response
- `src/memory/memory-query.controller.ts` — controller to extend
- `src/memory/memory-query-context.service.ts` — context build path
- `src/memory/dto/query-memory.dto.ts` — `LoadContextDto` to extend
- Chain-of-Note paper: "Chain of Note: Enhancing Robustness in Retrieval-Augmented Language Models" (Yu et al., 2023)
