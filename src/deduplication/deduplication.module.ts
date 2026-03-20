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
import { AutomatedDedupModule } from './automated/automated-dedup.module';

const hasRedis = !!(
  process.env.REDIS_URL ||
  process.env.REDIS_HOST ||
  process.env.BULL_REDIS_URL
);

const bullImports = hasRedis
  ? [BullModule.registerQueue({ name: DEDUP_QUEUE })]
  : [];

const bullProviders = hasRedis
  ? [DedupQueueProducer, DedupQueueProcessor, DedupSchedulerService]
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
 * - GET    /v1/dedup/pipeline/stats     - Pipeline stats
 * - POST   /v1/dedup/pipeline/run       - Manually trigger full pipeline run
 * - GET    /v1/dedup/auto-stats         - Automated pipeline stats (legacy alias)
 */
@Module({
  imports: [
    AccountModule,
    MemoryModule,
    ServicePrismaModule,
    AutomatedDedupModule,
    ...bullImports,
  ],
  controllers: [DeduplicationController],
  providers: [
    DeduplicationService,
    SimilarityService,
    SafetyService,
    MergeService,
    LineageService,
    ReviewService,
    ...bullProviders,
  ],
  exports: [
    DeduplicationService,
    SimilarityService,
    SafetyService,
    MergeService,
    LineageService,
    ReviewService,
  ],
})
export class DeduplicationModule {}
