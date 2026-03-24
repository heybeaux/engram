import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { ApiTags } from '@nestjs/swagger';
import { UserId } from '../common/decorators/user-id.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { MemoryHelpersService } from './memory-helpers.service';

@ApiTags('memories')
@Controller('v1')
@UseGuards(ApiKeyOrJwtGuard, RateLimitGuard)
export class MemoryGraphController {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly helpers: MemoryHelpersService,
  ) {}

  /**
   * GET /v1/memories/graph
   * Get memory graph data for visualization
   * NOTE: Must be registered before MemoryCrudController to avoid route collision with /memories/:id
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
    const accountUserIds = await this.helpers.resolveAccountUserIds(req);
    const effectiveUserId = accountUserIds?.[0] ?? userId;
    return this.memoryService.getGraphData(
      effectiveUserId,
      limit ? parseInt(limit, 10) : 500,
      includeAgent === 'true',
    );
  }
}
