import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Redirect,
  Optional,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { EmbedHealthService } from './embed-health.service';
import { SkipRateLimit } from '../rate-limit/rate-limit.decorator';
import { DREAM_CYCLE_STALE_MS } from '../consolidation/dream-cycle-run-tracker.service';
import { resolveBuildInfo } from './build-info';

@ApiTags('health')
@Controller()
@SkipRateLimit()
export class HealthController {
  private readonly startTime = Date.now();
  private readonly buildInfo = resolveBuildInfo();

  constructor(
    private prisma: PrismaService,
    private embedHealth: EmbedHealthService,
    @Optional() @Inject('MONITORING_SERVICE') private monitoring: any,
  ) {}

  /** GET /health → redirect to canonical /v1/health */
  @Get('health')
  @Redirect('/v1/health', 301)
  healthRedirect() {
    // 301 permanent redirect to canonical endpoint
  }

  /** GET /v1/health — canonical health check endpoint */
  @Get('v1/health')
  @ApiOperation({
    summary: 'Health check',
    description:
      'Returns system health including database, embedding service, and monitoring status.',
  })
  @ApiResponse({ status: 200, description: 'System is healthy.' })
  @ApiResponse({
    status: 503,
    description: 'System is unhealthy (database down).',
  })
  async check(): Promise<any> {
    const start = Date.now();

    // 1. Database health
    let dbStatus: 'up' | 'down' = 'down';
    let dbLatencyMs: number | null = null;
    let memoryCount: number | null = null;

    try {
      const dbStart = Date.now();
      memoryCount = await this.prisma.memory.count({
        where: { deletedAt: null },
      });
      dbLatencyMs = Date.now() - dbStart;
      dbStatus = 'up';
    } catch {
      // dbStatus remains 'down' from initialization
    }

    // 2. engram-embed health (cached)
    const embedStatus = await this.embedHealth.getStatus();

    // 3. Dream Cycle: lastRun is the newest completed run, so one orphaned
    // RUNNING report cannot hide when the cycle last actually finished.
    let dreamCycle: {
      lastRun: string | null;
      status: string;
      runningSince: string | null;
      stale: boolean;
    } | null = null;
    try {
      const [latest, lastCompleted] = await Promise.all([
        this.prisma.dreamCycleReport.findFirst({
          orderBy: { startedAt: 'desc' },
          select: { startedAt: true, status: true },
        }),
        this.prisma.dreamCycleReport.findFirst({
          where: { status: 'COMPLETED' },
          orderBy: { startedAt: 'desc' },
          select: { completedAt: true },
        }),
      ]);
      if (latest) {
        const running = latest.status === 'RUNNING';
        dreamCycle = {
          lastRun: lastCompleted?.completedAt?.toISOString() ?? null,
          status: latest.status,
          runningSince: running ? latest.startedAt.toISOString() : null,
          stale:
            running &&
            Date.now() - latest.startedAt.getTime() > DREAM_CYCLE_STALE_MS,
        };
      }
    } catch {
      // table might not exist yet
    }

    // Determine overall status
    const overallStatus =
      dbStatus === 'down'
        ? 'unhealthy'
        : embedStatus.status === 'down'
          ? 'degraded'
          : 'healthy';

    // 4. Monitoring alerts
    let monitoringAlerts: any[] = [];
    try {
      monitoringAlerts = await this.monitoring.getAlerts();
    } catch {
      // monitoring might not be ready
    }

    // Degrade status if there are critical alerts
    const hasCriticalAlerts = monitoringAlerts.some(
      (a: any) => a.level === 'critical',
    );
    if (hasCriticalAlerts && overallStatus === 'healthy') {
      // Don't override unhealthy, but flag degraded
    }

    const body = {
      status:
        hasCriticalAlerts && overallStatus === 'healthy'
          ? 'degraded'
          : overallStatus,
      version: this.buildInfo.version,
      gitSha: this.buildInfo.gitSha,
      builtAt: this.buildInfo.builtAt,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      dependencies: {
        database: {
          status: dbStatus,
          latencyMs: dbLatencyMs,
          memoryCount,
        },
        engramEmbed: {
          status: embedStatus.status,
          latencyMs: embedStatus.latencyMs,
          lastUp: embedStatus.lastUp?.toISOString() ?? null,
        },
      },
      dreamCycle,
      memory: {
        heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
      },
      monitoring: {
        alertCount: monitoringAlerts.length,
        hasCriticalAlerts,
      },
      checkedIn: `${Date.now() - start}ms`,
    };

    if (dbStatus === 'down') {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return body;
  }
}
