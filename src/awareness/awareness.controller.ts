import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  Optional,
} from '@nestjs/common';
import { WakingCycleService } from './waking-cycle.service';
import { InsightFeedbackService } from './insight-feedback.service';
import { ProactiveNotificationService } from './proactive-notification.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { AwarenessConfig } from './config/awareness.config';
import { InsightFeedbackDto } from './dto/insight-feedback.dto';
import { PrismaService } from '../prisma/prisma.service';
import { Agent } from '../common/decorators/user-id.decorator';
import { NotificationConfigDto } from './dto/notification-config.dto';

/**
 * Awareness API — on-demand Waking Cycle trigger.
 */
@Controller('v1/awareness')
@UseGuards(ApiKeyOrJwtGuard)
export class AwarenessController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly wakingCycle?: WakingCycleService,
    @Optional() private readonly insightFeedback?: InsightFeedbackService,
    @Optional()
    private readonly proactiveNotification?: ProactiveNotificationService,
  ) {}

  @Get('insights')
  @HttpCode(200)
  async listInsights(
    @Agent() agent: any,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const take = limit ? Math.min(parseInt(limit, 10), 100) : 50;
    const skip = offset ? parseInt(offset, 10) : 0;

    // Scope insights to the requesting account when we have one. RLS still
    // gates by account at the DB layer; this explicit filter just makes the
    // intent clear. When no agent context is available (e.g. instance-key-only
    // auth path), fall back to RLS-only filtering instead of 500ing.
    const where: any = { layer: 'INSIGHT', deletedAt: null };
    if (agent?.accountId) {
      const accountUsers = await this.prisma.user.findMany({
        where: { accountId: agent.accountId, deletedAt: null },
        select: { id: true },
      });
      const accountUserIds = accountUsers.map((u) => u.id);
      if (accountUserIds.length > 0) {
        where.userId = { in: accountUserIds };
      }
    }

    const memories = await this.prisma.memory.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      select: {
        id: true,
        raw: true,
        metadata: true,
        createdAt: true,
      },
    });

    return memories.map((m) => {
      const meta = (m.metadata as Record<string, any>) || {};
      return {
        id: m.id,
        title: meta.title || null,
        content: m.raw,
        category: meta.insightType || meta.category || null,
        confidence: meta.confidence ?? null,
        createdAt: m.createdAt,
      };
    });
  }

  @Get('cycle/status')
  @HttpCode(200)
  async getCycleStatus() {
    if (!this.wakingCycle) {
      return {
        phase: 'disabled',
        lastRun: null,
        nextRun: null,
        insightsGenerated: 0,
      };
    }
    // HEY-335: Query persisted cycle run history
    const status = await this.wakingCycle.getLastCycleRun();
    return {
      phase: status.phase,
      lastRun: status.lastRunAt,
      nextRun: null, // TODO: compute from cron schedule
      insightsGenerated: status.insightsGenerated,
      duration: status.duration,
      observations: status.observations,
      patterns: status.patterns,
    };
  }

  @Get('status')
  @HttpCode(200)
  getStatus() {
    return {
      enabled: AwarenessConfig.enabled,
      schedule: AwarenessConfig.schedule,
      signals: AwarenessConfig.signals,
      github: {
        configured:
          !!AwarenessConfig.github.token &&
          AwarenessConfig.github.repos.length > 0,
        repos: AwarenessConfig.github.repos,
      },
      cycleAvailable: !!this.wakingCycle,
    };
  }

  @Post('cycle')
  @HttpCode(200)
  async triggerCycle(@Query('accountId') accountId?: string) {
    if (!this.wakingCycle) {
      return {
        error:
          'Waking Cycle not available. Set AWARENESS_ENABLED=true and redeploy.',
        enabled: AwarenessConfig.enabled,
      };
    }
    return this.wakingCycle.runCycle(accountId);
  }

  /** HEY-151: PATCH /v1/insights/:id/feedback */
  @Patch('insights/:id/feedback')
  @HttpCode(200)
  async submitInsightFeedback(
    @Param('id') insightId: string,
    @Body() dto: InsightFeedbackDto,
  ) {
    if (!this.insightFeedback) {
      return {
        error:
          'Insight feedback not available. Set AWARENESS_ENABLED=true and redeploy.',
        enabled: AwarenessConfig.enabled,
      };
    }
    return this.insightFeedback.recordFeedback(
      insightId,
      dto.action,
      dto.comment,
    );
  }

  /** HEY-154: POST /v1/notifications/configure */
  @Post('notifications/configure')
  @HttpCode(200)
  async configureNotifications(@Body() dto: NotificationConfigDto) {
    if (!this.proactiveNotification) {
      return {
        error:
          'Proactive notifications not available. Set AWARENESS_ENABLED=true and redeploy.',
        enabled: AwarenessConfig.enabled,
      };
    }
    const accountId = 'default';
    return this.proactiveNotification.configure(accountId, {
      confidenceThreshold: dto.confidenceThreshold,
      enabled: dto.enabled,
      webhookUrl: dto.webhookUrl,
      webhookSecret: dto.webhookSecret,
    });
  }

  /** HEY-154: GET /v1/notifications/config */
  @Get('notifications/config')
  @HttpCode(200)
  async getNotificationConfig() {
    if (!this.proactiveNotification) {
      return {
        error:
          'Proactive notifications not available. Set AWARENESS_ENABLED=true and redeploy.',
        enabled: AwarenessConfig.enabled,
      };
    }
    return this.proactiveNotification.getConfig('default');
  }
}
