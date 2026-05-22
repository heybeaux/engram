# S1 — Round-Level Memory Storage

## Summary

Store memories at conversation-round granularity (one exchange = one memory record) rather than bundling an entire session into one or a few large blobs. The LongMemEval paper shows round-level ingest significantly outperforms session-level for single-session QA while trading off slightly on multi-session reasoning tasks. Engram's `bulkTextImport` today chunks on character count / paragraph boundaries — semantically arbitrary boundaries that hurt recall.

## Motivation

**Paper finding:** Storing at round-level (individual user+assistant exchange pairs) yields the best P@5 on single-session LongMemEval questions. Atomic-fact compression (extracting standalone statements) gains ~2–3 pts on multi-session tasks but loses on overall accuracy due to information loss.

**Current Engram state:**
- `MemoryWriteService.bulkTextImport` (`src/memory/memory-write.service.ts:407`) chunks on `chunkSize` characters, splitting at paragraph boundaries — no awareness of conversation turns.
- `BulkTextImportDto` (`src/memory/dto/bulk.dto.ts`) has no `granularity` parameter.
- Session-level ingest (one POST per full session dump) is the dominant path used by the cloud-sync pipeline.
- `Memory.sessionPosition` (`prisma/schema.prisma`) exists but is not populated by bulk ingest paths.

## Proposed Change

### 1. Extend `BulkTextImportDto`

```typescript
// src/memory/dto/bulk.dto.ts
@ApiPropertyOptional({ enum: ['ROUND', 'PARAGRAPH', 'CHUNK'] })
@IsOptional()
@IsEnum(['ROUND', 'PARAGRAPH', 'CHUNK'])
granularity?: 'ROUND' | 'PARAGRAPH' | 'CHUNK';  // default: 'CHUNK' (back-compat)
```

### 2. Add `chunkByRound()` to `MemoryWriteService`

```typescript
// src/memory/memory-write.service.ts
chunkByRound(text: string): string[] {
  // Split on common turn delimiters:
  // "Human: / User: / Assistant: / Agent:" at line start,
  // blank-line + "---" separators used by OpenClaw/Mastra.
  const TURN_BOUNDARY = /^(human|user|assistant|agent)\s*:/gim;
  // ...returns one chunk per exchange pair (Q+A together)
}
```

Wire into `bulkTextImport` when `granularity === 'ROUND'`.

### 3. Populate `sessionPosition` on each round chunk

Set `sessionPosition` to the round index (0-based) so that round-order retrieval is possible and temporal markers are correctly anchored.

### 4. No schema migration required

`sessionPosition` already exists. `granularity` is a DTO-level concept only — no new DB column needed.

## Acceptance Criteria

- `POST /v1/memories/bulk-text` with `granularity: "ROUND"` and a 10-turn transcript produces 10 memory rows, one per exchange.
- `sessionPosition` on each row reflects turn order.
- Existing calls without `granularity` behave identically (back-compat).
- Benchmark: run LongMemEval single-session subset — P@5 must not regress below 98.1%; target >= 98.5%.
- Unit tests: `chunkByRound` handles common delimiters (OpenClaw format, plain `User:` / `Assistant:`, Markdown `---` separators).

## Migration / Rollout Plan

- `granularity` defaults to `'CHUNK'` — zero behaviour change for existing callers.
- Cloud-sync pipeline can opt-in by sending `granularity: "ROUND"` once the delimiter format is confirmed.
- Feature flag: `ENABLE_ROUND_LEVEL_INGEST=true` can override the default to `'ROUND'` globally for A/B testing.
- No Prisma migration, no deploy restart required for the flag.

## Open Questions / Risks

- **Multi-session reasoning trade-off:** LongMemEval shows round-level hurts ~1–2 pts on multi-session QA vs. atomic-fact mode. May need to run session-level consolidation (dream cycle) on round-level memories to recover cross-session signal.
- **Turn-delimiter detection:** Transcripts from different sources (Telegram, web, API) use different formats. Need a delimiter registry or LLM-assisted boundary detection for non-standard formats.
- **Memory volume:** Round-level increases row count ~5–10× for long sessions. Monitor pgvector index size and embedding queue backpressure.

## References

- LongMemEval (ICLR 2025), Table 4 — granularity ablation
- Mastra OM benchmark — round-level storage baseline
- `src/memory/memory-write.service.ts` — `bulkTextImport`, `chunkText`
- `src/memory/dto/bulk.dto.ts` — `BulkTextImportDto`
- `prisma/schema.prisma` — `Memory.sessionPosition`
