import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsNumber,
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
      'SYSTEM',
    ],
  })
  @IsOptional()
  @IsEnum(MemorySource)
  source?: string;

  @ApiPropertyOptional({ description: 'Optional metadata' })
  @IsOptional()
  metadata?: Record<string, any>;
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

  @ApiPropertyOptional({ description: 'Filter memories created after this date (ISO 8601)' })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Filter memories created before this date (ISO 8601)' })
  @IsOptional()
  @IsString()
  endDate?: string;
}

export interface BulkCreateResult {
  created: number;
  memoryIds: string[];
}

export interface BulkTextResult {
  created: number;
  chunks: number;
  memoryIds: string[];
}
