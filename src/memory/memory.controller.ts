import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { MemoryService, ContextResult } from './memory.service';
import {
  ConsolidationService,
  ConsolidationResult,
} from './consolidation.service';
import { LoadContextDto } from './dto/query-memory.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { UserId } from '../common/decorators/user-id.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryHelpersService } from './memory-helpers.service';

@ApiTags('memories')
@Controller('v1')
@UseGuards(ApiKeyOrJwtGuard, RateLimitGuard)
export class MemoryController {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly consolidationService: ConsolidationService,
    private readonly prisma: PrismaService,
    private readonly helpers: MemoryHelpersService,
  ) {}

  // =========================================================================
  // USERS
  // =========================================================================

  /**
   * GET /v1/users
   * List all users under the authenticated account
   */
  @Get('users')
  @ApiOperation({
    summary: 'List users',
    description: 'List all users under the authenticated account.',
  })
  async listUsers(
    @Req() req: any,
    @UserId() userId: string,
  ): Promise<{
    users: Array<{
      id: string;
      externalId: string;
      displayName: string | null;
      accountId: string;
      createdAt: Date;
    }>;
  }> {
    const accountUserIds = await this.helpers.resolveAccountUserIds(req);

    const where: any = {
      deletedAt: null,
    };

    if (accountUserIds) {
      where.id = { in: accountUserIds };
    } else {
      where.id = userId;
    }

    const users = await this.prisma.user.findMany({
      where,
      distinct: ['externalId'],
      select: {
        id: true,
        externalId: true,
        displayName: true,
        accountId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return { users };
  }

  // =========================================================================
  // CONTEXT
  // =========================================================================

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

  // =========================================================================
  // CONSOLIDATION (P5-003)
  // =========================================================================

  /**
   * POST /v1/consolidate
   * Trigger memory consolidation - promotes recurring SESSION patterns to IDENTITY.
   */
  @Post('consolidate')
  async consolidate(
    @UserId() userId: string,
    @Query('dryRun') dryRun?: string,
    @Query('minOccurrences') minOccurrences?: string,
    @Query('similarityThreshold') similarityThreshold?: string,
  ): Promise<ConsolidationResult> {
    return this.consolidationService.promoteRecurringPatterns(userId, {
      dryRun: dryRun === 'true',
      minOccurrences: minOccurrences ? parseInt(minOccurrences, 10) : undefined,
      similarityThreshold: similarityThreshold
        ? parseFloat(similarityThreshold)
        : undefined,
    });
  }

  /**
   * GET /v1/consolidate/stats
   * Get consolidation statistics for the current user.
   */
  @Get('consolidate/stats')
  async getConsolidationStats(@UserId() userId: string): Promise<{
    totalMemories: number;
    sessionMemories: number;
    identityMemories: number;
    projectMemories: number;
    consolidatedCount: number;
    potentialClusters: number;
  }> {
    return this.consolidationService.getStats(userId);
  }
}
