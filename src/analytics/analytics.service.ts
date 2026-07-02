import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, MemoryType, MemoryLayer } from '@prisma/client';
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

/** Allowlisted values for date_trunc interval argument */
const VALID_DATE_TRUNC_INTERVALS = ['hour', 'day', 'week', 'month'] as const;
type DateTruncInterval = (typeof VALID_DATE_TRUNC_INTERVALS)[number];

/**
 * Validate that an interval string is one of the known-safe values.
 * This prevents injection via the date_trunc() literal argument which
 * cannot be parameterized in PostgreSQL.
 *
 * Rejects null, undefined, empty string, and any value not in the allowlist.
 * Must be called BEFORE the value is used in any SQL construction.
 */
function validateInterval(value: unknown): DateTruncInterval {
  if (
    value == null ||
    typeof value !== 'string' ||
    !VALID_DATE_TRUNC_INTERVALS.includes(value as DateTruncInterval)
  ) {
    throw new BadRequestException(
      `Invalid interval value: ${String(value)}. Must be one of: ${VALID_DATE_TRUNC_INTERVALS.join(', ')}`,
    );
  }
  return value as DateTruncInterval;
}

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

    // Build the date_trunc interval — validated against allowlist to prevent injection.
    // Any value not in the allowlist throws BadRequestException rather than
    // silently defaulting, ensuring defense-in-depth.
    const intervalLiteral = validateInterval(granularity);

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

    // Raw SQL for time-series aggregation using parameterized $queryRaw.
    // The date_trunc interval remains parameterized after allowlist validation.
    // Compute the bucket once in a subquery, then group by the alias; repeating
    // date_trunc($param, created_at) in SELECT and GROUP BY can produce distinct
    // placeholders that Postgres does not consider the same expression.
    const result = await this.prisma.$queryRaw<
      Array<{ timestamp: Date; count: bigint }>
    >(
      Prisma.sql`
      SELECT
        bucket AS timestamp,
        COUNT(*) AS count
      FROM (
        SELECT date_trunc(${intervalLiteral}, created_at) AS bucket
        FROM memories
        WHERE user_id = ANY(${userIds})
          AND deleted_at IS NULL
          AND created_at >= ${start}
          AND created_at <= ${end}
      ) AS memory_buckets
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
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

    // Validate interval against allowlist before using in SQL. Passing granularity
    // directly ensures injection strings are rejected rather than silently
    // defaulting to 'day', providing defense-in-depth.
    const intervalLiteral = validateInterval(granularity);

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

    // Get time-series data by type using parameterized $queryRaw.
    // Compute the truncated timestamp once so SELECT/GROUP BY do not use
    // separate parameter placeholders for the same date_trunc interval.
    const result = await this.prisma.$queryRaw<
      Array<{ timestamp: Date; memory_type: MemoryType | null; count: bigint }>
    >(
      Prisma.sql`
      SELECT
        bucket AS timestamp,
        memory_type,
        COUNT(*) AS count
      FROM (
        SELECT
          date_trunc(${intervalLiteral}, created_at) AS bucket,
          memory_type
        FROM memories
        WHERE user_id = ANY(${userIds})
          AND deleted_at IS NULL
          AND created_at >= ${start}
          AND created_at <= ${end}
      ) AS memory_buckets
      GROUP BY bucket, memory_type
      ORDER BY bucket ASC, memory_type
    `,
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
            TEMPORAL_GAP: 0,
            FACT_KEY: 0,
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

    // Validate the interval early — before any DB access — so injection strings
    // are rejected at the service boundary regardless of the includeTrend flag.
    // Only performed when trend data is requested (granularity only matters then).
    if (includeTrend) {
      validateInterval(granularity);
    }

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
      // Validate interval against allowlist before using in SQL. Passing granularity
      // directly ensures injection strings are rejected up front.
      const intervalLiteral = validateInterval(granularity);

      const trendResult = await this.prisma.$queryRaw<
        Array<{ timestamp: Date; layer: MemoryLayer; count: bigint }>
      >(
        Prisma.sql`
        SELECT
          bucket AS timestamp,
          layer,
          COUNT(*) AS count
        FROM (
          SELECT
            date_trunc(${intervalLiteral}, created_at) AS bucket,
            layer
          FROM memories
          WHERE user_id = ANY(${userIds})
            AND deleted_at IS NULL
            AND created_at >= ${start}
            AND created_at <= ${end}
        ) AS memory_buckets
        GROUP BY bucket, layer
        ORDER BY bucket ASC
      `,
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
