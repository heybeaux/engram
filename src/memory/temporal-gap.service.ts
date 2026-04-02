import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GapDetectionResponse, GapPeriod } from './dto/gap-detection-query.dto';

@Injectable()
export class TemporalGapService {
  constructor(private readonly prisma: PrismaService) {}

  async detectGaps(
    topic: string,
    startDate: Date,
    endDate: Date,
    agentId: string,
  ): Promise<GapDetectionResponse> {
    // Get memory counts per day using ILIKE keyword matching
    const dailyCounts = await this.prisma.$queryRawUnsafe<
      Array<{ day: Date; count: bigint }>
    >(
      `SELECT date_trunc('day', created_at) as day, COUNT(*) as count
       FROM memories
       WHERE agent_id = $1
         AND searchable = true
         AND deleted_at IS NULL
         AND raw ILIKE '%' || $2 || '%'
         AND created_at >= $3
         AND created_at <= $4
       GROUP BY day
       ORDER BY day`,
      agentId,
      topic,
      startDate,
      endDate,
    );

    // Build a map of day -> count
    const countsByDay = new Map<string, number>();
    for (const row of dailyCounts) {
      const dateKey = row.day.toISOString().split('T')[0];
      countsByDay.set(dateKey, Number(row.count));
    }

    // Generate all days in range
    const allDays = this.generateDateRange(startDate, endDate);
    const totalDays = allDays.length;

    // Calculate total memories and average
    let totalMemories = 0;
    for (const count of countsByDay.values()) {
      totalMemories += count;
    }
    const averagePerDay = totalDays > 0 ? totalMemories / totalDays : 0;

    // Threshold for "abnormally few": less than 50% of average (but at least 1)
    const sparseThreshold = Math.max(1, Math.floor(averagePerDay * 0.5));

    // Identify gaps
    const gaps: GapPeriod[] = [];
    let daysWithMemories = 0;

    for (const day of allDays) {
      const count = countsByDay.get(day) ?? 0;
      if (count > 0) daysWithMemories++;

      if (count === 0) {
        gaps.push({ date: day, memoryCount: 0, isAbsoluteGap: true });
      } else if (count < sparseThreshold) {
        gaps.push({ date: day, memoryCount: count, isAbsoluteGap: false });
      }
    }

    const coverage =
      totalDays > 0
        ? Math.round((daysWithMemories / totalDays) * 10000) / 100
        : 0;

    return {
      topic,
      range: {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      },
      totalMemories,
      averagePerDay: Math.round(averagePerDay * 100) / 100,
      gaps,
      coverage,
    };
  }

  private generateDateRange(start: Date, end: Date): string[] {
    const days: string[] = [];
    const current = new Date(start);
    current.setUTCHours(0, 0, 0, 0);
    const endNorm = new Date(end);
    endNorm.setUTCHours(0, 0, 0, 0);

    while (current <= endNorm) {
      days.push(current.toISOString().split('T')[0]);
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return days;
  }
}
