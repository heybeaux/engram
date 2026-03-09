import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DeduplicationService } from './deduplication.service';
import { DeduplicationController } from './deduplication.controller';
import { SimilarityService } from './similarity.service';
import { SafetyService } from './safety.service';
import { MergeService } from './merge.service';
import { LineageService } from './lineage.service';
import { ReviewService } from './review.service';
import { DedupQueueProducer } from './dedup-queue.producer';
import { DedupQueueProcessor } from './dedup-queue.processor';
import { DedupSchedulerService } from './dedup-scheduler.service';
import { DEDUP_QUEUE } from './dedup.queue';
import { MemoryModule } from '../memory/memory.module';
import { AccountModule } from '../account/account.module';
import { ServicePrismaModule } from '../prisma/service-prisma.module';
// Automated dedup pipeline (Wave 5)
import { CandidateDetectionService } from './automated/candidate-detection.service';
import {
  CandidateDetectionProcessor,
  DEDUP_AUTO_DETECTION_QUEUE,
} from './automated/candidate-detection.processor';
import { DedupClassificationService } from './automated/dedup-classification.service';
import { DedupResolutionService } from './automated/dedup-resolution.service';
import { AutoDedupController } from './automated/auto-dedup.controller';

const hasRedis = !!(
  process.env.REDIS_URL ||
  process.env.REDIS_HOST ||
  process.env.BULL_REDIS_URL
);

const bullImports = hasRedis
  ? [
      BullModule.registerQueue({ name: DEDUP_QUEUE }),
      BullModule.registerQueue({ name: DEDUP_AUTO_DETECTION_QUEUE }),
    ]
  : [];

const bullProviders = hasRedis
  ? [DedupQueueProducer, DedupQueueProcessor, DedupSchedulerService, CandidateDetectionProcessor]
  : [];

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
 * - Automated BullMQ pipeline with cron scheduling
 * - Backlog drain for high-confidence candidates
 * - Automated dedup pipeline: detection → LLM classification → auto-resolution
 *
 * Endpoints:
 * - POST   /v1/dedup/scan               - Trigger batch scan
 * - GET    /v1/dedup/scan/:scanId       - Get scan status
 * - GET    /v1/dedup/candidates         - List merge candidates
 * - POST   /v1/dedup/review/:id/approve - Approve merge
 * - POST   /v1/dedup/review/:id/reject  - Reject merge
 * - POST   /v1/dedup/merge              - Manual merge
 * - POST   /v1/dedup/merge/:id/rollback - Rollback merge
 * - POST   /v1/dedup/drain              - Manually trigger backlog drain
 * - GET    /v1/dedup/history            - Merge history
 * - GET    /v1/dedup/similar/:memoryId  - Find similar memories
 * - GET    /v1/dedup/config             - Get configuration
 * - PATCH  /v1/dedup/config             - Update configuration
 * - GET    /v1/dedup/stats              - Get statistics
 * - GET    /v1/dedup/enabled            - Check if enabled
 * --- Automated pipeline (Wave 5) ---
 * - GET    /v1/dedup/review             - Human-review queue (CLASSIFIED candidates)
 * - POST   /v1/dedup/review/:id/resolve - Resolve a candidate
 * - GET    /v1/dedup/auto-stats         - Automated pipeline stats
 */
@Module({
  imports: [AccountModule, MemoryModule, ServicePrismaModule, ...bullImports],
  controllers: [DeduplicationController, AutoDedupController],
  providers: [
    DeduplicationService,
    SimilarityService,
    SafetyService,
    MergeService,
    LineageService,
    ReviewService,
    // Automated pipeline services (always registered; processors are conditional)
    CandidateDetectionService,
    DedupClassificationService,
    DedupResolutionService,
    ...bullProviders,
  ],
  exports: [
    DeduplicationService,
    SimilarityService,
    SafetyService,
    MergeService,
    LineageService,
    ReviewService,
    CandidateDetectionService,
    DedupClassificationService,
    DedupResolutionService,
  ],
})
export class DeduplicationModule {}
