import { Module } from '@nestjs/common';
import { DeduplicationService } from './deduplication.service';
import { DeduplicationController } from './deduplication.controller';
import { SimilarityService } from './similarity.service';
import { SafetyService } from './safety.service';
import { MergeService } from './merge.service';
import { LineageService } from './lineage.service';
import { ReviewService } from './review.service';
import { DedupJobStoreService } from './dedup-job-store.service';
import { MemoryModule } from '../memory/memory.module';
import { AccountModule } from '../account/account.module';

/**
 * Deduplication Module
 *
 * Implements aggressive deduplication for Engram memories.
 *
 * Features:
 * - Pairwise similarity computation using embeddings
 * - Multiple merge strategies (KEEP_NEWEST, KEEP_DETAILED, etc.)
 * - Safety checks for protected memories (CONSTRAINT, allergies)
 * - Incremental dedup on new memory creation
 * - Batch dedup for full corpus scanning
 * - Review queue for human-in-the-loop approval
 * - Lineage tracking and rollback capability
 *
 * Endpoints:
 * - POST   /v1/dedup/scan              - Trigger batch scan
 * - GET    /v1/dedup/scan/:scanId      - Get scan status
 * - GET    /v1/dedup/candidates        - List merge candidates
 * - POST   /v1/dedup/review/:id/approve - Approve merge
 * - POST   /v1/dedup/review/:id/reject  - Reject merge
 * - POST   /v1/dedup/merge             - Manual merge
 * - POST   /v1/dedup/merge/:id/rollback - Rollback merge
 * - GET    /v1/dedup/history           - Merge history
 * - GET    /v1/dedup/similar/:memoryId - Find similar memories
 * - GET    /v1/dedup/config            - Get configuration
 * - PATCH  /v1/dedup/config            - Update configuration
 * - GET    /v1/dedup/stats             - Get statistics
 * - GET    /v1/dedup/enabled           - Check if enabled
 */
@Module({
  imports: [AccountModule, MemoryModule],
  controllers: [DeduplicationController],
  providers: [
    DeduplicationService,
    DedupJobStoreService,
    SimilarityService,
    SafetyService,
    MergeService,
    LineageService,
    ReviewService,
  ],
  exports: [
    DeduplicationService,
    DedupJobStoreService,
    SimilarityService,
    SafetyService,
    MergeService,
    LineageService,
    ReviewService,
  ],
})
export class DeduplicationModule {}
