import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { ApiKeyOrJwtGuard } from '../../common/guards/api-key-or-jwt.guard';

class ResolveDto {
  action: 'merge' | 'reject' | 'keep-both';
  notes?: string;
}

/**
 * Auto Dedup Controller
 *
 * Exposes the three new automated-dedup endpoints:
 *   GET  /v1/dedup/review            — items needing human review
 *   POST /v1/dedup/review/:id/resolve — resolve a candidate
 *   GET  /v1/dedup/auto-stats         — pipeline stats
 */
@ApiTags('deduplication')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/dedup')
export class AutoDedupController {
  constructor(private readonly prisma: ServicePrismaService) {}

  // ---------------------------------------------------------------------------
  // GET /v1/dedup/review
  // ---------------------------------------------------------------------------

  @Get('review')
  @ApiOperation({ summary: 'Get items needing human review from automated dedup pipeline' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Review queue items' })
  async getReviewQueue(@Query('limit') limit?: string) {
    const take = parseInt(limit ?? '20', 10);

    const items = await this.prisma.dedupCandidate.findMany({
      where: {
        status: 'CLASSIFIED',
        classification: { notIn: ['RELATED'] },
      },
      include: {
        memory1: { select: { id: true, raw: true, importanceScore: true } },
        memory2: { select: { id: true, raw: true, importanceScore: true } },
      },
      orderBy: { classifiedAt: 'asc' },
      take,
    });

    return { items, total: items.length };
  }

  // ---------------------------------------------------------------------------
  // POST /v1/dedup/review/:id/resolve
  // ---------------------------------------------------------------------------

  @Post('review/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve a dedup candidate (human decision)' })
  @ApiParam({ name: 'id', description: 'DedupCandidate id' })
  @ApiResponse({ status: 200, description: 'Candidate resolved' })
  async resolveCandidate(
    @Param('id') id: string,
    @Body() body: ResolveDto,
  ) {
    const notes = body.notes ? `: ${body.notes}` : '';
    await this.prisma.dedupCandidate.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        reasoning: `Human action — ${body.action}${notes}`,
      },
    });

    return { success: true, id, action: body.action };
  }

  // ---------------------------------------------------------------------------
  // GET /v1/dedup/auto-stats
  // ---------------------------------------------------------------------------

  @Get('auto-stats')
  @ApiOperation({ summary: 'Automated dedup pipeline statistics' })
  @ApiResponse({ status: 200, description: 'Pipeline stats' })
  async getAutoStats() {
    const [pending, classified, resolved, total] = await Promise.all([
      this.prisma.dedupCandidate.count({ where: { status: 'PENDING' } }),
      this.prisma.dedupCandidate.count({ where: { status: 'CLASSIFIED' } }),
      this.prisma.dedupCandidate.count({ where: { status: 'RESOLVED' } }),
      this.prisma.dedupCandidate.count(),
    ]);

    const byClassification = await this.prisma.dedupCandidate.groupBy({
      by: ['classification'],
      _count: { id: true },
      where: { classification: { not: null } },
    });

    const reviewQueueDepth = await this.prisma.dedupCandidate.count({
      where: {
        status: 'CLASSIFIED',
        classification: { notIn: ['RELATED'] },
      },
    });

    return {
      pipeline: { pending, classified, resolved, total },
      reviewQueueDepth,
      classifications: byClassification.map((g) => ({
        type: g.classification,
        count: g._count.id,
      })),
    };
  }
}
