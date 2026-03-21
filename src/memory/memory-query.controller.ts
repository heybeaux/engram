import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { MemoryService, QueryResult, ContextResult } from './memory.service';
import { QueryMemoryDto, LoadContextDto } from './dto/query-memory.dto';
import {
  ContextualRecallDto,
  ContextualRecallResponseDto,
} from './dto/contextual-recall.dto';
import { ContextualRecallService } from './contextual-recall.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { UserId } from '../common/decorators/user-id.decorator';
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
    private readonly contextualRecallService: ContextualRecallService,
    private readonly prisma: PrismaService,
    private readonly retrievalSignals: RetrievalSignalsService,
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
      'Semantic search across memories using natural language queries.',
  })
  @ApiTags('search')
  @RateLimit(60)
  async recall(
    @UserId() userId: string,
    @Body() dto: QueryMemoryDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Query('agentId') agentId?: string,
  ): Promise<QueryResult> {
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
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

    return result;
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
}
