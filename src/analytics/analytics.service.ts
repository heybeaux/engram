import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryType, MemoryLayer } from '@prisma/client';
import {
  TimelineQueryDto,
  TimelineResponse,
  TimelineDataPoint,
} from './dto/timeline-query.dto';
import {
  TypeBreakdownQueryDto,
  TypeBreakdownResponse,
  TypeBreakdownPoint,
  LayerBreakdownQueryDto,
  LayerDistributionResponse,
  LayerDistribution,
  LayerTrendPoint,
} from './dto/breakdown-query.dto';
import { AnalyticsSummaryResponse } from './dto/summary.dto';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Get all user IDs for an agent.
   * Includes soft-deleted users so their memories are still counted in analytics.
   */
  private async getUserIdsForAgent(agentId: string): Promise<string[]> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { accountId: true },
    });
    if (!agent?.accountId) return [];
    const users = await this.prisma.user.findMany({
      where: { accountId: agent.accountId },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /**
   * Get timeline of memories over time
   */
  async getTimeline(
    agentId: string,
    dto: TimelineQueryDto,
  ): Promise<TimelineResponse> {
    const { granularity = 'day', cumulative = false } = dto;

    // Default date range
    const end = dto.end ? new Date(dto.end) : new Date();
    const start = dto.start
      ? new Date(dto.start)
      : this.getDefaultStartDate(granularity, end);

    // Get all users for this agent (including soft-deleted)
    const userIds = await this.getUserIdsForAgent(agentId);

    if (userIds.length === 0) {
      return {
        granularity,
        data: [],
        total: 0,
        range: { start: start.toISOString(), end: end.toISOString() },
      };
    }

    // Build the date_trunc interval
    const interval =
      granularity === 'hour' ? 'hour' : granularity === 'week' ? 'week' : 'day';

    // Raw SQL for time-series aggregation
    // Note: date_trunc requires literal interval, use Prisma.raw for the interval
    const intervalLiteral =
      interval === 'hour' ? 'hour' : interval === 'week' ? 'week' : 'day';
    const result = await this.prisma.$queryRawUnsafe<
      Array<{ timestamp: Date; count: bigint }>
    >(
      `
      SELECT 
        date_trunc('${intervalLiteral}', created_at) AS timestamp,
        COUNT(*) AS count
      FROM memories
      WHERE user_id = ANY($1)
        AND deleted_at IS NULL
        AND created_at >= $2
        AND created_at <= $3
      GROUP BY date_trunc('${intervalLiteral}', created_at)
      ORDER BY timestamp ASC
    `,
      userIds,
      start,
      end,
    );

    // Convert to response format
    let runningTotal = 0;
    const data: TimelineDataPoint[] = result.map((row) => {
      const count = Number(row.count);
      runningTotal += count;
      return {
        timestamp: row.timestamp.toISOString(),
        count,
        ...(cumulative ? { cumulative: runningTotal } : {}),
      };
    });

    const total = data.reduce((sum, d) => sum + d.count, 0);

    return {
      granularity,
      data,
      total,
      range: { start: start.toISOString(), end: end.toISOString() },
    };
  }

  /**
   * Get breakdown by memory type over time
   */
  async getTypeBreakdown(
    agentId: string,
    dto: TypeBreakdownQueryDto,
  ): Promise<TypeBreakdownResponse> {
    const { granularity = 'week' } = dto;

    const end = dto.end ? new Date(dto.end) : new Date();
    const start = dto.start
      ? new Date(dto.start)
      : this.getDefaultStartDate(granularity, end, 90);

    const userIds = await this.getUserIdsForAgent(agentId);

    if (userIds.length === 0) {
      return {
        granularity,
        data: [],
        summary: { dominant: null, distribution: {} },
      };
    }

    const interval =
      granularity === 'month'
        ? 'month'
        : granularity === 'week'
          ? 'week'
          : 'day';

    // Get time-series data by type
    const intervalLiteral = interval;
    const result = await this.prisma.$queryRawUnsafe<
      Array<{ timestamp: Date; memory_type: MemoryType | null; count: bigint }>
    >(
      `
      SELECT 
        date_trunc('${intervalLiteral}', created_at) AS timestamp,
        memory_type,
        COUNT(*) AS count
      FROM memories
      WHERE user_id = ANY($1)
        AND deleted_at IS NULL
        AND created_at >= $2
        AND created_at <= $3
      GROUP BY date_trunc('${intervalLiteral}', created_at), memory_type
      ORDER BY timestamp ASC, memory_type
    `,
      userIds,
      start,
      end,
    );

    // Group by timestamp
    const byTimestamp = new Map<string, TypeBreakdownPoint>();
    const allTypes: MemoryType[] = [
      'CONSTRAINT',
      'PREFERENCE',
      'FACT',
      'TASK',
      'EVENT',
      'LESSON',
      'DECISION',
      'OUTCOME',
      'GOAL',
    ];

    for (const row of result) {
      const ts = row.timestamp.toISOString();
      if (!byTimestamp.has(ts)) {
        byTimestamp.set(ts, {
          timestamp: ts,
          types: {
            CONSTRAINT: 0,
            PREFERENCE: 0,
            FACT: 0,
            TASK: 0,
            EVENT: 0,
            LESSON: 0,
            TASK_OUTCOME: 0,
            SELF_ASSESSMENT: 0,
            DECISION: 0,
            OUTCOME: 0,
            GOAL: 0,
          },
          total: 0,
        });
      }

      const point = byTimestamp.get(ts)!;
      const count = Number(row.count);
      if (row.memory_type) {
        point.types[row.memory_type] = count;
      }
      point.total += count;
    }

    const data = Array.from(byTimestamp.values());

    // Calculate summary distribution
    const typeTotals = new Map<string, number>();
    let grandTotal = 0;
    for (const point of data) {
      for (const type of allTypes) {
        typeTotals.set(type, (typeTotals.get(type) || 0) + point.types[type]);
        grandTotal += point.types[type];
      }
    }

    const distribution: Record<string, { count: number; percentage: number }> =
      {};
    let dominantType: MemoryType | null = null;
    let maxCount = 0;

    for (const [type, count] of typeTotals) {
      distribution[type] = {
        count,
        percentage: grandTotal > 0 ? (count / grandTotal) * 100 : 0,
      };
      if (count > maxCount) {
        maxCount = count;
        dominantType = type as MemoryType;
      }
    }

    return {
      granularity,
      data,
      summary: { dominant: dominantType, distribution },
    };
  }

  /**
   * Get layer distribution
   */
  async getLayerDistribution(
    agentId: string,
    dto: LayerBreakdownQueryDto,
  ): Promise<LayerDistributionResponse> {
    const { includeTrend = true, granularity = 'week' } = dto;

    const userIds = await this.getUserIdsForAgent(agentId);

    if (userIds.length === 0) {
      return {
        current: [],
        total: 0,
        ...(includeTrend ? { trend: { granularity, data: [] } } : {}),
      };
    }

    // Get current distribution
    const layerCounts = await this.prisma.$queryRaw<
      Array<{ layer: MemoryLayer; count: bigint }>
    >`
      SELECT 
        layer,
        COUNT(*) AS count
      FROM memories
      WHERE user_id = ANY(${userIds})
        AND deleted_at IS NULL
      GROUP BY layer
    `;

    const allLayers: MemoryLayer[] = [
      'IDENTITY',
      'PROJECT',
      'SESSION',
      'TASK',
      'INSIGHT',
    ];
    const layerMap = new Map<MemoryLayer, number>();
    let total = 0;

    for (const row of layerCounts) {
      const count = Number(row.count);
      layerMap.set(row.layer, count);
      total += count;
    }

    const current: LayerDistribution[] = allLayers.map((layer) => ({
      layer,
      count: layerMap.get(layer) || 0,
      percentage: total > 0 ? ((layerMap.get(layer) || 0) / total) * 100 : 0,
    }));

    const response: LayerDistributionResponse = { current, total };

    // Get trend data if requested
    if (includeTrend) {
      const end = new Date();
      const start = this.getDefaultStartDate(granularity, end, 90);
      const intervalLiteral = granularity === 'week' ? 'week' : 'day';

      const trendResult = await this.prisma.$queryRawUnsafe<
        Array<{ timestamp: Date; layer: MemoryLayer; count: bigint }>
      >(
        `
        SELECT 
          date_trunc('${intervalLiteral}', created_at) AS timestamp,
          layer,
          COUNT(*) AS count
        FROM memories
        WHERE user_id = ANY($1)
          AND deleted_at IS NULL
          AND created_at >= $2
          AND created_at <= $3
        GROUP BY date_trunc('${intervalLiteral}', created_at), layer
        ORDER BY timestamp ASC
      `,
        userIds,
        start,
        end,
      );

      const byTimestamp = new Map<string, LayerTrendPoint>();
      for (const row of trendResult) {
        const ts = row.timestamp.toISOString();
        if (!byTimestamp.has(ts)) {
          byTimestamp.set(ts, {
            timestamp: ts,
            layers: {
              IDENTITY: 0,
              PROJECT: 0,
              SESSION: 0,
              TASK: 0,
              INSIGHT: 0,
            },
          });
        }
        byTimestamp.get(ts)!.layers[row.layer] = Number(row.count);
      }

      response.trend = {
        granularity,
        data: Array.from(byTimestamp.values()),
      };
    }

    return response;
  }

  /**
   * Get summary stats for dashboard overview
   */
  async getSummary(agentId: string): Promise<AnalyticsSummaryResponse> {
    const userIds = await this.getUserIdsForAgent(agentId);

    if (userIds.length === 0) {
      return {
        totalMemories: 0,
        memoriesToday: 0,
        memoriesThisWeek: 0,
        avgImportance: 0,
        timeline: [],
        typeDistribution: {},
        layerDistribution: [],
        lastUpdated: new Date().toISOString(),
      };
    }

    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

    // Total memories
    const totalMemories = await this.prisma.memory.count({
      where: { userId: { in: userIds }, deletedAt: null },
    });

    // Memories today
    const memoriesToday = await this.prisma.memory.count({
      where: {
        userId: { in: userIds },
        deletedAt: null,
        createdAt: { gte: startOfToday },
      },
    });

    // Memories this week
    const memoriesThisWeek = await this.prisma.memory.count({
      where: {
        userId: { in: userIds },
        deletedAt: null,
        createdAt: { gte: startOfWeek },
      },
    });

    // Average importance
    const avgResult = await this.prisma.memory.aggregate({
      where: { userId: { in: userIds }, deletedAt: null },
      _avg: { importanceScore: true },
    });
    const avgImportance = avgResult._avg.importanceScore || 0;

    // Timeline (last 7 days)
    const timeline = await this.getTimeline(agentId, {
      granularity: 'day',
      start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      end: now.toISOString(),
    });

    // Type distribution (current totals)
    const typeCounts = await this.prisma.memory.groupBy({
      by: ['memoryType'],
      where: { userId: { in: userIds }, deletedAt: null },
      _count: true,
    });

    const typeDistribution: Record<
      string,
      { count: number; percentage: number }
    > = {};
    for (const row of typeCounts) {
      if (row.memoryType) {
        typeDistribution[row.memoryType] = {
          count: row._count,
          percentage:
            totalMemories > 0 ? (row._count / totalMemories) * 100 : 0,
        };
      }
    }

    // Layer distribution
    const layerResult = await this.getLayerDistribution(agentId, {
      includeTrend: false,
    });

    return {
      totalMemories,
      memoriesToday,
      memoriesThisWeek,
      avgImportance,
      timeline: timeline.data,
      typeDistribution,
      layerDistribution: layerResult.current,
      lastUpdated: now.toISOString(),
    };
  }

  /**
   * Helper to get default start date based on granularity
   */
  private getDefaultStartDate(
    granularity: 'hour' | 'day' | 'week' | 'month',
    end: Date,
    defaultDays?: number,
  ): Date {
    const start = new Date(end);
    switch (granularity) {
      case 'hour':
        start.setDate(start.getDate() - 1); // Last 24 hours
        break;
      case 'day':
        start.setDate(start.getDate() - (defaultDays || 30));
        break;
      case 'week':
        start.setDate(start.getDate() - (defaultDays || 90));
        break;
      case 'month':
        start.setFullYear(start.getFullYear() - 1);
        break;
    }
    return start;
  }
}
