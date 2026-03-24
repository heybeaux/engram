import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  BackfillService,
  BackfillResult,
  UserIdentityBackfillResult,
} from './backfill.service';
import {
  ConsolidationService,
  ConsolidationResult,
} from './consolidation.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { UserId } from '../common/decorators/user-id.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('admin')
@Controller('v1')
@UseGuards(ApiKeyOrJwtGuard, RateLimitGuard)
export class MemoryAdminController {
  constructor(
    private readonly backfillService: BackfillService,
    private readonly consolidationService: ConsolidationService,
    private readonly prisma: PrismaService,
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
    const accountUserIds = await this.resolveAccountUserIds(req);

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
  // BACKFILL (Admin)
  // =========================================================================

  /**
   * GET /v1/memories/backfill/status
   * Check how many memories need backfill
   */
  @Get('memories/backfill/status')
  @UseGuards(AdminGuard)
  async getBackfillStatus(): Promise<{ needsBackfill: number }> {
    const memories = await this.backfillService.findMemoriesNeedingBackfill();
    return { needsBackfill: memories.length };
  }

  /**
   * POST /v1/memories/backfill
   * Run backfill on memories with empty extraction data
   */
  @Post('memories/backfill')
  @UseGuards(AdminGuard)
  async runBackfill(
    @Query('dryRun') dryRun?: string,
    @Query('batchSize') batchSize?: string,
  ): Promise<BackfillResult> {
    return this.backfillService.backfillExtractions({
      dryRun: dryRun === 'true',
      batchSize: batchSize ? parseInt(batchSize, 10) : 50,
      delayMs: 500,
    });
  }

  /**
   * POST /v1/backfill/user-identity
   * Replace generic user references with actual name.
   */
  @Post('backfill/user-identity')
  @UseGuards(AdminGuard)
  async backfillUserIdentity(
    @Body()
    body: {
      userId: string;
      actualName: string;
      dryRun?: boolean;
      batchSize?: number;
    },
  ): Promise<UserIdentityBackfillResult> {
    const { userId, actualName, dryRun = false, batchSize = 1000 } = body;
    return this.backfillService.backfillUserIdentity(userId, actualName, {
      dryRun,
      batchSize,
    });
  }

  /**
   * GET /v1/backfill/user-identity/lookup
   * Find users by externalId pattern
   */
  @Get('backfill/user-identity/lookup')
  @UseGuards(AdminGuard)
  async lookupUserForBackfill(
    @Query('pattern') pattern: string,
  ): Promise<Array<{ id: string; externalId: string }>> {
    if (!pattern) {
      return [];
    }
    return this.backfillService.findUserByExternalIdPattern(pattern);
  }

  // =========================================================================
  // CONSOLIDATION
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
