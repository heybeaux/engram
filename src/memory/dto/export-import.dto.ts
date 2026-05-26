import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsISO8601,
  Validate,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ObservedAtNotFarFutureConstraint } from './create-memory.dto';
import { TemporalWarning } from '../memory.types';

export class ExportQueryDto {
  @ApiPropertyOptional({ enum: ['json', 'ndjson'], default: 'json' })
  @IsOptional()
  @IsEnum(['json', 'ndjson'] as const)
  format?: 'json' | 'ndjson' = 'json';
}

export interface ExportedGraphEntity {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  description: string | null;
  metadata: Record<string, any>;
}

export interface ExportedGraphRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
  label: string | null;
  weight: number;
  properties: Record<string, any>;
  isInferred: boolean;
}

export interface ExportedMemory {
  id: string;
  raw: string;
  layer: string;
  importance: number;
  tags: string[];
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  ensembleEmbeddings?: Record<string, number[]>;
  graph: {
    entities: ExportedGraphEntity[];
    relationships: ExportedGraphRelationship[];
  };
}

export class ImportMemoriesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportMemoryItemDto)
  memories: ImportMemoryItemDto[];
}

export class ImportMemoryItemDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  raw: string;

  @IsOptional()
  @IsString()
  layer?: string;

  @IsOptional()
  importance?: number;

  @IsOptional()
  tags?: string[];

  @IsOptional()
  metadata?: Record<string, any>;

  @IsOptional()
  @IsString()
  createdAt?: string;

  @IsOptional()
  @IsString()
  updatedAt?: string;

  /**
   * Temporal anchoring (Phase 1): when the event occurred (vs when recorded).
   * ISO 8601. Rejected if more than 1 hour in the future (clock-skew tolerance).
   * Mirrors CreateMemoryDto.observedAt.
   */
  @ApiPropertyOptional({
    description:
      'When the event occurred (vs when recorded). ISO 8601. Reject if >1h in future.',
    example: '2024-06-15T14:00:00Z',
  })
  @IsOptional()
  @IsISO8601()
  @Validate(ObservedAtNotFarFutureConstraint)
  observedAt?: string;

  // Ignored on import (re-generated) but accepted for format compatibility
  @IsOptional()
  ensembleEmbeddings?: Record<string, number[]>;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: number;
  /**
   * Temporal anchoring T6: batch-level structured warnings.
   * Reserves `HISTORICAL_WITHOUT_ANCHOR` for HISTORICAL-without-anchor items.
   * The current importMemories path uses `source = EXPLICIT_STATEMENT` by
   * default so this field is structurally never populated today, but is
   * included so SDKs can rely on a uniform ingest response shape.
   */
  warnings?: TemporalWarning[];
}
