import {
  IsString,
  IsOptional,
  IsEnum,
  IsObject,
  IsNumber,
  IsArray,
  IsDate,
  IsNotEmpty,
  ValidateIf,
  IsISO8601,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ImportanceHint,
  MemoryLayer,
  MemorySource,
  SubjectType,
} from '@prisma/client';

/**
 * HEY-174: Memory visibility scope for cross-agent sharing.
 * Defined here to avoid dependency on Prisma client regeneration.
 * Must match the MemoryVisibility enum in schema.prisma.
 */
export enum MemoryVisibilityEnum {
  PRIVATE = 'PRIVATE',
  TEAM = 'TEAM',
  PUBLIC = 'PUBLIC',
}

/**
 * Map legacy memoryType values to MemoryLayer enum
 */
function mapMemoryType(value: string | undefined): MemoryLayer | undefined {
  if (!value) return undefined;
  const upperValue = value.toUpperCase();
  // Handle both "SESSION" and "session" formats
  if (Object.values(MemoryLayer).includes(upperValue as MemoryLayer)) {
    return upperValue as MemoryLayer;
  }
  return undefined;
}

/**
 * Map numeric importance (0-1) to ImportanceHint enum
 */
function mapImportanceToHint(
  value: number | string | undefined,
): ImportanceHint | undefined {
  if (value === undefined || value === null) return undefined;
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return undefined;
  if (num >= 0.9) return ImportanceHint.CRITICAL;
  if (num >= 0.7) return ImportanceHint.HIGH;
  if (num >= 0.5) return ImportanceHint.MEDIUM;
  return ImportanceHint.LOW;
}

/**
 * Validates observedAt: parseable ISO 8601 and not more than 1 hour in the future
 * (clock-skew tolerance). Temporal anchoring spec, Phase 1 T3.
 */
@ValidatorConstraint({ name: 'ObservedAtNotFarFuture', async: false })
export class ObservedAtNotFarFutureConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown, _args: ValidationArguments) {
    if (value === undefined || value === null) return true;
    const d = value instanceof Date ? value : new Date(value as string);
    if (isNaN(d.getTime())) return false;
    const oneHourMs = 60 * 60 * 1000;
    return d.getTime() <= Date.now() + oneHourMs;
  }
  defaultMessage(_args: ValidationArguments) {
    return 'observedAt must be a valid ISO 8601 date no more than 1 hour in the future';
  }
}

export class CreateMemoryDto {
  // Primary field name (transforms content -> raw for backward compatibility)
  @ApiPropertyOptional({
    description: 'Memory content text',
    example: 'User prefers dark mode in all apps.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Memory content cannot be empty' })
  @Transform(({ value, obj }) => value ?? obj.content)
  raw?: string;

  // Legacy alias: content -> raw (accepted but transformed to raw)
  @ApiPropertyOptional({
    description: 'Alias for raw (backward compatibility)',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Memory content cannot be empty' })
  content?: string;

  @ApiPropertyOptional({
    description: 'Memory layer',
    enum: ['SESSION', 'PROJECT', 'IDENTITY', 'TASK'],
  })
  @IsOptional()
  @ApiPropertyOptional({
    enum: ['IDENTITY', 'PROJECT', 'SESSION', 'TASK', 'INSIGHT'],
    type: String,
  })
  @IsEnum(MemoryLayer)
  @Transform(({ value, obj }) => value ?? mapMemoryType(obj.memoryType))
  layer?: string;

  // Legacy alias: memoryType -> layer
  @IsOptional()
  @IsString()
  memoryType?: string;

  @IsOptional()
  @Transform(({ value, obj }) => {
    // If importanceHint is already set, use it
    if (value && Object.values(ImportanceHint).includes(value)) return value;
    // Otherwise, try to map from numeric importance
    return mapImportanceToHint(obj.importance);
  })
  importanceHint?: ImportanceHint;

  // Legacy alias: importance (numeric 0-1) -> importanceHint
  @IsOptional()
  @IsNumber()
  importance?: number;

  // ENG-42: User-supplied tags for filtering on recall
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsObject()
  context?: {
    projectId?: string;
    sessionId?: string;
  };

  // Subject fields: who/what is this memory ABOUT?
  @IsOptional()
  @ApiPropertyOptional({ enum: ['USER', 'AGENT', 'ENTITY'], type: String })
  @IsEnum(SubjectType)
  subjectType?: string;

  @IsOptional()
  @IsString()
  subjectId?: string;

  // For agent self-memories: which agent is this about?
  @IsOptional()
  @IsString()
  agentId?: string;

  // Memory source type (defaults to EXPLICIT_STATEMENT)
  @IsOptional()
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
    type: String,
  })
  @IsEnum(MemorySource)
  source?: string;

  /**
   * Temporal anchoring (Phase 1): when the event being memorialized actually
   * occurred, as opposed to when the memory record was created. Used to anchor
   * relative-time extraction ("yesterday", "last week") for historical imports.
   * ISO 8601. Rejected if more than 1 hour in the future (clock-skew tolerance).
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

  // Source attribution fields (for tracking where memories came from)
  @IsOptional()
  @Type(() => Date)
  sourceTimestamp?: Date;

  @IsOptional()
  @IsNumber()
  sourceTurnIndex?: number;

  @IsOptional()
  @IsString()
  sourceMessageId?: string;

  // HEY-174: Memory visibility scope
  @IsOptional()
  @ApiPropertyOptional({ enum: ['PRIVATE', 'TEAM', 'PUBLIC'], type: String })
  @IsEnum(MemoryVisibilityEnum)
  visibility?: string;

  // v0.7: Agent session attribution
  @IsOptional()
  @IsString()
  agentSessionKey?: string;

  // v0.9: Pool-scoped memory write
  @IsOptional()
  @IsString()
  poolId?: string;
}

export class CreateMemoryBatchDto {
  memories: Array<{
    raw: string;
    ts?: string; // ISO timestamp
    layer?: string;
    importanceHint?: ImportanceHint;
    /** Temporal anchoring: when the event occurred (ISO 8601). */
    observedAt?: string;
    /** Memory source type (e.g. HISTORICAL for backfilled data). */
    source?: string;
  }>;

  context?: {
    projectId?: string;
    sessionId?: string;
  };
}

/**
 * Swagger-serialisable representation of a temporal ingest warning.
 * Mirrors the `TemporalWarning` interface in memory.types.ts.
 */
export class TemporalWarningDto {
  @ApiProperty({
    description: 'Machine-readable warning code.',
    example: 'HISTORICAL_WITHOUT_ANCHOR',
  })
  code: string;

  @ApiProperty({
    description: 'Human-readable explanation for API callers.',
    example:
      'Memory ingested with source=HISTORICAL but no observedAt supplied. Relative-phrase extraction will be skipped.',
  })
  message: string;

  @ApiPropertyOptional({
    description: 'ID of the specific memory that triggered this warning.',
    example: 'mem_01HXXXXXXXXXXXXX',
  })
  memoryId?: string;
}

/** Response shape for POST /v1/memories/batch */
export class BatchCreateResponseDto {
  @ApiProperty({ example: 3 })
  created: number;

  @ApiProperty({ example: 0 })
  failed: number;

  @ApiPropertyOptional({
    type: [TemporalWarningDto],
    description:
      'Non-fatal warnings raised during ingest. Present only when at least one warning was triggered.',
  })
  warnings?: TemporalWarningDto[];
}
