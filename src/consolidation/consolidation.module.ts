import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConsolidationController } from './consolidation.controller';
import { DreamCycleService } from './dream-cycle.service';
import { DreamCycleSchedulerService } from './dream-cycle-scheduler.service';
import { DREAM_CYCLE_QUEUE } from './dream-cycle.queue';
import { DreamCycleQueueProducer } from './dream-cycle-queue.producer';
import { DreamCycleQueueProcessor } from './dream-cycle-queue.processor';
import { GenerateContextService } from './generate-context.service';
import {
  DreamCyclePatternsStage,
  DreamCycleDriftStage,
  DreamCycleIdentityStage,
  DreamCyclePendingStage,
  DreamCycleTieringStage,
  DreamCycleConsolidationStage,
} from './stages';
import { MemoryModule } from '../memory/memory.module';
import { LLMModule } from '../llm/llm.module';
import { ClusteringModule } from '../clustering/clustering.module';
import { FogIndexModule } from '../fog-index/fog-index.module';
import { AccountModule } from '../account/account.module';
import { IdentityModule } from '../identity/identity.module';
import { ServicePrismaModule } from '../prisma/service-prisma.module';
import { DreamCycleRunTrackerService } from './dream-cycle-run-tracker.service';
import { HealthMetricsService } from '../health/health-metrics.service';

const hasRedis = !!(
  process.env.REDIS_URL ||
  process.env.REDIS_HOST ||
  process.env.BULL_REDIS_URL
);

const bullImports = hasRedis
  ? [
      BullModule.registerQueue({ name: DREAM_CYCLE_QUEUE }),
      BullModule.registerFlowProducer({ name: DREAM_CYCLE_QUEUE }),
    ]
  : [];

const bullProviders = hasRedis
  ? [DreamCycleQueueProducer, DreamCycleQueueProcessor]
  : [];

const bullExports = hasRedis ? [DreamCycleQueueProducer] : [];

@Module({
  imports: [
    AccountModule,
    MemoryModule,
    LLMModule,
    ClusteringModule,
    FogIndexModule,
    IdentityModule,
    ServicePrismaModule,
    ...bullImports,
  ],
  controllers: [ConsolidationController],
  providers: [
    DreamCycleService,
    DreamCycleSchedulerService,
    ...bullProviders,
    DreamCyclePendingStage,
    DreamCyclePatternsStage,
    DreamCycleDriftStage,
    DreamCycleIdentityStage,
    DreamCycleTieringStage,
    DreamCycleConsolidationStage,
    GenerateContextService,
    DreamCycleRunTrackerService,
    HealthMetricsService,
  ],
  exports: [DreamCycleService, GenerateContextService, ...bullExports],
})
export class ConsolidationModule {}
