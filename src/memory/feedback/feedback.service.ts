import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TrajectoryFeedbackDto,
  TrajectoryFeedbackResponseDto,
} from './dto/feedback.dto';

@Injectable()
export class TrajectoryFeedbackService {
  private readonly logger = new Logger(TrajectoryFeedbackService.name);

  constructor(private readonly prisma: PrismaService) {}

  async processFeedback(
    dto: TrajectoryFeedbackDto,
  ): Promise<TrajectoryFeedbackResponseDto> {
    let updated = 0;

    if (dto.usedMemoryIds.length > 0) {
      const result = await this.prisma.memory.updateMany({
        where: { id: { in: dto.usedMemoryIds }, deletedAt: null },
        data: {
          usedCount: { increment: 1 },
          lastUsedAt: new Date(),
        },
      });
      updated += result.count;
    }

    if (dto.unusedMemoryIds && dto.unusedMemoryIds.length > 0) {
      const result = await this.prisma.memory.updateMany({
        where: { id: { in: dto.unusedMemoryIds }, deletedAt: null },
        data: {
          unusedCount: { increment: 1 },
        },
      });
      updated += result.count;
    }

    this.logger.debug(
      `[Feedback] recallId=${dto.recallId} used=${dto.usedMemoryIds.length} unused=${dto.unusedMemoryIds?.length ?? 0} updated=${updated}`,
    );

    return { updated, recallId: dto.recallId };
  }
}
