import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LLMModule } from '../llm/llm.module';
import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { TimelineLodService } from './timeline-lod.service';

@Module({
  imports: [PrismaModule, LLMModule],
  controllers: [TimelineController],
  providers: [TimelineService, TimelineLodService],
  exports: [TimelineService, TimelineLodService],
})
export class TimelineModule {}
