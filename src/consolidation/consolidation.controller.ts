import {
  Controller,
  Post,
  Query,
  Body,
  Get,
  UseGuards,
  HttpCode,
  Optional,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  DreamCycleService,
  DreamCycleStage,
  DreamCycleResult,
} from './dream-cycle.service';
import { GenerateContextService } from './generate-context.service';
import type {
  GenerateContextOptions,
  GenerateContextResult,
} from './generate-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { DreamCycleQueueProducer } from './dream-cycle-queue.producer';
import { UserId } from '../common/decorators/user-id.decorator';

@ApiTags('Consolidation')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/consolidation')
export class ConsolidationController {
  constructor(
    private dreamCycle: DreamCycleService,
    private generateContext: GenerateContextService,
    private prisma: PrismaService,
    @Optional() private readonly queueProducer?: DreamCycleQueueProducer,
  ) {}

  @Post('dream-cycle')
  async runDreamCycle(
    @Query('dryRun') dryRun?: string,
    @Body()
    body?: {
      stages?: DreamCycleStage[];
      userId?: string;
      maxMemories?: number;
    },
  ): Promise<DreamCycleResult> {
    return this.dreamCycle.run({
      dryRun: dryRun === 'true' || dryRun === '1',
      stages: body?.stages,
      userId: body?.userId,
      maxMemories: body?.maxMemories,
    });
  }

  @Post('dream-cycle/async')
  @HttpCode(202)
  async startDreamCycleAsync(
    @Body()
    body?: {
      dryRun?: boolean;
      userId?: string;
      maxLlmCalls?: number;
      maxMemories?: number;
    },
    @Req() req?: any,
  ): Promise<{ runId: string; status: string }> {
    if (!this.queueProducer) throw new Error('Queue not configured');
    const userId =
      body?.userId ?? req?.user?.id ?? req?.agent?.userId ?? 'default';
    const runId = await this.queueProducer.enqueue(userId, {
      dryRun: body?.dryRun ?? false,
      maxLlmCalls: body?.maxLlmCalls,
      maxMemories: body?.maxMemories,
    });
    return { runId, status: 'queued' };
  }

  @Post('generate-context')
  async generateContextEndpoint(
    @Req() req: any,
    @UserId() userId: string | null,
    @Query('includeStale') includeStale?: string,
    @Query('tokenBudget') tokenBudget?: string,
    @Body() body?: Omit<GenerateContextOptions, 'accountId' | 'userId'>,
  ): Promise<GenerateContextResult> {
    // accountId is always resolved from the API key — it's the primary scope.
    // userId is optional narrowing: only pass it when the caller explicitly
    // provided X-AM-User-ID, otherwise query all users in the account.
    // The guard always resolves a default user even without the header, so we
    // check the raw header to distinguish "explicit" from "guard fallback".
    const accountId: string | undefined =
      req.accountId ?? req.agent?.accountId ?? undefined;
    const explicitUserHeader = req.headers?.['x-am-user-id'] as
      | string
      | undefined;

    const opts: GenerateContextOptions = {
      ...body,
      accountId,
      // Only narrow to userId when the caller explicitly sent X-AM-User-ID
      userId: explicitUserHeader ? (userId ?? undefined) : undefined,
      agentId: body?.agentId ?? undefined, // legacy fallback
    };
    if (includeStale === 'true' || includeStale === '1') {
      opts.includeStale = true;
    }
    if (tokenBudget) {
      const parsed = parseInt(tokenBudget, 10);
      if (!isNaN(parsed) && parsed > 0) {
        opts.tokenBudget = parsed;
      }
    }
    return this.generateContext.generate(opts);
  }

  @Get('dream-cycle/reports')
  async getReports(
    @Query('userId') userId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.prisma.dreamCycleReport.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit || '10', 10),
    });
  }
}
