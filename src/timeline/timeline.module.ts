import { Module } from '@nestjs/common';
import { TimelineLodService } from './timeline-lod.service';

@Module({
  providers: [TimelineLodService],
  exports: [TimelineLodService],
})
export class TimelineModule {}
