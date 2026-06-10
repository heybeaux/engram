import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MemoryType } from '@prisma/client';
import { MultiQueryMetadataDto } from '../../multi-query/dto/multi-query.dto';
import type { ResultExplanationDto } from '../../multi-query/dto/multi-query.dto';
import type { AnticipatoryMeta } from '../../anticipatory/dto/anticipatory.dto';
import type { MemoryWithScore, QueryResult } from '../memory.types';

/**
 * ENG-134: Structured recall item — typed projection of a recalled memory.
 *
 * This is the v2 response shape returned when callers pass
 * `?response_format=structured` (or `Accept: application/vnd.engram.v2+json`)
 * to /v1/memories/query. The legacy shape (full Prisma row under
 * QueryResult.memories) remains the default to preserve backward compat.
 */
export class StructuredMemoryItem {
  @ApiProperty({
    description: 'Memory ID (cuid).',
    example: 'clx0memory123',
  })
  id!: string;

  @ApiProperty({
    description:
      'The memory content / extracted fact. Sourced from the memory `raw` field.',
    example: 'The user prefers dark mode.',
  })
  fact!: string;

  @ApiPropertyOptional({
    description:
      'Session that originally produced this memory. Null for memories without a known source session.',
    example: 'clx0session456',
    nullable: true,
  })
  source_session!: string | null;

  @ApiPropertyOptional({
    description:
      'Retrieval confidence/score from the ranking pipeline. ' +
      'This is the raw score exposed by the retriever (cosine similarity, RRF, or ranker score — ' +
      'whichever is present). It is typically in [0, 1] for cosine similarity but RRF/hybrid scores ' +
      'may exceed 1.0 — callers should treat it as a relative score, not a probability. ' +
      'Null when the retrieval pipeline did not surface a score (e.g. for chain-included memories).',
    example: 0.87,
    nullable: true,
  })
  confidence!: number | null;

  @ApiProperty({
    description: 'When the memory was created (ISO 8601).',
    example: '2026-05-21T14:32:11.000Z',
  })
  timestamp!: string;

  @ApiPropertyOptional({
    description:
      'Memory type classification. Maps to the existing `memoryType` field. ' +
      'Null when the memory has not been classified.',
    enum: MemoryType,
    nullable: true,
  })
  memory_type!: MemoryType | null;
}

/**
 * v2 envelope returned when structured format is requested.
 * Preserves the QueryResult metadata while replacing `memories` with the
 * typed projection.
 */
export class StructuredQueryResult {
  @ApiProperty({ description: 'Recall correlation ID.' })
  recallId!: string;

  @ApiProperty({
    description: 'Recalled memories in structured form.',
    type: [StructuredMemoryItem],
  })
  memories!: StructuredMemoryItem[];

  @ApiProperty({ description: 'Number of tokens in the query.' })
  queryTokens!: number;

  @ApiProperty({ description: 'End-to-end recall latency in milliseconds.' })
  latencyMs!: number;

  @ApiPropertyOptional({
    description:
      'Response format version identifier. Always "json_v2" for structured responses; ' +
      'absent on legacy responses.',
    example: 'json_v2',
  })
  format!: 'json_v2';

  @ApiPropertyOptional({ type: MultiQueryMetadataDto })
  multiQuery?: MultiQueryMetadataDto;

  @ApiPropertyOptional({
    description: 'Explanation per memory ID. Keyed by memory id.',
    type: Object,
  })
  explanations?: Record<string, ResultExplanationDto>;

  @ApiPropertyOptional({
    description: 'Anticipatory recall metadata.',
    type: Object,
  })
  anticipatoryMeta?: AnticipatoryMeta;

  @ApiPropertyOptional({
    description:
      'Chain-of-Note system prompt for the reading model. ' +
      'Populated when the caller requests structured format and at least one memory was recalled. ' +
      'Embed this as the system prompt so the reading model annotates each memory before answering.',
  })
  chainOfNotePrompt?: string;
}

/**
 * Accepted values for the `response_format` query parameter on recall.
 * - `legacy`  (default): existing QueryResult shape with full Memory rows.
 * - `structured` / `json_v2`: new typed projection (StructuredQueryResult).
 */
export type ResponseFormat = 'legacy' | 'structured' | 'json_v2';

/**
 * Vendored media-type alternative to the query param for content-negotiation
 * style callers. Either trigger is accepted; the query param wins on conflict.
 */
export const STRUCTURED_ACCEPT_MEDIA_TYPE = 'application/vnd.engram.v2+json';

/**
 * Decide whether the request asks for the structured response shape.
 * - `response_format` query string takes precedence.
 * - Falls back to the Accept header if the param is absent.
 */
export function wantsStructuredResponse(
  responseFormat: string | undefined,
  acceptHeader: string | undefined,
): boolean {
  if (responseFormat) {
    const normalized = responseFormat.trim().toLowerCase();
    if (normalized === 'structured' || normalized === 'json_v2') return true;
    if (normalized === 'legacy') return false;
  }
  if (
    acceptHeader &&
    acceptHeader.toLowerCase().includes(STRUCTURED_ACCEPT_MEDIA_TYPE)
  ) {
    return true;
  }
  return false;
}

/**
 * Project a MemoryWithScore (the internal Prisma+score shape) into the
 * v2 StructuredMemoryItem. Does NOT fabricate values — fields that have no
 * source are returned as null.
 */
export function toStructuredItem(
  memory: MemoryWithScore,
): StructuredMemoryItem {
  return {
    id: memory.id,
    fact: memory.raw,
    source_session: memory.sessionId ?? null,
    confidence: typeof memory.score === 'number' ? memory.score : null,
    timestamp: (() => {
      const effective = (memory as any).observedAt ?? memory.createdAt;
      return effective instanceof Date
        ? effective.toISOString()
        : new Date(effective as any).toISOString();
    })(),
    memory_type: memory.memoryType ?? null,
  };
}

/**
 * Convert a full QueryResult to the v2 StructuredQueryResult envelope.
 */
export function toStructuredQueryResult(
  result: QueryResult,
): StructuredQueryResult {
  return {
    recallId: result.recallId,
    memories: result.memories.map(toStructuredItem),
    queryTokens: result.queryTokens,
    latencyMs: result.latencyMs,
    format: 'json_v2',
    multiQuery: result.multiQuery,
    explanations: result.explanations,
    anticipatoryMeta: result.anticipatoryMeta,
  };
}
