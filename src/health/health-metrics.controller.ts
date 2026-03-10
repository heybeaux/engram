import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  HealthMetricsService,
  MemoryHealthReport,
} from './health-metrics.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { SkipRateLimit } from '../rate-limit/rate-limit.decorator';

@ApiTags('health')
@Controller('v1/health')
export class HealthMetricsController {
  constructor(private readonly metrics: HealthMetricsService) {}

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
}
