import { Module } from '@nestjs/common';
import { LLMModule } from '../llm/llm.module';
import { TimelineLodService } from './timeline-lod.service';

@Module({
  imports: [LLMModule],
  providers: [TimelineLodService],
  exports: [TimelineLodService],
})
export class TimelineModule {}
