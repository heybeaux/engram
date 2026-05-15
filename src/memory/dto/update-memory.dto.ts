import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsObject,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { ImportanceHint, MemoryLayer } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for updating an existing memory (P5-001)
 *
 * PATCH /v1/memories/:id
 *
 * Allows direct editing of memory content and metadata.
 * If `raw` content changes, the memory will be re-embedded.
 */
export class UpdateMemoryDto {
  /**
   * Updated raw content of the memory.
   * If changed, triggers re-embedding for accurate semantic search.
   */
  @IsOptional()
  @IsString()
  raw?: string;

  /**
   * Change the memory layer (IDENTITY, PROJECT, SESSION, TASK)
   */
  @IsOptional()
  @ApiPropertyOptional({
    enum: ['IDENTITY', 'PROJECT', 'SESSION', 'TASK', 'INSIGHT'],
    type: String,
  })
  @IsEnum(MemoryLayer)
  layer?: string;

  /**
   * Adjust importance hint
   */
  @IsOptional()
  @ApiPropertyOptional({
    enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    type: String,
  })
  @IsEnum(ImportanceHint)
  importanceHint?: ImportanceHint;

  /**
   * Directly set importance score (0.0 - 1.0)
   * Overrides calculated importance from importanceHint
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  importanceScore?: number;

  /**
   * GIN-43: Optimistic concurrency token.
   *
   * When supplied, the update is only applied if the stored `version` still
   * matches. A mismatch means another writer modified the record first, and
   * the server responds with HTTP 409 Conflict so the caller can re-fetch
   * and retry.
   *
   * Omit this field for fire-and-forget / last-write-wins behaviour.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  version?: number;

  /**
   * Update extracted fields (5W1H)
   * Only provided fields are updated; others are preserved.
   */
  @IsOptional()
  @IsObject()
  extraction?: {
    who?: string | null;
    what?: string | null;
    when?: string | null; // ISO date string or natural language
    where?: string | null;
    why?: string | null;
    how?: string | null;
    topics?: string[];
  };
}

/**
 * DTO for correcting a memory with contradiction tracking (P5-001)
 *
 * POST /v1/memories/:id/correct
 *
 * Creates a new "correction" memory that supersedes the original.
 * The old memory is marked as superseded but preserved for history.
 * A CONTRADICTS link is created between them.
 */
export class CorrectMemoryDto {
  /**
   * The corrected content. This becomes a new memory.
   */
  @IsString()
  correctedContent: string;

  /**
   * Optional explanation of why this correction was made.
   * Stored in the link metadata.
   */
  @IsOptional()
  @IsString()
  reason?: string;

  /**
   * Override the layer for the correction memory.
   * Defaults to the same layer as the original.
   */
  @IsOptional()
  @ApiPropertyOptional({
    enum: ['IDENTITY', 'PROJECT', 'SESSION', 'TASK', 'INSIGHT'],
    type: String,
  })
  @IsEnum(MemoryLayer)
  layer?: string;

  /**
   * Override the importance for the correction.
   * Defaults to same as original or slightly higher.
   */
  @IsOptional()
  @ApiPropertyOptional({
    enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    type: String,
  })
  @IsEnum(ImportanceHint)
  importanceHint?: ImportanceHint;
}
