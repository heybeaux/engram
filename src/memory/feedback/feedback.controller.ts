import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ApiKeyOrJwtGuard } from '../../common/guards/api-key-or-jwt.guard';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { TrajectoryFeedbackService } from './feedback.service';
import {
  TrajectoryFeedbackDto,
  TrajectoryFeedbackResponseDto,
} from './dto/feedback.dto';

@ApiTags('feedback')
@Controller('v1')
@UseGuards(ApiKeyOrJwtGuard, RateLimitGuard)
export class TrajectoryFeedbackController {
  constructor(private readonly feedbackService: TrajectoryFeedbackService) {}

  @Post('memories/feedback')
  @ApiOperation({
    summary: 'Submit trajectory feedback for recalled memories',
    description:
      'Report which recalled memories were actually used by the agent, enabling adaptive recall scoring.',
  })
  @RateLimit(120)
  @HttpCode(HttpStatus.OK)
  async submitFeedback(
    @Body() dto: TrajectoryFeedbackDto,
  ): Promise<TrajectoryFeedbackResponseDto> {
    return this.feedbackService.processFeedback(dto);
  }
}
