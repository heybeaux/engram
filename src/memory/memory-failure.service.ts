import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import {
  FindFailuresDto,
  FindFailuresResultDto,
} from './dto/find-failures.dto';
import { MemoryWithExtraction } from './memory.types';
import { toValidatedVectorLiteral } from './vector-literal.util';

@Injectable()
export class MemoryFailureService {
  private readonly logger = new Logger(MemoryFailureService.name);

  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
  ) {}

  /**
   * ENG-116: Find memories about past failures related to a given goal/task.
   * Embeds the goal text, queries pgvector for semantically similar memories,
   * and filters for failure indicators (keywords or metadata).
   */
  async findFailures(
    userId: string | string[] | null,
    dto: FindFailuresDto,
  ): Promise<FindFailuresResultDto> {
    const startTime = Date.now();
    const limit = dto.limit ?? 10;
    const minSimilarity = dto.minSimilarity ?? 0.7;

    // 1. Generate embedding for the goal text
    const goalEmbedding = await this.embedding.generateForRecall(dto.goal);

    // 2. Build failure keywords list
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

    // 3. Build user ID filter
    const userIds =
      userId === null ? null : Array.isArray(userId) ? userId : [userId];

    // 4. Query: semantic similarity + failure keyword/metadata filter
    //    We use $queryRawUnsafe to combine pgvector cosine distance with ILIKE filtering.
    const embeddingLiteral = toValidatedVectorLiteral(
      goalEmbedding,
      'MemoryFailureService.findFailures',
    );

    // Build the ILIKE ANY array literal for Postgres
    const patternsLiteral = `{${allPatterns.map((p) => `"${p}"`).join(',')}}`;

    let query: string;
    const params: any[] = [];
    const paramIdx = 1;

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
      params.push(
        embeddingLiteral,
        userIds,
        dto.agentId,
        patternsLiteral,
        minSimilarity,
        limit,
      );
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
      params.push(
        embeddingLiteral,
        userIds,
        patternsLiteral,
        minSimilarity,
        limit,
      );
    } else {
      // No userId filter (account-wide)
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

  async attachChains(
    memories: MemoryWithExtraction[],
    maxDepth: number = 3,
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

    // Build chain map per memory
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
