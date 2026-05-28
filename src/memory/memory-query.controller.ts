import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  Headers,
} from '@nestjs/common';
import type { Response } from 'express';
import { MemoryService, QueryResult, ContextResult } from './memory.service';
import { MemoryQueryService } from './memory-query.service';
import { QueryMemoryDto, LoadContextDto } from './dto/query-memory.dto';
import {
  StructuredQueryResult,
  toStructuredQueryResult,
  wantsStructuredResponse,
} from './dto/structured-recall.dto';
import {
  TraceTimelineDto,
  TraceTimelineResponse,
} from './dto/trace-timeline.dto';
import {
  FindFailuresDto,
  FindFailuresResultDto,
} from './dto/find-failures.dto';
import {
  FindContradictionsDto,
  FindContradictionsResult,
} from './dto/find-contradictions.dto';
import { ProjectStateDto, ProjectStateResponse } from './dto/project-state.dto';
import { ProjectStateService } from './project-state.service';
import {
  ContextualRecallDto,
  ContextualRecallResponseDto,
} from './dto/contextual-recall.dto';
import {
  GapDetectionQueryDto,
  GapDetectionResponse,
} from './dto/gap-detection-query.dto';
import { ContextualRecallService } from './contextual-recall.service';
import { TemporalGapService } from './temporal-gap.service';
import { ChainOfNoteService } from './chain-of-note.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { UserId } from '../common/decorators/user-id.decorator';
import { Agent } from '../common/decorators/user-id.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RetrievalSignalsService } from '../retrieval-signals/retrieval-signals.service';

