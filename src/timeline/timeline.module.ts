import { Module } from '@nestjs/common';
import { TimelineLodService } from './timeline-lod.service';
import { LLMModule } from '../llm/llm.module';

@Module({
  imports: [LLMModule],
  providers: [TimelineLodService],
  exports: [TimelineLodService],
})
export class TimelineModule {}
