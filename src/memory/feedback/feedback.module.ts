import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { TrajectoryFeedbackController } from './feedback.controller';
import { TrajectoryFeedbackService } from './feedback.service';

@Module({
  imports: [PrismaModule],
  controllers: [TrajectoryFeedbackController],
  providers: [TrajectoryFeedbackService],
  exports: [TrajectoryFeedbackService],
})
export class TrajectoryFeedbackModule {}
