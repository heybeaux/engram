import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { RetrievalSignalsService } from './retrieval-signals.service';
import { FeedbackDto, FeedbackSignalType } from './dto/feedback.dto';
import {
  RetrievalLogQueryDto,
  RetrievalLogResult,
} from './dto/retrieval-log-query.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { RetrievalSignalType } from '@prisma/client';

const FEEDBACK_WEIGHT_MAP: Record<FeedbackSignalType, number> = {
  [FeedbackSignalType.EXPLICIT_HIT]: 2.0,
  [FeedbackSignalType.EXPLICIT_MISS]: -2.0,
  [FeedbackSignalType.EXPLICIT_IRRELEVANT]: -1.5,
  [FeedbackSignalType.EXPLICIT_PARTIAL]: -0.5,
};

const FEEDBACK_SIGNAL_MAP: Record<FeedbackSignalType, RetrievalSignalType> = {
  [FeedbackSignalType.EXPLICIT_HIT]: RetrievalSignalType.EXPLICIT_HIT,
  [FeedbackSignalType.EXPLICIT_MISS]: RetrievalSignalType.EXPLICIT_MISS,
  [FeedbackSignalType.EXPLICIT_IRRELEVANT]:
    RetrievalSignalType.EXPLICIT_IRRELEVANT,
  [FeedbackSignalType.EXPLICIT_PARTIAL]: RetrievalSignalType.EXPLICIT_PARTIAL,
};

@Controller('v1')
@UseGuards(ApiKeyOrJwtGuard)
export class RetrievalSignalsController {
  constructor(
    private readonly retrievalSignalsService: RetrievalSignalsService,
  ) {}

  @Post('memories/feedback')
  @HttpCode(HttpStatus.CREATED)
  @ApiTags('search')
  @ApiOperation({
    summary: 'Submit retrieval feedback',
    description:
      'Submit explicit feedback on retrieval results for adaptive retrieval optimization.',
  })
  async submitFeedback(
    @Body() dto: FeedbackDto,
    @Req() req: any,
  ): Promise<{ signalId: string }> {
    const accountId =
      req.accountId ?? req.agent?.accountId ?? req.user?.accountId ?? 'unknown';
    const weight = dto.weight ?? FEEDBACK_WEIGHT_MAP[dto.signal];

    const signalId = await this.retrievalSignalsService.logSignal({
      accountId,
      queryId: dto.queryId,
      memoryId: dto.memoryId,
      signalType: FEEDBACK_SIGNAL_MAP[dto.signal],
      weight,
      metadata: dto.metadata,
    });

    return { signalId };
  }

  @Get('retrieval-log')
  @HttpCode(HttpStatus.OK)
  @ApiTags('search')
  @ApiOperation({
    summary: 'Recent retrieval queries with attached signals',
    description:
      'Returns recent retrieval-log entries for the requesting account, joined with any RetrievalSignal rows attached to each query. Used by Ginnung cockpit to render the Engram "recent retrievals" panel. Per-result similarity scores live in the original query response (memories[*].score), not in this log.',
  })
  async listRecentQueries(
    @Query() query: RetrievalLogQueryDto,
    @Req() req: any,
  ): Promise<{ logs: RetrievalLogResult[] }> {
    const accountId =
      req.accountId ?? req.agent?.accountId ?? req.user?.accountId;
    if (!accountId) {
      return { logs: [] };
    }

    const logs = await this.retrievalSignalsService.getRecentQueries(
      accountId,
      {
        limit: query.limit,
        since: query.since ? new Date(query.since) : undefined,
      },
    );

    return { logs };
  }
}
