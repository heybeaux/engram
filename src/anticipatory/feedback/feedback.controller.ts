import { Controller, Post, Body, Req, HttpCode, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { FeedbackService } from './feedback.service';
import { AnticipatoryFeedbackDto } from '../dto/anticipatory.dto';
import { ApiKeyOrJwtGuard } from '../../common/guards/api-key-or-jwt.guard';

/**
 * GIN-38: Anticipatory feedback endpoint requires authentication via
 * ApiKeyOrJwtGuard. Unauthenticated requests receive 401 Unauthorized.
 */
@ApiTags('anticipatory')
@ApiBearerAuth()
@ApiSecurity('x-am-api-key')
@Controller('anticipatory')
@UseGuards(ApiKeyOrJwtGuard)
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post('feedback')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Submit feedback on anticipatory recall results',
    description:
      'Tell the system whether an anticipatory memory was useful. ' +
      'This feedback improves future anticipatory results by adjusting ' +
      'per-strategy weights for the user.',
  })
  @ApiResponse({ status: 200, description: 'Feedback recorded' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid credentials.' })
  async submitFeedback(
    @Body() dto: AnticipatoryFeedbackDto,
    @Req() req: any,
  ): Promise<{ ok: true }> {
    const userId = req.user?.id ?? req.user?.userId ?? req.userId ?? 'unknown';
    await this.feedbackService.recordFeedback(
      dto.memoryId,
      dto.recallId,
      dto.wasUseful,
      userId,
    );
    return { ok: true };
  }
}
