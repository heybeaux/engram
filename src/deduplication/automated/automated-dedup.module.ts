import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { ServicePrismaModule } from '../../prisma/service-prisma.module';
import { CandidateDetectionService } from './candidate-detection.service';
import {
  CandidateDetectionProcessor,
  DEDUP_AUTO_DETECTION_QUEUE,
} from './candidate-detection.processor';
import { DedupClassificationService } from './dedup-classification.service';
import {
  DedupClassificationProcessor,
  DEDUP_AUTO_CLASSIFICATION_QUEUE,
} from './dedup-classification.processor';
import { DedupResolutionService } from './dedup-resolution.service';
import { DedupPipelineService } from './dedup-pipeline.service';
import { AutoDedupController } from './auto-dedup.controller';
import { SafetyService } from '../safety.service';

const hasRedis = !!(
  process.env.REDIS_URL ||
  process.env.REDIS_HOST ||
  process.env.BULL_REDIS_URL
);

const bullImports = hasRedis
  ? [
      BullModule.registerQueue({ name: DEDUP_AUTO_DETECTION_QUEUE }),
      BullModule.registerQueue({ name: DEDUP_AUTO_CLASSIFICATION_QUEUE }),
    ]
  : [];

const bullProcessors = hasRedis
  ? [CandidateDetectionProcessor, DedupClassificationProcessor]
  : [];

/**
 * Automated Dedup Module
 *
 * Registers all services and processors for the 3-phase automated deduplication pipeline:
 *   Phase 1 — CandidateDetectionService    (vector + text similarity → DedupCandidate records)
 *   Phase 2 — DedupClassificationService   (LLM classification of PENDING candidates)
 *   Phase 3 — DedupResolutionService       (auto-merge / consolidate / queue for review)
 *
 * Orchestration is handled by DedupPipelineService (cron at 04:00 daily).
 * BullMQ queues are conditional on Redis being configured.
 */
@Module({
  imports: [ConfigModule, ServicePrismaModule, ...bullImports],
  controllers: [AutoDedupController],
  providers: [
    // Core automated pipeline services
    CandidateDetectionService,
    DedupClassificationService,
    DedupResolutionService,
    DedupPipelineService,
    // Safety checks (used by resolution service)
    SafetyService,
    // BullMQ processors (conditional on Redis)
    ...bullProcessors,
  ],
  exports: [
    CandidateDetectionService,
    DedupClassificationService,
    DedupResolutionService,
    DedupPipelineService,
  ],
})
export class AutomatedDedupModule {}
