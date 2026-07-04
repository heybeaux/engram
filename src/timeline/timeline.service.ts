import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { toValidatedVectorLiteral } from '../memory/vector-literal.util';
import { CreateTimelineDto } from './dto/create-timeline.dto';
import { QueryTimelineDto } from './dto/query-timeline.dto';
import { ArcSearchDto } from './dto/arc-search.dto';

type ArcScoreAgg = 'max' | 'mean';

/** One candidate day surfaced by the semantic / calendar scan. */
interface CandidateDay {
  arcId: string;
  agentLocalDate: Date;
  chapter: string;
  significance: number;
  indexText: string;
  summaryText: string;
  standardText: string;
  score: number; // similarity (0..1); 0 on the calendar-only path
}

export interface ArcSearchResult {
  arcId: string;
  title: string;
  summary: string;
  from: string;
  to: string;
  dayCount: number;
  score: number;
  topDays: Array<{ date: string; score: number }>;
}

/**
 * Resolve a representative arc title from its member days.
 *
 * Fallback chain (v1 heuristic — LLM titling is a fast-follow, hence this
 * lives in one swappable function):
 *   1. a `chapter` shared by every member day;
 *   2. else the `chapter` of the highest-significance day;
 *   3. else `"Arc {from}–{to}"`.
 */
export function resolveArcTitle(
  days: Array<{ chapter?: string | null; significance: number }>,
  from: string,
  to: string,
): string {
  const chapters = days.map((d) => (d.chapter ?? '').trim()).filter(Boolean);
  if (chapters.length === days.length && chapters.length > 0) {
    const first = chapters[0];
    if (chapters.every((c) => c === first)) return first;
  }

  const bySignificance = [...days].sort(
    (a, b) => b.significance - a.significance,
  );
  const topChapter = (bySignificance[0]?.chapter ?? '').trim();
  if (topChapter) return topChapter;

  return `Arc ${from}\u2013${to}`;
}

@Injectable()
export class TimelineService {
  private readonly logger = new Logger(TimelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
    private readonly config: ConfigService,
  ) {}

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
    const { from, to, arcId, lod = 'summary' } = query;

    const where: any = { agentId };
    if (arcId) where.arcId = arcId;
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

  /**
   * Recall an entire arc: all timelines tagged with the given arcId,
   * ordered chronologically (ascending) so the arc reads as a story.
   */
  async findByArc(agentId: string, arcId: string, lod = 'summary') {
    const timelines = await this.prisma.timeline.findMany({
      where: { agentId, arcId },
      orderBy: { agentLocalDate: 'asc' },
    });

    return timelines.map((t) => this.applyLod(t, lod));
  }

  /**
   * Search arcs semantically and/or by calendar window.
   *
   * Pipeline (Option A — query-time aggregation, no materialized Arc table):
   *   1. Select candidate days: agent-scoped, optional date window, arcId != null.
   *   2. Semantic path (query present): embed the query with the SAME 768-dim
   *      model that wrote `summaryEmbedding`, rank member days by pgvector cosine
   *      similarity via a PARAMETERIZED vector (never string-interpolated).
   *      Calendar-only path (no query): skip embedding, order by `to` desc.
   *   3. Group matched days by arcId; aggregate score (max default, mean behind
   *      ARC_SCORE_AGG); compute from / to / dayCount.
   *   4. Resolve a representative title + summary (at the requested LOD) from the
   *      top day.
   *   5. Clamp to `limit`.
   */
  async searchArcs(
    agentId: string,
    dto: ArcSearchDto,
  ): Promise<{ arcs: ArcSearchResult[] }> {
    const { query, from, to, lod = 'summary' } = dto;
    const limit = dto.limit ?? 10;

    if (!query && !from && !to) {
      throw new BadRequestException(
        'At least one of `query`, `from`, or `to` is required',
      );
    }

    const fromDate = from ? this.parseDate(from) : null;
    const toDate = to ? this.parseDate(to) : null;
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException('`from` must be on or before `to`');
    }

    const candidates = query
      ? await this.semanticCandidates(agentId, query, fromDate, toDate)
      : await this.calendarCandidates(agentId, fromDate, toDate);

    if (candidates.length === 0) {
      return { arcs: [] };
    }

