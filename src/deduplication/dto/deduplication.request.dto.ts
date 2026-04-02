import {
  IsOptional,
  IsString,
  IsNumber,
  IsBoolean,
  IsArray,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CandidateStatus, MergeStrategy } from './deduplication.enums';

/**
 * Request to trigger batch deduplication scan
 */
export class TriggerScanDto {
  @ApiPropertyOptional({
    description: 'Run in dry-run mode (no actual merges)',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description: 'Minimum similarity threshold (0.0-1.0)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minSimilarity?: number;

  @ApiPropertyOptional({ description: 'Maximum memories to process' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10000)
  maxMemories?: number;

  @ApiPropertyOptional({ description: 'Filter to specific user ID' })
  @IsOptional()
  @IsString()
  userId?: string;
}

/**
 * Request to approve a merge candidate
 */
export class ApproveRequestDto {
  @ApiPropertyOptional({ description: 'Override suggested merge strategy' })
  @IsOptional()
  @ApiPropertyOptional({
    enum: [
      'KEEP_NEWEST',
      'KEEP_OLDEST',
      'KEEP_DETAILED',
      'KEEP_IMPORTANCE',
      'COMBINE_METADATA',
    ],
    type: String,
  })
  @IsEnum(MergeStrategy)
  strategy?: string;

  @ApiPropertyOptional({ description: 'Override suggested survivor ID' })
  @IsOptional()
  @IsString()
  survivorId?: string;

  @ApiPropertyOptional({ description: 'Custom merged content' })
  @IsOptional()
  @IsString()
  customContent?: string;
}

/**
 * Request to reject a merge candidate
 */
export class RejectRequestDto {
  @ApiProperty({ description: 'Reason for rejection' })
  @IsString()
  reason: string;

  @ApiPropertyOptional({ description: 'Add to never-merge list' })
  @IsOptional()
  @IsBoolean()
  neverMerge?: boolean;
}

/**
 * Request to manually trigger a merge
 */
export class ManualMergeDto {
  @ApiProperty({ description: 'Memory IDs to merge (2 or more)' })
  @IsArray()
  @IsString({ each: true })
  memoryIds: string[];

  @ApiProperty({ description: 'Merge strategy to use' })
  @ApiProperty({
    enum: [
      'KEEP_NEWEST',
      'KEEP_OLDEST',
      'KEEP_DETAILED',
      'KEEP_IMPORTANCE',
      'COMBINE_METADATA',
    ],
    type: String,
  })
  @IsEnum(MergeStrategy)
  strategy: string;

  @ApiPropertyOptional({ description: 'Which memory should survive' })
  @IsOptional()
  @IsString()
  survivorId?: string;

  @ApiPropertyOptional({ description: 'Custom merged content' })
  @IsOptional()
  @IsString()
  customContent?: string;
}

/**
 * Query params for listing candidates
 */
export class ListCandidatesQueryDto {
  @ApiPropertyOptional({ description: 'Filter by user ID' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Filter by status' })
  @IsOptional()
  @ApiPropertyOptional({
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'SKIPPED'],
    type: String,
  })
  @IsEnum(CandidateStatus)
  status?: string;

  @ApiPropertyOptional({ description: 'Minimum similarity filter' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  @Type(() => Number)
  minSimilarity?: number;

  @ApiPropertyOptional({ description: 'Maximum results to return' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ description: 'Offset for pagination' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}

/**
 * Request to update dedup configuration
 */
export class UpdateConfigDto {
  @ApiPropertyOptional({ description: 'Auto-merge threshold (0.0-1.0)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  autoMergeThreshold?: number;

  @ApiPropertyOptional({ description: 'Review suggest threshold (0.0-1.0)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  reviewSuggestThreshold?: number;

  @ApiPropertyOptional({ description: 'Default merge strategy' })
  @IsOptional()
  @ApiPropertyOptional({
    enum: [
      'KEEP_NEWEST',
      'KEEP_OLDEST',
      'KEEP_DETAILED',
      'KEEP_IMPORTANCE',
      'COMBINE_METADATA',
    ],
    type: String,
  })
  @IsEnum(MergeStrategy)
  defaultStrategy?: string;

  @ApiPropertyOptional({ description: 'Protected memory types' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  protectedTypes?: string[];

  @ApiPropertyOptional({ description: 'Protected keywords' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  protectedKeywords?: string[];

  @ApiPropertyOptional({ description: 'Protected importance threshold' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  protectedImportanceThreshold?: number;

  @ApiPropertyOptional({
    description:
      'Auto-resolve threshold (0.0-1.0). Candidates at or above this similarity with no safety flags are auto-approved. Set to 0 to disable.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  autoResolveThreshold?: number;

  @ApiPropertyOptional({ description: 'Enable batch deduplication' })
  @IsOptional()
  @IsBoolean()
  batchEnabled?: boolean;
}
