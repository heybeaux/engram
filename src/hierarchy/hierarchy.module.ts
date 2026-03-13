import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { LLMModule } from '../llm/llm.module';
import { VectorModule } from '../vector/vector.module';
import { HierarchyService } from './hierarchy.service';
import { HierarchyController } from './hierarchy.controller';
import { SegmentationService } from './segmentation.service';
import { QueryRouterService } from './query-router.service';
import { AccountModule } from '../account/account.module';

/**
 * Hierarchical Embeddings Module
 *
 * Enables multi-granularity memory search by embedding content at multiple levels:
 * - L0: Sentence level (fine-grained facts, exact quotes)
 * - L1: Paragraph level (contextual chunks, reasoning chains)
 * - L2: Session level (conversation summaries) - Phase 2
 * - L3: Theme level (cross-session patterns) - Phase 2
 *
 * Feature flag: HIERARCHY_ENABLED (default: true)
 */
@Module({
  imports: [AccountModule, ConfigModule, PrismaModule, LLMModule, VectorModule],
  providers: [HierarchyService, SegmentationService, QueryRouterService],
  controllers: [HierarchyController],
  exports: [HierarchyService, QueryRouterService],
})
export class HierarchyModule {}