    const arcs = this.aggregateByArc(candidates, lod);
    return { arcs: arcs.slice(0, limit) };
  }

  /**
   * Semantic candidate scan. Embeds `query` with the shared embedding service
   * (768-dim, same model as `summaryEmbedding`) and ranks arc-tagged days by
   * cosine similarity. The query vector is passed as a bound `$_::vector`
   * parameter — it is NEVER interpolated into the SQL string.
   */
  private async semanticCandidates(
    agentId: string,
    query: string,
    fromDate: Date | null,
    toDate: Date | null,
  ): Promise<CandidateDay[]> {
    const [embedding] = await this.embeddingService.embed([query]);
    const vectorLiteral = toValidatedVectorLiteral(
      embedding,
      'TimelineService.searchArcs query',
    );

    // Params are positional and bound; only the WHERE shape is assembled from
    // trusted constants. No user value is ever concatenated into the SQL.
    const params: any[] = [agentId, vectorLiteral];
    let dateClause = '';
    if (fromDate) {
      params.push(fromDate);
      dateClause += ` AND "agentLocalDate" >= $${params.length}`;
    }
    if (toDate) {
      params.push(toDate);
      dateClause += ` AND "agentLocalDate" <= $${params.length}`;
    }

    const sql = `
      SELECT
        "arcId",
        "agentLocalDate",
        "chapter",
        "significance",
        "indexText",
        "summaryText",
        "standardText",
        1 - ("summaryEmbedding" <=> $2::vector) AS score
      FROM "timelines"
      WHERE "agentId" = $1
        AND "arcId" IS NOT NULL
        AND "summaryEmbedding" IS NOT NULL${dateClause}
      ORDER BY "summaryEmbedding" <=> $2::vector ASC
    `;

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        arcId: string;
        agentLocalDate: Date;
        chapter: string;
        significance: number;
        indexText: string;
        summaryText: string;
        standardText: string;
        score: number;
      }>
    >(sql, ...params);

    return rows.map((r) => ({
      arcId: r.arcId,
      agentLocalDate: r.agentLocalDate,
      chapter: r.chapter,
      significance: Number(r.significance),
      indexText: r.indexText,
      summaryText: r.summaryText,
      standardText: r.standardText,
      score: Number(r.score),
    }));
  }

  /**
   * Calendar-only candidate scan (no `query`). Skips embedding entirely and
   * orders arc-tagged days by recency; the per-arc `to` desc ordering is
   * produced downstream by {@link aggregateByArc}.
   */
  private async calendarCandidates(
    agentId: string,
    fromDate: Date | null,
    toDate: Date | null,
  ): Promise<CandidateDay[]> {
    const where: any = { agentId, arcId: { not: null } };
    if (fromDate || toDate) {
      where.agentLocalDate = {};
      if (fromDate) where.agentLocalDate.gte = fromDate;
      if (toDate) where.agentLocalDate.lte = toDate;
    }

    const rows = await this.prisma.timeline.findMany({
      where,
      orderBy: { agentLocalDate: 'desc' },
      select: {
        arcId: true,
        agentLocalDate: true,
        chapter: true,
        significance: true,
        indexText: true,
        summaryText: true,
        standardText: true,
      },
    });

    return rows.map((r) => ({
      arcId: r.arcId as string,
      agentLocalDate: r.agentLocalDate,
      chapter: r.chapter,
      significance: r.significance,
      indexText: r.indexText,
      summaryText: r.summaryText,
      standardText: r.standardText,
      score: 0,
    }));
  }

  /**
   * Group candidate days by arcId and build the ranked arc result set.
   *
   * Score aggregation: `max` (default) favours the arc containing the single
   * most relevant day; `mean` is available behind the `ARC_SCORE_AGG` config.
   * Semantic results order by aggregated score desc; calendar-only results
   * (all scores 0) order by `to` desc (recency).
   */
  private aggregateByArc(
    candidates: CandidateDay[],
    lod: string,
  ): ArcSearchResult[] {
    const agg = this.scoreAgg();
    const semantic = candidates.some((c) => c.score > 0);

    const groups = new Map<string, CandidateDay[]>();
    for (const c of candidates) {
      const bucket = groups.get(c.arcId);
      if (bucket) bucket.push(c);
      else groups.set(c.arcId, [c]);
    }

    const results: ArcSearchResult[] = [];
    for (const [arcId, days] of groups) {
      const scores = days.map((d) => d.score);
      const score =
        agg === 'mean'
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : Math.max(...scores);

      const times = days.map((d) => d.agentLocalDate.getTime());
      const from = this.dateStr(new Date(Math.min(...times)));
      const to = this.dateStr(new Date(Math.max(...times)));

      // Representative day: top-scoring on the semantic path, else the
      // highest-significance day on the calendar-only path.
      const topDay = semantic
        ? [...days].sort((a, b) => b.score - a.score)[0]
        : [...days].sort((a, b) => b.significance - a.significance)[0];

      const title = resolveArcTitle(days, from, to);
      const summary = this.textAtLod(topDay, lod);

      const topDays = [...days]
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((d) => ({
          date: this.dateStr(d.agentLocalDate),
          score: d.score,
        }));

      results.push({
        arcId,
        title,
        summary,
        from,
        to,
        dayCount: days.length,
        score,
        topDays,
      });
    }

    if (semantic) {
      results.sort((a, b) => b.score - a.score);
    } else {
      results.sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
    }

    return results;
  }

  private scoreAgg(): ArcScoreAgg {
    const raw = (this.config.get<string>('ARC_SCORE_AGG') ?? 'max')
      .trim()
      .toLowerCase();
    return raw === 'mean' ? 'mean' : 'max';
  }

  private textAtLod(day: CandidateDay, lod: string): string {
    const byLod: Record<string, string> = {
      index: day.indexText,
      summary: day.summaryText,
      standard: day.standardText,
    };
    return byLod[lod] ?? day.summaryText;
  }

  private dateStr(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /**
   * Close an arc: stamp a contiguous run of daily timelines with a shared
   * arcId so they can later be recalled together as one narrative arc.
   * Returns the number of timelines assigned to the arc.
   */
  async closeArc(
    agentId: string,
    arcId: string,
    range: { from: string; to: string },
  ): Promise<{ arcId: string; timelinesLinked: number }> {
    const from = this.parseDate(range.from);
    const to = this.parseDate(range.to);
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('`from` must be on or before `to`');
    }

    const { count } = await this.prisma.timeline.updateMany({
      where: {
        agentId,
        agentLocalDate: { gte: from, lte: to },
      },
      data: { arcId },
    });

    return { arcId, timelinesLinked: count };
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
