import { Injectable, Logger } from '@nestjs/common';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { EmbeddingService } from '../../embedding/embedding.service';
import { ConfigService } from '@nestjs/config';
import {
  TimelineLodService,
  TimelineLodOutput,
} from '../../timeline/timeline-lod.service';

export interface TimelineSynthesisStageResult {
  timelinesCreated: number;
  timelinesUpdated: number;
  daysProcessed: number;
  daysSkipped: number;
  llmCalls: number;
  errors: number;
}

@Injectable()
export class DreamCycleTimelineSynthesisStage {
  private readonly logger = new Logger(DreamCycleTimelineSynthesisStage.name);
  private readonly defaultAgentId: string;

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly config: ConfigService,
    private readonly timelineLodService: TimelineLodService,
    private readonly embeddingService: EmbeddingService,
  ) {
    this.defaultAgentId =
      this.config.get('DREAM_TIMELINE_DEFAULT_AGENT_ID') ?? 'default';
  }

  async run(
    userId: string,
    dryRun: boolean,
    remainingLlmBudget?: number,
  ): Promise<TimelineSynthesisStageResult> {
    const result: TimelineSynthesisStageResult = {
      timelinesCreated: 0,
      timelinesUpdated: 0,
      daysProcessed: 0,
      daysSkipped: 0,
      llmCalls: 0,
      errors: 0,
    };

    const budget = remainingLlmBudget ?? Infinity;

    // 1. Determine date range from last completed dream cycle
    const dateRange = await this.getDateRange(userId);
    if (!dateRange) {
      this.logger.log('No date range to process — skipping timeline synthesis');
      return result;
    }

    const { from, to } = dateRange;
    this.logger.log(
      `Timeline synthesis: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)} for user ${userId}`,
    );

    // 2. Get distinct (agentId, date) pairs with memories in range
    const dayBuckets = await this.getMemoryDayBuckets(userId, from, to);

    for (const bucket of dayBuckets) {
      if (result.llmCalls >= budget) {
        this.logger.log('LLM budget exhausted — stopping timeline synthesis');
        break;
      }

      const { agentId, date } = bucket;
      const dateStr = date.toISOString().slice(0, 10);

      try {
        // 3. Fetch memories for this agent+date
        const memories = await this.fetchDayMemories(
          userId,
          agentId,
          date,
        );

        if (memories.length === 0) {
          result.daysSkipped++;
          continue;
        }

        // 4. Check for TIMELINE_DRAFT memories
        const drafts = await this.fetchTimelineDrafts(
          userId,
          agentId,
          date,
        );

        // 5. Call TimelineLodService for LOD generation
        const lod = await this.timelineLodService.generate({
          date: dateStr,
          memories: memories.map((m) => ({
            id: m.id,
            content: m.raw,
            createdAt: m.createdAt,
          })),
          drafts,
        });
        result.llmCalls += lod.llmCalls;

        if (dryRun) {
          result.daysProcessed++;
          this.logger.debug(`[dry-run] Would upsert timeline for ${agentId} on ${dateStr}`);
          continue;
        }

        // 6. Upsert timeline record
        const isUpdate = await this.upsertTimeline(
          userId,
          agentId,
          date,
          lod,
          memories.map((m) => m.id),
        );

        if (isUpdate) {
          result.timelinesUpdated++;
        } else {
          result.timelinesCreated++;
        }

        // 7. Embed summaryText
        await this.embedSummary(agentId, date, lod.summaryText);

        result.daysProcessed++;
        this.logger.debug(
          `Timeline synthesized: ${agentId} ${dateStr} (${memories.length} memories)`,
        );
      } catch (err) {
        result.errors++;
        this.logger.error(
          `Timeline synthesis failed for ${agentId} on ${dateStr}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.logger.log(
      `Timeline synthesis complete: ${result.timelinesCreated} created, ${result.timelinesUpdated} updated, ${result.daysSkipped} skipped, ${result.errors} errors`,
    );

    return result;
  }

  async getDateRange(
    userId: string,
  ): Promise<{ from: Date; to: Date } | null> {
    // Find the last completed dream cycle report for this user
    const lastReport = await this.prisma.dreamCycleReport.findFirst({
      where: {
        userId,
        status: { in: ['COMPLETED', 'DRY_RUN'] },
      },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });

    const to = new Date();
    // Start of today (midnight UTC)
    to.setUTCHours(0, 0, 0, 0);

    if (lastReport) {
      const from = new Date(lastReport.startedAt);
      from.setUTCHours(0, 0, 0, 0);
      // If the last report was today, nothing to process
      if (from.getTime() >= to.getTime()) return null;
      return { from, to };
    }

    // No prior run — default to last 7 days
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - 7);
    return { from, to };
  }

  async getMemoryDayBuckets(
    userId: string,
    from: Date,
    to: Date,
  ): Promise<Array<{ agentId: string; date: Date }>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ agent_id: string | null; day: Date }>
    >`
      SELECT agent_id, DATE(created_at) as day
      FROM memories
      WHERE user_id = ${userId}
        AND deleted_at IS NULL
        AND created_at >= ${from}
        AND created_at < ${to}
      GROUP BY agent_id, DATE(created_at)
      ORDER BY day ASC
    `;

    return rows.map((r) => ({
      agentId: r.agent_id ?? this.defaultAgentId,
      date: new Date(r.day),
    }));
  }

  async fetchDayMemories(
    userId: string,
    agentId: string,
    date: Date,
  ): Promise<Array<{ id: string; raw: string; createdAt: Date }>> {
    const nextDay = new Date(date);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);

    const agentFilter =
      agentId === this.defaultAgentId
        ? { agentId: null }
        : { agentId };

    return this.prisma.memory.findMany({
      where: {
        userId,
        ...agentFilter,
        deletedAt: null,
        createdAt: { gte: date, lt: nextDay },
      },
      select: { id: true, raw: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async fetchTimelineDrafts(
    userId: string,
    agentId: string,
    date: Date,
  ): Promise<string[]> {
    const nextDay = new Date(date);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);

    const agentFilter =
      agentId === this.defaultAgentId
        ? { agentId: null }
        : { agentId };

    const drafts = await this.prisma.memory.findMany({
      where: {
        userId,
        ...agentFilter,
        deletedAt: null,
        createdAt: { gte: date, lt: nextDay },
        raw: { startsWith: 'TIMELINE_DRAFT:' },
      },
      select: { raw: true },
      orderBy: { createdAt: 'asc' },
    });

    return drafts.map((d) => d.raw.replace(/^TIMELINE_DRAFT:\s*/, ''));
  }

  async upsertTimeline(
    userId: string,
    agentId: string,
    date: Date,
    lod: TimelineLodOutput,
    memoryIds: string[],
  ): Promise<boolean> {
    const existing = await this.prisma.timeline.findUnique({
      where: { agentId_date: { agentId, date } },
      select: { id: true },
    });

    const data = {
      chapter: lod.chapter,
      indexText: lod.indexText,
      summaryText: lod.summaryText,
      standardText: lod.standardText,
      events: lod.events as any,
      decisions: lod.decisions as any,
      openThreads: lod.openThreads as any,
      people: lod.people,
      mood: lod.mood,
      significance: lod.significance,
      memoryIds,
      llmCalls: lod.llmCalls,
    };

    if (existing) {
      await this.prisma.timeline.update({
        where: { id: existing.id },
        data,
      });
      return true;
    }

    await this.prisma.timeline.create({
      data: {
        userId,
        agentId,
        date,
        ...data,
      },
    });
    return false;
  }

  async embedSummary(
    agentId: string,
    date: Date,
    summaryText: string,
  ): Promise<void> {
    const [embedding] = await this.embeddingService.embed([summaryText]);
    if (embedding) {
      await this.prisma.$executeRaw`
        UPDATE timelines
        SET summary_embedding = ${JSON.stringify(embedding)}::vector
        WHERE agent_id = ${agentId} AND date = ${date}
      `;
    }
  }
}
