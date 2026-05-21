import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTimelineDto } from './dto/create-timeline.dto';
import { QueryTimelineDto } from './dto/query-timeline.dto';

@Injectable()
export class TimelineService {
  private readonly logger = new Logger(TimelineService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsert(agentId: string, dto: CreateTimelineDto) {
    const agentLocalDate = this.parseDate(dto.agentLocalDate);

    const data = {
      agentId,
      agentLocalDate,
      timezone: dto.timezone ?? 'UTC',
      chapter: dto.chapter,
      arcId: dto.arcId,
      indexText: dto.indexText,
      summaryText: dto.summaryText,
      standardText: dto.standardText,
      events: dto.events ?? [],
      decisions: dto.decisions ?? [],
      openThreadIds: dto.openThreadIds ?? [],
      people: dto.people ?? [],
      mood: dto.mood,
      significance: dto.significance ?? 0.5,
      memoryIds: dto.memoryIds ?? [],
    };

    return this.prisma.timeline.upsert({
      where: {
        agentId_agentLocalDate: { agentId, agentLocalDate },
      },
      create: data,
      update: data,
    });
  }

  async findByDateRange(agentId: string, query: QueryTimelineDto) {
    const { from, to, lod = 'summary' } = query;

    const where: any = { agentId };
    if (from || to) {
      where.agentLocalDate = {};
      if (from) where.agentLocalDate.gte = this.parseDate(from);
      if (to) where.agentLocalDate.lte = this.parseDate(to);
    }

    const timelines = await this.prisma.timeline.findMany({
      where,
      orderBy: { agentLocalDate: 'desc' },
    });

    return timelines.map((t) => this.applyLod(t, lod));
  }

  async findByDate(agentId: string, date: string, lod = 'summary') {
    const timeline = await this.findRawByDate(agentId, date);
    if (!timeline) return null;
    return this.applyLod(timeline, lod);
  }

  async findByDateDeep(agentId: string, date: string) {
    const timeline = await this.findRawByDate(agentId, date);
    if (!timeline) return null;

    const memories = timeline.memoryIds?.length
      ? await this.prisma.memory.findMany({
          where: { id: { in: timeline.memoryIds } },
        })
      : [];

    return { ...timeline, memories };
  }

  private async findRawByDate(agentId: string, date: string) {
    const agentLocalDate = this.parseDate(date);

    return this.prisma.timeline.findUnique({
      where: {
        agentId_agentLocalDate: { agentId, agentLocalDate },
      },
    });
  }

  private applyLod(timeline: any, lod: string) {
    const { indexText, summaryText, standardText, ...rest } = timeline;
    const textByLod: Record<string, string> = {
      index: indexText,
      summary: summaryText,
      standard: standardText,
    };
    return { ...rest, text: textByLod[lod] ?? summaryText };
  }

  private parseDate(value: string): Date {
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid date: ${value}`);
    }
    return parsed;
  }
}