@ApiTags('memories')
@Controller('v1')
@UseGuards(ApiKeyOrJwtGuard, RateLimitGuard)
export class MemoryQueryController {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly memoryQueryService: MemoryQueryService,
    private readonly contextualRecallService: ContextualRecallService,
    private readonly temporalGapService: TemporalGapService,
    private readonly prisma: PrismaService,
    private readonly retrievalSignals: RetrievalSignalsService,
    private readonly projectStateService: ProjectStateService,
    private readonly chainOfNoteService: ChainOfNoteService,
  ) {}

  /**
   * Resolve user IDs for account-wide search.
   */
  private async resolveAccountUserIds(
    req: any,
    agentId?: string,
  ): Promise<string[] | null> {
    const accountId = req.accountId ?? req.agent?.accountId;
    if (!accountId) return null;

    const where: any = { deletedAt: null };
    if (agentId) {
      where.account = { agents: { some: { id: agentId, deletedAt: null } } };
    } else {
      where.accountId = accountId;
    }

    const users = await this.prisma.user.findMany({
      where,
      select: { id: true },
    });
    return users.length > 0 ? users.map((u) => u.id) : null;
  }

  // =========================================================================
  // SEARCH & RECALL
  // =========================================================================

  /**
   * POST /v1/memories/query
   * Semantic search for memories
   */
  @Post('memories/query')
  @ApiOperation({
    summary: 'Search memories',
    description:
      'Semantic search across memories using natural language queries. ' +
      'Default response is the legacy QueryResult envelope (memories are full Prisma rows). ' +
      'Pass `?response_format=structured` (or `Accept: application/vnd.engram.v2+json`) to ' +
      'receive the v2 StructuredQueryResult shape with typed fields ' +
      '(fact, source_session, confidence, timestamp, memory_type).',
  })
  @ApiTags('search')
  @RateLimit(60)
  async recall(
    @UserId() userId: string,
    @Body() dto: QueryMemoryDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Query('agentId') agentId?: string,
    @Query('scope') scope?: string,
    @Query('response_format') responseFormat?: string,
    @Headers('accept') acceptHeader?: string,
  ): Promise<QueryResult | StructuredQueryResult> {
    const accountUserIds =
      scope === 'account' ? await this.resolveAccountUserIds(req, agentId) : null;
    const result = await this.memoryService.recall(
      accountUserIds || userId,
      dto,
    );

    // ENG-35: Log retrieval query for adaptive retrieval signals
    const accountId = req.accountId ?? req.agent?.accountId;
    if (accountId) {
      try {
        const queryId = await this.retrievalSignals.logQuery({
          accountId,
          queryText: dto.query,
          strategyConfig: { vectorWeight: 0.6, bm25Weight: 0.4, rrfK: 60 },
          resultCount: result.memories.length,
          latencyMs: result.latencyMs,
        });
        res.set('X-Query-Id', queryId);
      } catch {
        // Signal logging must never break retrieval
      }
    }

    // ENG-134: Optionally project to the v2 structured response shape.
    const wantsStructured = wantsStructuredResponse(
      responseFormat,
      acceptHeader,
    );
    const wantsCoN = dto.chainOfNote === true;

    if (wantsStructured || wantsCoN) {
      res.set('X-Response-Format', 'json_v2');
      const structured = toStructuredQueryResult(result);

      // HEY-576: Attach CoN prompt when structured format active and memories returned
      if (structured.memories.length > 0 && (wantsStructured || wantsCoN)) {
        structured.chainOfNotePrompt = this.chainOfNoteService.buildPrompt(
          structured.memories,
          dto.query,
        );
      }

      return structured;
    }

    return result;
  }

  /**
   * POST /v1/memories/find-contradictions
   * Find memories that potentially contradict a given fact or insight.
   */
  @Post('memories/find-contradictions')
  @ApiOperation({
    summary: 'Find contradictions',
    description:
      'Find memories that potentially contradict a given fact or insight using semantic similarity.',
  })
  @ApiTags('search')
  @RateLimit(30)
  async findContradictions(
    @UserId() userId: string,
    @Body() dto: FindContradictionsDto,
    @Req() req: any,
    @Query('agentId') agentId?: string,
  ): Promise<FindContradictionsResult> {
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    return this.memoryService.findContradictions(accountUserIds || userId, dto);
  }

  /**
   * POST /v1/memories/search
   * Alias for /v1/memories/query
   * @deprecated Use POST /v1/memories/query instead.
   */
  @Post('memories/search')
  @ApiOperation({
    summary: 'Search memories (alias for /query)',
    deprecated: true,
  })
  @ApiTags('search')
  @RateLimit(60)
  async search(
    @UserId() userId: string,
    @Body() dto: QueryMemoryDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Query('agentId') agentId?: string,
  ): Promise<QueryResult> {
    res.set('Deprecation', 'true');
    res.set('Link', '</v1/memories/query>; rel="successor-version"');
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    return this.memoryService.recall(accountUserIds || userId, dto);
  }

  /**
   * GET /v1/memories/search
   * GET alias for search
   * @deprecated Use POST /v1/memories/query instead.
   */
  @Get('memories/search')
  @ApiOperation({
    summary: 'Search memories (GET alias)',
    deprecated: true,
  })
  @ApiTags('search')
  @RateLimit(60)
  async searchGet(
    @UserId() userId: string,
    @Query() dto: QueryMemoryDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Query('agentId') agentId?: string,
  ): Promise<QueryResult> {
    res.set('Deprecation', 'true');
    res.set('Link', '</v1/memories/query>; rel="successor-version"');
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    return this.memoryService.recall(accountUserIds || userId, dto);
  }

  /**
   * POST /v1/recall
   * Alias for /v1/memories/query — semantic search for memories
   * @deprecated Use POST /v1/memories/query instead.
   */
  @Post('recall')
  @ApiOperation({
    summary: 'Recall memories (alias for /memories/query)',
    deprecated: true,
  })
  @ApiTags('search')
  @RateLimit(60)
  async recallAlias(
    @UserId() userId: string,
    @Body() dto: QueryMemoryDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Query('agentId') agentId?: string,
  ): Promise<QueryResult> {
    res.set('Deprecation', 'true');
    res.set('Link', '</v1/memories/query>; rel="successor-version"');
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    return this.memoryService.recall(accountUserIds || userId, dto);
  }

  /**
   * POST /v1/memories/find-failures
   * ENG-116: Find memories about past failures related to a given goal/task.
   */
  @Post('memories/find-failures')
  @ApiOperation({
    summary: 'Find failure memories',
    description:
      'Find memories about past failures semantically related to a given goal or task.',
  })
  @ApiTags('search')
  @RateLimit(30)
  async findFailures(
    @UserId() userId: string,
    @Body() dto: FindFailuresDto,
    @Req() req: any,
    @Query('agentId') agentId?: string,
  ): Promise<FindFailuresResultDto> {
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    return this.memoryService.findFailures(accountUserIds || userId, dto);
  }

  /**
   * POST /v1/recall/contextual
   * Mid-conversation contextual recall with topic shift detection.
   */
  @Post('recall/contextual')
  async contextualRecall(
    @UserId() userId: string,
    @Body() dto: ContextualRecallDto,
    @Req() req: any,
    @Query('agentId') agentId?: string,
  ): Promise<ContextualRecallResponseDto> {
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    return this.contextualRecallService.recall(accountUserIds || userId, dto);
  }

  /**
   * POST /v1/context
   * Load context for session start
   */
  @Post('context')
  @ApiOperation({
    summary: 'Load context',
    description: 'Load relevant context for an agent session bootstrap.',
  })
  @ApiTags('context')
  async loadContext(
    @UserId() userId: string,
    @Body() dto: LoadContextDto,
  ): Promise<ContextResult> {
    return this.memoryService.loadContext(userId, dto);
  }

  /**
   * POST /v1/memories/project-state
   * Synthesize the current state of a project from all related memories.
   */
  @Post('memories/project-state')
  @ApiOperation({
    summary: 'Synthesize project state',
    description:
      'Returns a structured overview of a project by categorizing related memories into goals, decisions, issues, outcomes, and insights.',
  })
  @ApiTags('search')
  @RateLimit(30)
  async projectState(
    @UserId() userId: string,
    @Body() dto: ProjectStateDto,
    @Req() req: any,
    @Query('agentId') agentId?: string,
  ): Promise<ProjectStateResponse> {
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    return this.projectStateService.synthesize(accountUserIds || userId, dto);
  }

  /**
   * GET /v1/memories/graph
   * Get memory graph data for visualization
   */
  @Get('memories/graph')
  async getGraph(
    @UserId() userId: string,
    @Req() req: any,
    @Query('limit') limit?: string,
    @Query('includeAgent') includeAgent?: string,
  ): Promise<{
    nodes: any[];
    edges: any[];
    entities: any[];
    stats?: { human: number; agent: number };
  }> {
    const accountUserIds = await this.resolveAccountUserIds(req);
    const effectiveUserId = accountUserIds?.[0] ?? userId;
    return this.memoryService.getGraphData(
      effectiveUserId,
      limit ? parseInt(limit, 10) : 500,
      includeAgent === 'true',
    );
  }

  /**
   * GET /v1/memories/gaps
   * Detect temporal gaps in memories for a given topic.
   */
  @Get('memories/gaps')
  @ApiOperation({
    summary: 'Detect temporal gaps',
    description:
      'Reports time periods with missing or abnormally sparse memories for a given topic.',
  })
  @ApiTags('analytics')
  @RateLimit(30)
  async detectGaps(
    @Agent() agent: any,
    @Query() dto: GapDetectionQueryDto,
  ): Promise<GapDetectionResponse> {
    return this.temporalGapService.detectGaps(
      dto.topic,
      new Date(dto.start),
      new Date(dto.end),
      agent.id,
    );
  }

  /**
   * POST /v1/memories/timeline
   * ENG-124: Trace chronological timeline of memories about a topic.
   */
  @Post('memories/timeline')
  @ApiOperation({
    summary: 'Trace topic timeline',
    description:
      'Returns chronological memories about a topic in a date range with gap detection.',
  })
  @ApiTags('search')
  @RateLimit(30)
  async traceTimeline(
    @Agent() agent: any,
    @Body() dto: TraceTimelineDto,
  ): Promise<TraceTimelineResponse> {
    return this.memoryQueryService.traceTimeline(agent.id, dto);
  }
}
