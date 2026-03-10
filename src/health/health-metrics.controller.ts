import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import {
  HealthMetricsService,
  MemoryHealthReport,
} from './health-metrics.service';
import {
  HealthSnapshotService,
  MetricName,
  METRIC_NAMES,
  SnapshotResult,
  MetricSnapshot,
} from './health-snapshot.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { SkipRateLimit } from '../rate-limit/rate-limit.decorator';

@ApiTags('health')
@Controller('v1/health')
export class HealthMetricsController {
  constructor(
    private readonly metrics: HealthMetricsService,
    private readonly snapshots: HealthSnapshotService,
  ) {}

  // ── Existing endpoints ──────────────────────────────────────────────────

  @Get('metrics')
  @UseGuards(ApiKeyOrJwtGuard)
  @ApiOperation({ summary: 'Get memory system health metrics' })
  async getMetrics(): Promise<MemoryHealthReport> {
    return this.metrics.getLatest();
  }

  @Post('metrics/refresh')
  @UseGuards(ApiKeyOrJwtGuard)
  @SkipRateLimit()
  @ApiOperation({ summary: 'Force refresh of health metrics' })
  async refreshMetrics(): Promise<MemoryHealthReport> {
    return this.metrics.computeAndPersist();
  }

  // ── Snapshot endpoints ──────────────────────────────────────────────────

  /**
   * POST /v1/health/metrics/snapshot
   *
   * Trigger an immediate health metric snapshot for the calling account.
   * Computes all 5 metrics and persists them to health_metric_snapshots.
   *
   * TODO: In production, snapshots are also taken automatically every hour
   * via a scheduled task. See HealthSnapshotService for the Cron annotation.
   */
  @Post('metrics/snapshot')
  @UseGuards(ApiKeyOrJwtGuard)
  @SkipRateLimit()
  @ApiOperation({
    summary: 'Trigger a health metric snapshot',
    description:
      'Computes current health metrics and persists them for historical trending.',
  })
  async takeSnapshot(@Req() req: any): Promise<SnapshotResult> {
    const accountId: string = req.accountId ?? 'unknown';
    const agentId: string | undefined = req.agent?.id;
    return this.snapshots.takeSnapshot(accountId, agentId);
  }

  /**
   * GET /v1/health/metrics/history
   *
   * Return historical readings for a specific metric, suitable for graphing.
   *
   * @query metric  - One of: memory_freshness, embedding_coverage,
   *                  consolidation_health, dedup_health, memory_vitality
   * @query days    - How many days back to fetch (default 30, max 365)
   */
  @Get('metrics/history')
  @UseGuards(ApiKeyOrJwtGuard)
  @ApiOperation({
    summary: 'Get historical health metric readings',
    description:
      'Returns time-series data for a specific metric over the requested window.',
  })
  @ApiQuery({
    name: 'metric',
    enum: METRIC_NAMES,
    required: true,
    description: 'Which metric to return history for',
  })
  @ApiQuery({
    name: 'days',
    type: Number,
    required: false,
    description: 'How many days back to look (default 30, max 365)',
  })
  async getHistory(
    @Req() req: any,
    @Query('metric') metric: string,
    @Query('days') daysStr?: string,
  ): Promise<MetricSnapshot[]> {
    if (!metric || !(METRIC_NAMES as readonly string[]).includes(metric)) {
      throw new BadRequestException(
        `Invalid metric. Valid values: ${METRIC_NAMES.join(', ')}`,
      );
    }

    const days = daysStr ? Math.min(365, Math.max(1, parseInt(daysStr, 10))) : 30;
    if (isNaN(days)) {
      throw new BadRequestException('days must be a positive integer');
    }

    const accountId: string = req.accountId ?? 'unknown';
    return this.snapshots.getHistory(accountId, metric as MetricName, days);
  }

  /**
   * GET /v1/health/metrics/latest
   *
   * Return the most recent snapshot for all 5 health metrics.
   * Useful for dashboard cards showing "current" health at a glance.
   */
  @Get('metrics/latest')
  @UseGuards(ApiKeyOrJwtGuard)
  @ApiOperation({
    summary: 'Get latest health metric snapshots',
    description:
      'Returns the most recent snapshot for each of the 5 health metrics.',
  })
  async getLatest(
    @Req() req: any,
  ): Promise<Record<MetricName, MetricSnapshot | null>> {
    const accountId: string = req.accountId ?? 'unknown';
    return this.snapshots.getLatestAll(accountId);
  }
}
