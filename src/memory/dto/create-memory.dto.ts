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
    ],
    type: String,
  })
  @IsEnum(MemorySource)
  source?: string;

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
  }>;

  context?: {
    projectId?: string;
    sessionId?: string;
  };
}
