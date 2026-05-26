import { Memory } from '@prisma/client';
import {
  MultiQueryMetadataDto,
  ResultExplanationDto,
} from '../multi-query/dto/multi-query.dto';
import { AnticipatoryMeta } from '../anticipatory/dto/anticipatory.dto';

/**
 * Temporal anchoring T6: structured warning returned in ingest API responses.
 * Discriminated by `code` so future warning types can be added safely.
 */
export interface TemporalWarning {
  /** Machine-readable discriminator for client branching. */
  code: string;
  /** Human-readable explanation surfaced to API callers. */
  message: string;
  /** Present on per-item paths (e.g. bulk, sync) to identify which record triggered the warning. */
  memoryId?: string;
}

/** Warning codes — extend here; never reuse a retired value. */
export const TemporalWarningCode = {
  HISTORICAL_WITHOUT_ANCHOR: 'HISTORICAL_WITHOUT_ANCHOR',
} as const;

export type TemporalWarningCodeType =
  (typeof TemporalWarningCode)[keyof typeof TemporalWarningCode];

/** Pre-built warning object reused across ingest paths. */
export const TEMPORAL_WARNING_HISTORICAL_WITHOUT_ANCHOR: Omit<
  TemporalWarning,
  'memoryId'
> = {
  code: TemporalWarningCode.HISTORICAL_WITHOUT_ANCHOR,
  message:
    'Memory ingested with source=HISTORICAL but no observedAt supplied. ' +
    'Relative-phrase extraction will be skipped; downstream readers will ' +
    'coalesce observedAt to recordedAt.',
};

/** @deprecated Use TEMPORAL_WARNING_HISTORICAL_WITHOUT_ANCHOR. Kept for migration only. */
export const TEMPORAL_WARNING_RELATIVE_EXTRACTION_SKIPPED =
  'relative_extraction_skipped';

export interface MemoryWithExtraction extends Memory {
  extraction?: {
    who: string | null;
    what: string | null;
    when: Date | null;
    whereCtx: string | null;
    why: string | null;
    how: string | null;
    topics: string[];
  } | null;
  chain?: MemoryWithExtraction[];
  /**
   * Temporal anchoring Phase 1, T6: structured warnings attached at ingest.
   * Emits `HISTORICAL_WITHOUT_ANCHOR` when `source = HISTORICAL` and no
   * `observedAt` was supplied. See openspec/changes/temporal-anchoring/design.md.
   */
  warnings?: TemporalWarning[];
}

export interface MemoryWithScore extends MemoryWithExtraction {
  score?: number;
  /** Present when this memory was surfaced by the Anticipatory Recall Engine. */
  recallSource?: 'standard' | 'anticipatory' | 'graph';
  /** Anticipatory metadata (strategy, reason, salience). Only present when recallSource='anticipatory'. */
  anticipatory?: {
    strategy: string;
    reason: string;
    salience: number;
    entityPath?: string[];
    insightType?: string;
  };
}

export interface QueryResult {
  recallId: string;
  memories: MemoryWithScore[];
  queryTokens: number;
  latencyMs: number;
  multiQuery?: MultiQueryMetadataDto;
  explanations?: Record<string, ResultExplanationDto>;
  /** Anticipatory Recall Engine metadata. Present when anticipatory.enabled=true. */
  anticipatoryMeta?: AnticipatoryMeta;
}

export interface ContextResult {
  context: string;
  tokenCount: number;
  memoriesIncluded: number;
  layers: {
    identity: number;
    project: number;
    session: number;
    agent?: number;
  };
}
