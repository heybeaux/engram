import { Injectable, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { TemporalParserService } from './temporal/temporal-parser.service';
import { QueryMemoryDto, LoadContextDto } from './dto/query-memory.dto';
import { MultiQueryService } from '../multi-query/multi-query.service';
import { MemoryPoolService } from '../memory-pool/memory-pool.service';
import { MemoryAccessLogService } from '../memory-access-log/memory-access-log.service';
import {
  AnticipatoryService,
} from '../anticipatory/anticipatory.service';
import { ResultExplanationDto } from '../multi-query/dto/multi-query.dto';
import { Memory, MemoryLayer, SubjectType } from '@prisma/client';
import {
  MemoryWithExtraction,
  MemoryWithScore,
  QueryResult,
  ContextResult,
} from './memory.types';
import { MemoryQueryContextService } from './memory-query-context.service';

@Injectable()
export class MemoryQueryService {
  private readonly logger = new Logger(MemoryQueryService.name);
  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
    private temporalParser: TemporalParserService,
    private contextService: MemoryQueryContextService,
    @Optional() private multiQueryService?: MultiQueryService,
    @Optional() private memoryPoolService?: MemoryPoolService,
    @Optional() private memoryAccessLogService?: MemoryAccessLogService,
    @Optional() private anticipatoryService?: AnticipatoryService,
  ) {}

  /**
   * Semantic search for memories
   */
  async recall(
    userId: string | string[],
    dto: QueryMemoryDto,
  ): Promise<QueryResult> {
    const startTime = Date.now();
    // Normalize userId for Prisma where clauses
    const userIdFilter = Array.isArray(userId) ? { in: userId } : userId;

    // v0.9: Use explicit poolIds if provided, otherwise resolve from agentSessionKey
    let poolIds: string[] | undefined = dto.poolIds;
    const singleUserId = Array.isArray(userId) ? userId[0] : userId;
    if (!poolIds && dto.agentSessionKey && this.memoryPoolService) {
      try {
        poolIds = await this.memoryPoolService.getAccessiblePoolIds(
          dto.agentSessionKey,
          singleUserId,
        );
      } catch (err) {
        this.logger.warn(
          '[Recall] Failed to resolve pool IDs, proceeding without pool filter:',
          err,
        );
      }
    }

    const useMultiQuery = this.shouldUseMultiQuery(dto);

    if (useMultiQuery) {
      return this.recallWithMultiQuery(userId, dto, startTime, poolIds);
    }

    // 1. Parse temporal intent from query
    const now = new Date();
    const parsed = this.temporalParser.parse(dto.query, now);
    const hasTemporalIntent = parsed.temporalFilter !== null;
    const searchQuery = parsed.semanticQuery;

    if (hasTemporalIntent) {
      this.logger.log('[Recall] Temporal intent detected:', {
        expression: parsed.temporalFilter!.expression,
        start: parsed.temporalFilter!.start.toISOString(),
        end: parsed.temporalFilter!.end.toISOString(),
        semanticQuery: searchQuery,
      });
    }

    // 2. Generate query embedding
    const queryEmbedding = await this.embedding.generate(searchQuery);

    const subjectTypeFilter = this.buildSubjectTypeFilter(dto);
    const visibilityFilter = this.buildVisibilityFilter(dto);
    const limit = dto.limit ?? 10;

    let scoredMemories: MemoryWithScore[];

    if (hasTemporalIntent) {
      // TEMPORAL PATH
      const temporalMemories = await this.prisma.memory.findMany({
        where: {
          userId: userIdFilter,
          deletedAt: null,
          supersededById: null,
          createdAt: {
            gte: parsed.temporalFilter!.start,
            lte: parsed.temporalFilter!.end,
          },
          ...subjectTypeFilter,
          ...visibilityFilter,
        },
        include: { extraction: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });

      this.logger.log(
        '[Recall] Temporal path: found',
        temporalMemories.length,
        'memories in range',
      );

      const vectorResults = await this.embedding.search(
        userId,
        queryEmbedding,
        200,
        dto.layers as any,
        undefined,
        poolIds,
      );
      const scoreMap = new Map(vectorResults.map((r) => [r.id, r.score]));

      scoredMemories = temporalMemories
        .map((memory) => {
          const semanticScore = scoreMap.get(memory.id) ?? 0.1;
          const temporalScore = this.temporalParser.calculateTemporalRelevance(
            memory.createdAt,
            parsed.temporalFilter,
          );
          const importanceScore =
            memory.effectiveScore ?? memory.importanceScore;

          const blendedScore = this.temporalParser.blendScores(
            semanticScore,
            temporalScore,
            importanceScore,
            true,
          );

          return { ...memory, score: blendedScore } as MemoryWithScore;
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit);
    } else {
      // STANDARD PATH
      const vectorResults = await this.embedding.search(
        userId,
        queryEmbedding,
        limit,
        dto.layers as any,
        undefined,
        poolIds,
      );

      const scoreMap = new Map(vectorResults.map((r) => [r.id, r.score]));
      const memoryIds = vectorResults.map((r) => r.id);

      const memories = await this.prisma.memory.findMany({
        where: {
          id: { in: memoryIds },
          deletedAt: null,
          supersededById: null,
          ...subjectTypeFilter,
          ...visibilityFilter,
        },
        include: { extraction: true },
      });

      scoredMemories = memories
        .map((memory) => {
          const semanticScore = scoreMap.get(memory.id) ?? 0;
          const importanceScore =
            memory.effectiveScore ?? memory.importanceScore;
          const blendedScore = this.temporalParser.blendScores(
            semanticScore,
            0.5,
            importanceScore,
            false,
          );

          return { ...memory, score: blendedScore } as MemoryWithScore;
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }

    // ── Active Insight Surfacing ──────────────────────────────────────
    scoredMemories = await this.surfaceInsights(
      scoredMemories,
      Array.isArray(userId) ? userId : [userId],
      searchQuery,
      limit,
      queryEmbedding,
    );

    let result: MemoryWithScore[] = scoredMemories;
    if (dto.includeChains) {
      result = (await this.contextService.attachChains(
        scoredMemories,
      )) as MemoryWithScore[];
    }

    const resultIds = result.map((m) => m.id);
    if (resultIds.length > 0) {
      try {
        await this.prisma.memory.updateMany({
          where: { id: { in: resultIds } },
          data: {
            retrievalCount: { increment: 1 },
            lastRetrievedAt: new Date(),
          },
        });
      } catch (updateError) {
        this.logger.warn(
          '[Recall] Failed to update retrieval counts:',
          updateError?.message,
        );
      }

      if (dto.agentSessionKey && this.memoryAccessLogService) {
        this.memoryAccessLogService
          .logRecalled(resultIds, dto.agentSessionKey, dto.query)
          .catch(() => {});
      }
    }

    // v1.6: Anticipatory Recall
    let anticipatoryMeta:
      | import('../anticipatory/dto/anticipatory.dto').AnticipatoryMeta
      | undefined;
    if (dto.anticipatory?.enabled && this.anticipatoryService) {
      try {
        const excludeIds = new Set(result.map((m) => m.id));
        const areResult = await this.anticipatoryService.run(
          dto.query,
          singleUserId,
          excludeIds,
          dto.anticipatory,
        );
        if (areResult.memories.length > 0) {
          result.push(...areResult.memories);
        }
        anticipatoryMeta = areResult.meta;
      } catch (err) {
        this.logger.warn(
          `Anticipatory recall failed: ${(err as Error).message}`,
        );
      }
    }

    return {
      memories: result,
      queryTokens: dto.query.split(/\s+/).length,
      latencyMs: Date.now() - startTime,
      ...(anticipatoryMeta ? { anticipatoryMeta } : {}),
    };
  }

  /**
   * Check if multi-query retrieval should be used
   */
  shouldUseMultiQuery(dto: QueryMemoryDto): boolean {
    if (!this.multiQueryService) return false;
    if (dto.multiQuery?.enabled === false) return false;
    if (dto.multiQuery?.enabled === true) return true;
    return this.multiQueryService.isEnabled();
  }

  /**
   * Surface relevant INSIGHT memories by injecting them into recall results.
   */
  private async surfaceInsights(
    existingResults: MemoryWithScore[],
    userIds: string[],
    query: string,
    limit: number,
    cachedQueryEmbedding?: number[],
  ): Promise<MemoryWithScore[]> {
    try {
      const insights = await this.prisma.memory.findMany({
        where: {
          userId: { in: userIds },
          layer: 'INSIGHT',
          deletedAt: null,
          importanceScore: { gte: 0.6 },
          createdAt: { gt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
        },
        include: { extraction: true },
        orderBy: { importanceScore: 'desc' },
        take: 5,
      });

      if (insights.length === 0) return existingResults;

      const queryEmbedding =
        cachedQueryEmbedding ?? (await this.embedding.generate(query));

      const insightIds = new Set(insights.map((i) => i.id));
      const insightScoreMap = new Map<string, number>();

      const vectorResults = await this.embedding.search(
        userIds,
        queryEmbedding,
        50,
        ['INSIGHT' as MemoryLayer],
      );
      for (const r of vectorResults) {
        if (insightIds.has(r.id)) {
          insightScoreMap.set(r.id, r.score);
        }
      }

      const relevantInsights: MemoryWithScore[] = [];
      const existingIds = new Set(existingResults.map((r) => r.id));

      for (const insight of insights) {
        if (existingIds.has(insight.id)) continue;

        const similarity = insightScoreMap.get(insight.id);
        if (similarity === undefined) continue;

        if (similarity > 0.3) {
          const boostedScore = similarity + insight.importanceScore * 0.3;
          relevantInsights.push({
            ...insight,
            score: boostedScore,
          } as MemoryWithScore);
        }
      }

      if (relevantInsights.length === 0) return existingResults;

      const merged = [...existingResults, ...relevantInsights]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit);

      this.logger.log(
        `[Recall] Surfaced ${relevantInsights.length} INSIGHT memories (of ${insights.length} candidates)`,
      );

      return merged;
    } catch (error) {
      this.logger.warn(
        `[Recall] Insight surfacing failed, skipping: ${(error as Error)?.message || error}`,
        (error as Error)?.stack,
      );
      return existingResults;
    }
  }

  /**
   * Perform recall using multi-query retrieval
   */
  private async recallWithMultiQuery(
    userId: string | string[],
    dto: QueryMemoryDto,
    startTime: number,
    poolIds?: string[],
  ): Promise<QueryResult> {
    const now = new Date();
    const parsed = this.temporalParser.parse(dto.query, now);
    const hasTemporalIntent = parsed.temporalFilter !== null;

    if (hasTemporalIntent) {
      this.logger.log(
        '[Recall] Temporal intent detected, falling back to standard search',
      );
      const dtoWithoutMultiQuery = { ...dto, multiQuery: { enabled: false } };
      return this.recall(userId, dtoWithoutMultiQuery);
    }

    const multiQueryResult = await this.multiQueryService!.search(
      dto.query,
      userId,
      {
        topK: dto.limit ?? 10,
        layers: dto.layers as any,
        projectId: dto.projectId,
        multiQuery: dto.multiQuery,
        poolIds,
      },
    );

    const memoryIds = multiQueryResult.results.map((r) => r.memoryId);
    const subjectTypeFilter = this.buildSubjectTypeFilter(dto);
    const visibilityFilterMQ = this.buildVisibilityFilter(dto);

    const memories = await this.prisma.memory.findMany({
      where: {
        id: { in: memoryIds },
        deletedAt: null,
        supersededById: null,
        ...subjectTypeFilter,
        ...visibilityFilterMQ,
      },
      include: { extraction: true },
    });

    const scoreMap = new Map(
      multiQueryResult.results.map((r) => [r.memoryId, r.score]),
    );

    const scoredMemories: MemoryWithScore[] = memories
      .map((memory) => {
        const multiQueryScore = scoreMap.get(memory.id) ?? 0;
        const importanceScore = memory.effectiveScore ?? memory.importanceScore;
        const blendedScore = multiQueryScore * 0.8 + importanceScore * 0.2;

        return { ...memory, score: blendedScore } as MemoryWithScore;
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    let result: MemoryWithScore[] = scoredMemories;
    if (dto.includeChains) {
      result = (await this.contextService.attachChains(
        scoredMemories,
      )) as MemoryWithScore[];
    }

    const resultIds = result.map((m) => m.id);
    if (resultIds.length > 0) {
      try {
        await this.prisma.memory.updateMany({
          where: { id: { in: resultIds } },
          data: {
            retrievalCount: { increment: 1 },
            lastRetrievedAt: new Date(),
          },
        });
      } catch (updateError) {
        this.logger.warn(
          '[Recall] Failed to update retrieval counts:',
          updateError?.message,
        );
      }

      if (dto.agentSessionKey && this.memoryAccessLogService) {
        this.memoryAccessLogService
          .logRecalled(resultIds, dto.agentSessionKey, dto.query)
          .catch(() => {});
      }
    }

    const multiQueryMetadata = this.multiQueryService!.generateMetadata(
      multiQueryResult,
      dto.multiQuery,
    );

    let explanations: Record<string, ResultExplanationDto> | undefined;
    if (dto.multiQuery?.includeExplanations) {
      explanations = this.multiQueryService!.generateExplanations(
        multiQueryResult.results,
        multiQueryResult.expansion,
      );
    }

    // v1.6: Anticipatory Recall
    let anticipatoryMeta2:
      | import('../anticipatory/dto/anticipatory.dto').AnticipatoryMeta
      | undefined;
    if (dto.anticipatory?.enabled && this.anticipatoryService) {
      try {
        const excludeIds = new Set(result.map((m) => m.id));
        const areResult = await this.anticipatoryService.run(
          dto.query,
          Array.isArray(userId) ? userId[0] : userId,
          excludeIds,
          dto.anticipatory,
        );
        if (areResult.memories.length > 0) {
          result.push(...areResult.memories);
        }
        anticipatoryMeta2 = areResult.meta;
      } catch (err) {
        this.logger.warn(
          `Anticipatory recall failed: ${(err as Error).message}`,
        );
      }
    }

    return {
      memories: result,
      queryTokens: dto.query.split(/\s+/).length,
      latencyMs: Date.now() - startTime,
      multiQuery: multiQueryMetadata,
      explanations,
      ...(anticipatoryMeta2 ? { anticipatoryMeta: anticipatoryMeta2 } : {}),
    };
  }

  /**
   * Load context for session start — delegates to MemoryQueryContextService
   */
  async loadContext(
    userId: string,
    dto: LoadContextDto,
  ): Promise<ContextResult> {
    return this.contextService.loadContext(userId, dto);
  }

  /**
   * Select memories that fit within a token budget — delegates to MemoryQueryContextService
   */
  selectMemoriesForBudget(
    candidates: Memory[],
    budget: number,
    constraintReserve: number,
  ): { selected: Memory[]; evicted: Memory[] } {
    return this.contextService.selectMemoriesForBudget(
      candidates,
      budget,
      constraintReserve,
    );
  }

  /**
   * Build visibility filter for cross-agent memory sharing.
   */
  buildVisibilityFilter(dto: QueryMemoryDto): Record<string, any> {
    if (dto.visibility && dto.visibility.length > 0) {
      return { visibility: { in: dto.visibility } };
    }
    return {};
  }

  /**
   * Build subject type filter for queries
   */
  buildSubjectTypeFilter(dto: QueryMemoryDto): Record<string, any> {
    const filter: Record<string, any> = {};

    if (dto.subjectType) {
      filter.subjectType = dto.subjectType;
    }

    if (dto.agentId) {
      filter.agentId = dto.agentId;
    }

    if (
      dto.includeUserMemories === false &&
      dto.includeAgentMemories === false
    ) {
      filter.subjectType = 'IMPOSSIBLE' as any;
    } else if (dto.includeUserMemories === false) {
      filter.subjectType = SubjectType.AGENT;
    } else if (dto.includeAgentMemories === false) {
      filter.subjectType = SubjectType.USER;
    }

    return filter;
  }

  /**
   * Format context — delegates to MemoryQueryContextService
   */
  formatContext(
    memories: Memory[],
    maxTokens: number,
  ): { text: string; tokens: number } {
    return this.contextService.formatContext(memories, maxTokens);
  }
}
