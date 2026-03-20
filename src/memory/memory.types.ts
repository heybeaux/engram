import { Memory } from '@prisma/client';
import {
  MultiQueryMetadataDto,
  ResultExplanationDto,
} from '../multi-query/dto/multi-query.dto';
import { AnticipatoryMeta } from '../anticipatory/dto/anticipatory.dto';

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
