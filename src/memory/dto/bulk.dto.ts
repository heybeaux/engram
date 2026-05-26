import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsNumber,
  IsInt,
  IsISO8601,
  Validate,
  ValidateNested,
  ArrayMaxSize,
  ArrayMinSize,
  Min,
  Max,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ImportanceHint, MemoryLayer, MemorySource } from '@prisma/client';
import { ObservedAtNotFarFutureConstraint } from './create-memory.dto';
import { TemporalWarning } from '../memory.types';
import { TemporalWarningDto } from './create-memory.dto';

export class BulkCreateMemoryItemDto {
  @ApiProperty({ description: 'Memory content text' })
  @IsString()
  @IsNotEmpty({ message: 'Memory content cannot be empty' })
  raw: string;

  @ApiPropertyOptional({
    enum: ['IDENTITY', 'PROJECT', 'SESSION', 'TASK', 'INSIGHT'],
  })
  @IsOptional()
  @IsEnum(MemoryLayer)
  layer?: string;

  @ApiPropertyOptional({ enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  @IsOptional()
  @IsEnum(ImportanceHint)
  importanceHint?: ImportanceHint;

  @ApiPropertyOptional({
    enum: [
      'EXPLICIT_STATEMENT',
      'AGENT_OBSERVATION',
      'AGENT_REFLECTION',
      'CORRECTION',
      'PATTERN_DETECTED',
      'SYSTEM',
      'GIT_HISTORY',
      'HISTORICAL',
    ],
  })
  @IsOptional()
  @IsEnum(MemorySource)
  source?: string;

  /**
   * Temporal anchoring (Phase 1): when the event being memorialized actually
   * occurred. ISO 8601. Rejected if more than 1 hour in the future
   * (clock-skew tolerance). Mirrors CreateMemoryDto.observedAt.
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

  @ApiPropertyOptional({ description: 'Optional metadata' })
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({
    description:
      '0-based position within a session (set automatically by round-level ingest)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sessionPosition?: number;
}

export class BulkCreateMemoryDto {
  @ApiProperty({
    description: 'Array of memories to create (max 1000)',
    type: [BulkCreateMemoryItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => BulkCreateMemoryItemDto)
  memories: BulkCreateMemoryItemDto[];

  @ApiPropertyOptional({ description: 'Optional project/session context' })
  @IsOptional()
  context?: {
    projectId?: string;
    sessionId?: string;
  };

  @ApiPropertyOptional({ description: 'Agent ID for attribution' })
  @IsOptional()
  @IsString()
  agentId?: string;
}

export class BulkTextImportDto {
  @ApiProperty({ description: 'Raw text to chunk and import' })
  @IsString()
  @IsNotEmpty({ message: 'Text content cannot be empty' })
  text: string;

  @ApiPropertyOptional({
    description: 'Target chunk size in characters (default 3500)',
    default: 3500,
  })
  @IsOptional()
  @IsNumber()
  @Min(500)
  @Max(10000)
  chunkSize?: number;

  @ApiPropertyOptional({
    enum: ['IDENTITY', 'PROJECT', 'SESSION', 'TASK', 'INSIGHT'],
  })
  @IsOptional()
  @IsEnum(MemoryLayer)
  layer?: string;

  @ApiPropertyOptional({ enum: ['ROUND', 'PARAGRAPH', 'CHUNK'] })
  @IsOptional()
  @IsEnum(['ROUND', 'PARAGRAPH', 'CHUNK'])
  granularity?: 'ROUND' | 'PARAGRAPH' | 'CHUNK';

  @ApiPropertyOptional({ description: 'Optional project/session context' })
  @IsOptional()
  context?: {
    projectId?: string;
    sessionId?: string;
  };
}

export class ExportFilteredQueryDto {
  @ApiPropertyOptional({ enum: ['json', 'csv', 'ndjson'], default: 'json' })
  @IsOptional()
  @IsEnum(['json', 'csv', 'ndjson'] as const)
  format?: 'json' | 'csv' | 'ndjson' = 'json';

  @ApiPropertyOptional({
    enum: ['IDENTITY', 'PROJECT', 'SESSION', 'TASK', 'INSIGHT'],
  })
  @IsOptional()
  @IsEnum(MemoryLayer)
  layer?: string;

  @ApiPropertyOptional({ description: 'Filter by project ID' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Filter memories created after this date (ISO 8601)',
  })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Filter memories created before this date (ISO 8601)',
  })
  @IsOptional()
  @IsString()
  endDate?: string;
}

export interface BulkCreateResult {
  created: number;
  memoryIds: string[];
  /**
   * Temporal anchoring T6: batch-level structured warnings.
   *
   * Currently emits `HISTORICAL_WITHOUT_ANCHOR` when any item had
   * `source = HISTORICAL` without `observedAt` (downstream pass-2 extraction
   * will be skipped for those memories).
   *
   * Design note: top-level (not per-item) because the existing batch response
   * already aggregates outcomes with `memoryIds[]` rather than per-item rows.
   * Per-item attribution is intentionally deferred — callers who need it
   * should issue single-memory `POST /v1/memories` calls.
   */
  warnings?: TemporalWarning[];
}

/** Swagger-serialisable class for POST /v1/memories/bulk response. */
export class BulkCreateResponseDto {
  @ApiProperty({ example: 10 })
  created: number;

  @ApiProperty({ type: [String], example: ['mem_01HXXX'] })
  memoryIds: string[];

  @ApiPropertyOptional({
    type: [TemporalWarningDto],
    description:
      'Non-fatal warnings raised during bulk ingest. Present only when at least one item triggered a warning.',
  })
  warnings?: TemporalWarningDto[];
}

export interface BulkTextResult {
  created: number;
  chunks: number;
  memoryIds: string[];
  /** The resolved DB session ID (not the external_id passed in the request) */
  resolvedSessionId?: string;
}
