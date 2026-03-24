import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { Agent } from '../common/decorators/user-id.decorator';
import { TimelineService } from './timeline.service';
import { CreateTimelineDto } from './dto/create-timeline.dto';
import { QueryTimelineDto, TeamQueryDto } from './dto/query-timeline.dto';

@ApiTags('Timelines')
@UseGuards(ApiKeyOrJwtGuard, RateLimitGuard)
@Controller('v1/timelines')
export class TimelineController {
  constructor(private readonly timelineService: TimelineService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create or upsert a timeline entry' })
  @ApiResponse({ status: 201, description: 'Timeline created/updated.' })
  async upsert(
    @Agent() agent: any,
    @Body() dto: CreateTimelineDto,
  ) {
    return this.timelineService.upsert(agent.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Query timelines by date range' })
  @ApiResponse({ status: 200, description: 'List of timelines.' })
  async findAll(
    @Agent() agent: any,
    @Query() query: QueryTimelineDto,
  ) {
    return this.timelineService.findByDateRange(agent.id, query);
  }

  @Get('team')
  @HttpCode(HttpStatus.NOT_IMPLEMENTED)
  @ApiOperation({ summary: 'Team aggregate timeline (stub)' })
  @ApiResponse({ status: 501, description: 'Not implemented.' })
  async teamAggregate(@Query() _query: TeamQueryDto) {
    return { statusCode: 501, message: 'Team timeline not yet implemented' };
  }

  @Get(':date/deep')
  @ApiOperation({ summary: 'Get timeline with linked memory content' })
  @ApiResponse({ status: 200, description: 'Timeline with resolved memories.' })
  async findDeep(
    @Agent() agent: any,
    @Param('date') date: string,
  ) {
    const result = await this.timelineService.findByDateDeep(agent.id, date);
    if (!result) {
      throw new NotFoundException(`No timeline found for date ${date}`);
    }
    return result;
  }

  @Get(':date')
  @ApiOperation({ summary: 'Get single day timeline' })
  @ApiQuery({ name: 'lod', required: false, enum: ['index', 'summary', 'standard'] })
  @ApiResponse({ status: 200, description: 'Single timeline entry.' })
  async findByDate(
    @Agent() agent: any,
    @Param('date') date: string,
    @Query('lod') lod?: string,
  ) {
    const result = await this.timelineService.findByDate(
      agent.id,
      date,
      lod || 'summary',
    );
    if (!result) {
      throw new NotFoundException(`No timeline found for date ${date}`);
    }
    return result;
  }
}
