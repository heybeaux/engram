import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  FindContradictionsDto,
  FindContradictionsResult,
  ContradictionResult,
} from './dto/find-contradictions.dto';
import {
  TraceTimelineDto,
  TraceTimelineResponse,
  TimelineEntry,
} from './dto/trace-timeline.dto';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import {
  FindFailuresDto,
  FindFailuresResultDto,
} from './dto/find-failures.dto';
import { MemoryWithExtraction } from './memory.types';

/**
 * Specialized query operations: failure retrieval, contradiction detection,
 * timeline tracing, and chain attachment.
 *
 * Extracted from MemoryQueryService to keep each file under 500 lines.
 */
@Injectable()
export class MemoryQuerySpecializedService {
  private readonly logger = new Logger(MemoryQuerySpecializedService.name);

  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
  ) {}

  /**
   * ENG-116: Find memories about past failures related to a given goal/task.
   */
  async findFailures(
    userId: string | string[] | null,
    dto: FindFailuresDto,
  ): Promise<FindFailuresResultDto> {
    const startTime = Date.now();
    const limit = dto.limit ?? 10;
    const minSimilarity = dto.minSimilarity ?? 0.7;

    const goalEmbedding = await this.embedding.generateForRecall(dto.goal);

    const defaultKeywords = [
      '%fail%',
      '%error%',
      '%broke%',
      '%bug%',
      '%crash%',
      '%wrong%',
      '%issue%',
      '%problem%',
    ];
    const extraPatterns = (dto.extraKeywords ?? []).map((k) => `%${k}%`);
    const allPatterns = [...defaultKeywords, ...extraPatterns];

    const userIds =
      userId === null
        ? null
        : Array.isArray(userId)
          ? userId
          : [userId];

    const embeddingLiteral = `[${goalEmbedding.join(',')}]`;
    const patternsLiteral = `{${allPatterns.map((p) => `"${p}"`).join(',')}}`;

    let query: string;
    const params: any[] = [];
    let paramIdx = 1;

    if (userIds && dto.agentId) {
      query = `
        SELECT m.id, m.raw, m.layer, m.created_at, m.metadata, m.tags,
               1 - (me.embedding <=> $${paramIdx}::vector) as similarity
        FROM memories m
        JOIN memory_embeddings me ON me.memory_id = m.id
        WHERE m.user_id = ANY($${paramIdx + 1}::text[])
          AND m.agent_id = $${paramIdx + 2}
          AND m.searchable IS NOT FALSE
          AND m.deleted_at IS NULL
          AND m.superseded_by_id IS NULL
          AND (m.raw ILIKE ANY($${paramIdx + 3}::text[])
               OR m.metadata @> '{"outcome": "failure"}'::jsonb)
          AND 1 - (me.embedding <=> $${paramIdx}::vector) > $${paramIdx + 4}
        ORDER BY similarity DESC
        LIMIT $${paramIdx + 5}`;
      params.push(embeddingLiteral, userIds, dto.agentId, patternsLiteral, minSimilarity, limit);
    } else if (userIds) {
      query = `
        SELECT m.id, m.raw, m.layer, m.created_at, m.metadata, m.tags,
               1 - (me.embedding <=> $${paramIdx}::vector) as similarity
        FROM memories m
        JOIN memory_embeddings me ON me.memory_id = m.id
        WHERE m.user_id = ANY($${paramIdx + 1}::text[])
          AND m.searchable IS NOT FALSE
          AND m.deleted_at IS NULL
          AND m.superseded_by_id IS NULL
          AND (m.raw ILIKE ANY($${paramIdx + 2}::text[])
               OR m.metadata @> '{"outcome": "failure"}'::jsonb)
          AND 1 - (me.embedding <=> $${paramIdx}::vector) > $${paramIdx + 3}
        ORDER BY similarity DESC
        LIMIT $${paramIdx + 4}`;
      params.push(embeddingLiteral, userIds, patternsLiteral, minSimilarity, limit);
    } else {
      query = `
        SELECT m.id, m.raw, m.layer, m.created_at, m.metadata, m.tags,
               1 - (me.embedding <=> $${paramIdx}::vector) as similarity
        FROM memories m
        JOIN memory_embeddings me ON me.memory_id = m.id
        WHERE m.searchable IS NOT FALSE
          AND m.deleted_at IS NULL
          AND m.superseded_by_id IS NULL
          AND (m.raw ILIKE ANY($${paramIdx + 1}::text[])
               OR m.metadata @> '{"outcome": "failure"}'::jsonb)
          AND 1 - (me.embedding <=> $${paramIdx}::vector) > $${paramIdx + 2}
        ORDER BY similarity DESC
        LIMIT $${paramIdx + 3}`;
      params.push(embeddingLiteral, patternsLiteral, minSimilarity, limit);
    }

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        raw: string;
        layer: string;
        created_at: Date;
        metadata: any;
        tags: string[];
        similarity: number;
      }>
    >(query, ...params);

    const failures = rows.map((row) => ({
      id: row.id,
      raw: row.raw,
      layer: row.layer,
      similarity: Number(row.similarity),
      createdAt: row.created_at,
      metadata: row.metadata,
      tags: row.tags,
    }));

    return {
      failures,
      total: failures.length,
      goal: dto.goal,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Find memories that potentially contradict a given fact or insight.
   */
  async findContradictions(
    userId: string | string[] | null,
    dto: FindContradictionsDto,
  ): Promise<FindContradictionsResult> {
    const startTime = Date.now();

    if (!dto.memoryId && !dto.text) {
      throw new BadRequestException('Either memoryId or text must be provided');
    }

    const threshold = dto.threshold ?? 0.8;
    const limit = dto.limit ?? 10;

    let sourceEmbedding: number[];
    let sourceText: string;
    let sourceId: string | null = null;

    if (dto.memoryId) {
      const source = await this.prisma.memory.findUnique({
        where: { id: dto.memoryId },
        select: { id: true, raw: true, userId: true },
      });

      if (!source) {
        throw new NotFoundException(`Memory ${dto.memoryId} not found`);
      }

      sourceId = source.id;
      sourceText = source.raw;

      const embeddingRows = await this.prisma.$queryRawUnsafe<
        Array<{ embedding: string }>
      >(
        `SELECT embedding::text FROM memories WHERE id = $1 AND embedding IS NOT NULL`,
        dto.memoryId,
      );

      if (embeddingRows.length > 0 && embeddingRows[0].embedding) {
        sourceEmbedding = JSON.parse(embeddingRows[0].embedding);
      } else {
        sourceEmbedding = await this.embedding.generateForRecall(source.raw);
      }
    } else {
      sourceText = dto.text!;
      sourceEmbedding = await this.embedding.generateForRecall(dto.text!);
    }

    const conditions: string[] = [
      'm.embedding IS NOT NULL',
      'm.deleted_at IS NULL',
      'm.searchable = true',
      `m.memory_type IN ('FACT', 'PREFERENCE', 'CONSTRAINT', 'LESSON')`,
    ];
    const params: any[] = [`[${sourceEmbedding.join(',')}]`];
    let paramIdx = 2;

    if (sourceId) {
      conditions.push(`m.id != $${paramIdx}`);
      params.push(sourceId);
      paramIdx++;
    }

    if (dto.agentId) {
      conditions.push(`m.agent_id = $${paramIdx}`);
      params.push(dto.agentId);
      paramIdx++;
    }

    if (userId !== null) {
      if (Array.isArray(userId)) {
        conditions.push(`m.user_id = ANY($${paramIdx})`);
        params.push(userId);
      } else {
        conditions.push(`m.user_id = $${paramIdx}`);
        params.push(userId);
      }
      paramIdx++;
    }

    conditions.push(`1 - (m.embedding <=> $1::vector) > $${paramIdx}`);
    params.push(threshold);
    paramIdx++;

    const whereClause = conditions.join(' AND ');

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        raw: string;
        memory_type: string | null;
        importance_score: number;
        similarity: number;
        created_at: Date;
      }>
    >(
      `SELECT m.id, m.raw, m.memory_type, m.importance_score,
              1 - (m.embedding <=> $1::vector) as similarity,
              m.created_at
       FROM memories m
       WHERE ${whereClause}
       ORDER BY similarity DESC
       LIMIT $${paramIdx}`,
      ...params,
      limit,
    );

    const contradictions: ContradictionResult[] = rows.map((r) => ({
      id: r.id,
      raw: r.raw,
      memoryType: r.memory_type,
      importanceScore: Number(r.importance_score),
      similarity: Number(r.similarity),
      createdAt: r.created_at,
    }));

    return {
      sourceId,
      sourceText,
      contradictions,
      total: contradictions.length,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Trace a topic's memory timeline within a date range.
   */
  async traceTimeline(
    agentId: string,
    dto: TraceTimelineDto,
  ): Promise<TraceTimelineResponse> {
    const { topic, startDate, endDate, limit = 100 } = dto;
    const start = new Date(startDate);
    const end = new Date(endDate);

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        raw: string;
        memory_type: string;
        importance_score: number;
        created_at: Date;
      }>
    >(
      `SELECT id, raw, memory_type, importance_score, created_at
       FROM memories
       WHERE agent_id = $1
         AND searchable = true
         AND deleted_at IS NULL
         AND raw ILIKE '%' || $2 || '%'
         AND created_at >= $3
         AND created_at <= $4
       ORDER BY created_at ASC
       LIMIT $5`,
      agentId,
      topic,
      start,
      end,
      limit,
    );

    const entriesByDate = new Map<string, TimelineEntry>();
    for (const row of rows) {
      const dateKey = row.created_at.toISOString().split('T')[0];
      let entry = entriesByDate.get(dateKey);
      if (!entry) {
        entry = { date: dateKey, memories: [] };
        entriesByDate.set(dateKey, entry);
      }
      entry.memories.push({
        id: row.id,
        raw: row.raw,
        memoryType: row.memory_type,
        importanceScore: Number(row.importance_score),
        createdAt: row.created_at,
      });
    }

    const allDays: string[] = [];
    const current = new Date(start);
    current.setUTCHours(0, 0, 0, 0);
    const endNorm = new Date(end);
    endNorm.setUTCHours(0, 0, 0, 0);
    while (current <= endNorm) {
      allDays.push(current.toISOString().split('T')[0]);
      current.setUTCDate(current.getUTCDate() + 1);
    }

    const gaps = allDays.filter((day) => !entriesByDate.has(day));
    const daysWithMemories = allDays.length - gaps.length;
    const coverage =
      allDays.length > 0
        ? Math.round((daysWithMemories / allDays.length) * 10000) / 100
        : 0;

    const entries = Array.from(entriesByDate.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );

    return {
      topic,
      range: {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0],
      },
      totalMemories: rows.length,
      entries,
      gaps,
      coverage,
    };
  }

  /**
   * Attach chain links to a set of memories.
   */
  async attachChains(
    memories: MemoryWithExtraction[],
  ): Promise<MemoryWithExtraction[]> {
    const memoryIds = memories.map((m) => m.id);
    if (memoryIds.length === 0) return memories;

    const chainLinks = await this.prisma.memoryChainLink.findMany({
      where: {
        OR: [{ sourceId: { in: memoryIds } }, { targetId: { in: memoryIds } }],
      },
      include: {
        source: true,
        target: true,
      },
    });

    if (chainLinks.length === 0) return memories;

    const chainMap = new Map<
      string,
      Array<{ memory: any; linkType: string; confidence: number }>
    >();

    for (const link of chainLinks) {
      for (const memoryId of memoryIds) {
        if (link.sourceId === memoryId) {
          const arr = chainMap.get(memoryId) ?? [];
          arr.push({
            memory: link.target,
            linkType: link.linkType,
            confidence: link.confidence,
          });
          chainMap.set(memoryId, arr);
        }
        if (link.targetId === memoryId) {
          const arr = chainMap.get(memoryId) ?? [];
          arr.push({
            memory: link.source,
            linkType: link.linkType,
            confidence: link.confidence,
          });
          chainMap.set(memoryId, arr);
        }
      }
    }

    return memories.map((m) => ({
      ...m,
      chainedMemories: chainMap.get(m.id) ?? [],
    }));
  }
}
