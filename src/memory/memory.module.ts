import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MemoryService } from './memory.service';
import { MemoryController } from './memory.controller';
import { MemoryDedupService } from './memory-dedup.service';
import { MemoryQueryService } from './memory-query.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import { MemoryGraphService } from './memory-graph.service';
import { MemoryExportService } from './memory-export.service';
import { ExtractionService } from './extraction.service';
import { EmbeddingService } from './embedding.service';
import { ImportanceService } from './importance.service';
import { BackfillService } from './backfill.service';
import { ConsolidationService } from './consolidation.service';
import { TemporalParserService } from './temporal/temporal-parser.service';
import { LLMModule } from '../llm/llm.module';
import { HierarchyModule } from '../hierarchy/hierarchy.module';
import { MultiQueryService } from '../multi-query/multi-query.service';
import { QueryExpansionService } from '../multi-query/query-expansion.service';
import { ResultFusionService } from '../multi-query/result-fusion.service';
import { ContextualRecallService } from './contextual-recall.service';
import { MemoryJobQueueService } from './memory-job-queue.service';
import { MemoryJobProcessorService } from './memory-job-processor.service';
import { EmbeddingRetryCron } from './embedding-retry.cron';
import { RecallWeightService } from './recall-weight.service';
import { MemoryPoolModule } from '../memory-pool/memory-pool.module';
import { MemoryAccessLogModule } from '../memory-access-log/memory-access-log.module';
import { AccountModule } from '../account/account.module';
import { AnticipatoryModule } from '../anticipatory/anticipatory.module';
import { GraphModule } from '../graph/graph.module';
import { QueueModule } from '../queue/queue.module';
import { ServicePrismaModule } from '../prisma/service-prisma.module';
import { EmbeddingQueueProducer } from './embedding-queue.producer';
import { EmbeddingQueueProcessor } from './embedding-queue.processor';
import { EMBEDDING_QUEUE } from './embedding.queue';

@Module({
  imports: [
    AccountModule,
    LLMModule,
    forwardRef(() => HierarchyModule),
    MemoryPoolModule,
    MemoryAccessLogModule,
    AnticipatoryModule,
    GraphModule,
    QueueModule,
    ServicePrismaModule,
    BullModule.registerQueue({ name: EMBEDDING_QUEUE }),
  ],
  controllers: [MemoryController],
  providers: [
    MemoryService,
    MemoryDedupService,
    MemoryQueryService,
    MemoryPipelineService,
    MemoryGraphService,
    MemoryExportService,
    ExtractionService,
    EmbeddingService,
    ImportanceService,
    BackfillService,
    ConsolidationService,
    TemporalParserService,
    MultiQueryService,
    QueryExpansionService,
    ResultFusionService,
    ContextualRecallService,
    MemoryJobQueueService,
    MemoryJobProcessorService,
    EmbeddingRetryCron,
    RecallWeightService,
    EmbeddingQueueProducer,
    EmbeddingQueueProcessor,
  ],
  exports: [
    MemoryService,
    BackfillService,
    ConsolidationService,
    EmbeddingService,
    TemporalParserService,
    MultiQueryService,
    ContextualRecallService,
    EmbeddingQueueProducer,
  ],
})
export class MemoryModule {}
