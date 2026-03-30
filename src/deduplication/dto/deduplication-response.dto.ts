import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SafetyReasonType } from './deduplication-enums';

/**
 * Safety reason attached to a memory/candidate
 */
export class SafetyReasonDto {
  @ApiProperty({
    enum: [
      'protected_type',
      'protected_keyword',
      'high_importance',
      'requires_review',
      'recently_accessed',
      'manually_edited',
    ],
  })
  type: string;

  @ApiPropertyOptional()
  memoryType?: string;

  @ApiPropertyOptional()
  keyword?: string;

  @ApiPropertyOptional()
  score?: number;

  @ApiPropertyOptional()
  lastAccessed?: Date;
}

/**
 * Memory summary in candidate
 */
export class MemorySummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  content: string;

  @ApiPropertyOptional()
  memoryType?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  importanceScore: number;
}

/**
 * Merge candidate response
 */
export class MergeCandidateDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ type: [MemorySummaryDto] })
  memories: MemorySummaryDto[];

  @ApiProperty()
  similarity: number;

  @ApiProperty({
    enum: [
      'KEEP_NEWEST',
      'KEEP_OLDEST',
      'KEEP_DETAILED',
      'KEEP_IMPORTANCE',
      'COMBINE_METADATA',
    ],
  })
  suggestedStrategy: string;

  @ApiProperty()
  suggestedSurvivorId: string;

  @ApiProperty({ type: [SafetyReasonDto] })
  safetyFlags: SafetyReasonDto[];

  @ApiProperty({ enum: ['PENDING', 'APPROVED', 'REJECTED', 'SKIPPED'] })
  status: string;

  @ApiProperty()
  createdAt: Date;
}

/**
 * Response for listing candidates
 */
export class ListCandidatesResponseDto {
  @ApiProperty({ type: [MergeCandidateDto] })
  candidates: MergeCandidateDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  pendingCount: number;
}

/**
 * Response from approving a merge
 */
export class ApproveResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  mergeEventId: string;

  @ApiProperty()
  survivorId: string;

  @ApiProperty({ type: [String] })
  absorbedIds: string[];
}

/**
 * Response from rejecting a merge
 */
export class RejectResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  addedToNeverMerge: boolean;
}

/**
 * Response from batch scan
 */
export class ScanResponseDto {
  @ApiProperty()
  scanId: string;

  @ApiProperty({ enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'] })
  status: string;

  @ApiProperty()
  memoriesProcessed: number;

  @ApiProperty()
  clustersFound: number;

  @ApiProperty()
  autoMerged: number;

  @ApiProperty()
  queuedForReview: number;

  @ApiProperty()
  durationMs: number;
}

/**
 * Response from manual merge
 */
export class MergeResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  mergeEventId: string;

  @ApiProperty()
  survivorId: string;

  @ApiProperty({ type: [String] })
  absorbedIds: string[];

  @ApiProperty()
  mergedContent: string;
}

/**
 * Response from rollback
 */
export class RollbackResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: [String] })
  restoredMemoryIds: string[];

  @ApiProperty()
  survivorId: string;
}

/**
 * Dedup configuration response
 */
export class ConfigResponseDto {
  @ApiProperty()
  autoMergeThreshold: number;

  @ApiProperty()
  reviewSuggestThreshold: number;

  @ApiProperty({
    enum: [
      'KEEP_NEWEST',
      'KEEP_OLDEST',
      'KEEP_DETAILED',
      'KEEP_IMPORTANCE',
      'COMBINE_METADATA',
    ],
  })
  defaultStrategy: string;

  @ApiProperty({ type: [String] })
  protectedTypes: string[];

  @ApiProperty({ type: [String] })
  protectedKeywords: string[];

  @ApiProperty()
  protectedImportanceThreshold: number;

  @ApiProperty({
    description:
      'Auto-resolve threshold. Candidates at or above this with no safety flags are auto-approved. 0 = disabled.',
  })
  autoResolveThreshold: number;

  @ApiProperty()
  batchEnabled: boolean;

  @ApiPropertyOptional()
  lastBatchRunAt?: Date;
}

/**
 * Dedup statistics response
 */
export class StatsResponseDto {
  @ApiProperty()
  totalMemories: number;

  @ApiProperty()
  potentialDuplicates: number;

  @ApiProperty()
  clustersIdentified: number;

  @ApiProperty()
  autoMergedToday: number;

  @ApiProperty()
  pendingReview: number;

  @ApiProperty()
  compressionRatio: number;

  @ApiProperty()
  mergesThisWeek: number;

  @ApiProperty()
  rollbacksThisWeek: number;
}

/**
 * Similar memory result from search
 */
export class SimilarMemoryDto {
  @ApiProperty()
  memoryId: string;

  @ApiProperty()
  similarity: number;

  @ApiProperty()
  content: string;

  @ApiPropertyOptional()
  memoryType?: string;

  @ApiProperty()
  createdAt: Date;
}

/**
 * Safety check result
 */
export class SafetyCheckResultDto {
  @ApiProperty()
  memoryId: string;

  @ApiProperty()
  isProtected: boolean;

  @ApiProperty()
  canAutoMerge: boolean;

  @ApiProperty()
  requiresReview: boolean;

  @ApiProperty({ type: [SafetyReasonDto] })
  reasons: SafetyReasonDto[];
}

/**
 * Merge event for lineage tracking
 */
export class MergeEventDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  survivorMemoryId: string;

  @ApiProperty({ type: [String] })
  absorbedMemoryIds: string[];

  @ApiProperty({
    enum: [
      'KEEP_NEWEST',
      'KEEP_OLDEST',
      'KEEP_DETAILED',
      'KEEP_IMPORTANCE',
      'COMBINE_METADATA',
    ],
  })
  strategy: string;

  @ApiProperty()
  similarity: number;

  @ApiProperty()
  triggeredBy: string;

  @ApiPropertyOptional()
  approvedBy?: string;

  @ApiProperty()
  mergedContent: string;

  @ApiProperty()
  contentChanged: boolean;

  @ApiProperty()
  canRollback: boolean;

  @ApiPropertyOptional()
  rolledBackAt?: Date;

  @ApiProperty()
  createdAt: Date;
}
