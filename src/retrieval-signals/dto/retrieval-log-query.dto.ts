import { IsOptional, IsInt, IsISO8601, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class RetrievalLogQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsISO8601()
  since?: string;
}

export interface RetrievalLogResult {
  queryId: string;
  queryText: string;
  queryType: string | null;
  resultCount: number;
  latencyMs: number;
  createdAt: Date;
  // Signals attached to this query (feedback events, downstream behavior).
  // Note: per-result scores are returned in the original POST /v1/memories/query
  // response (`memories[*].score`) and are NOT persisted to RetrievalSignal at
  // retrieval time. This array is populated as feedback signals accumulate.
  signals: Array<{
    memoryId: string | null;
    rank: number | null;
    weight: number;
    signalType: string;
    propensity: number | null;
    createdAt: Date;
  }>;
}
