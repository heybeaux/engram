import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Optional,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import {
  TraceTimelineDto,
  TraceTimelineResponse,
  TimelineEntry,
} from './dto/trace-timeline.dto';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { TemporalParserService } from './temporal/temporal-parser.service';
import { QueryMemoryDto, LoadContextDto } from './dto/query-memory.dto';
import { MultiQueryService } from '../multi-query/multi-query.service';
import { MemoryPoolService } from '../memory-pool/memory-pool.service';
import { MemoryAccessLogService } from '../memory-access-log/memory-access-log.service';
import { QueryLogService } from '../memory-access-log/query-log.service';
import {
  AnticipatoryService,
  AnticipatoryRunResult,
} from '../anticipatory/anticipatory.service';
import {
  MultiQueryMetadataDto,
  ResultExplanationDto,
} from '../multi-query/dto/multi-query.dto';
import { Memory, MemoryLayer, SubjectType } from '@prisma/client';
import {
  MemoryWithExtraction,
  MemoryWithScore,
  QueryResult,
  ContextResult,
} from './memory.types';
import { RecallWeightService } from './recall-weight.service';
import { MemoryQueryRankingService } from './memory-query-ranking.service';
import { MemoryQueryContextService } from './memory-query-context.service';
import { MemoryFailureService } from './memory-failure.service';

@Injectable()
export class MemoryQueryService {
  private readonly logger = new Logger(MemoryQueryService.name);
  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
    private temporalParser: TemporalParserService,
    private recallWeightService: RecallWeightService,
    private rankingService: MemoryQueryRankingService,
    private contextService: MemoryQueryContextService,
    @Optional() private multiQueryService?: MultiQueryService,
    @Optional() private memoryPoolService?: MemoryPoolService,
    @Optional() private memoryAccessLogService?: MemoryAccessLogService,
    @Optional() private anticipatoryService?: AnticipatoryService,
    @Optional() private queryLogService?: QueryLogService,
    @Optional() private memoryFailureService?: MemoryFailureService,
  ) {}

  /**
   * Semantic search for memories
   */
  async recall(
    userId: string | string[] | null,
    dto: QueryMemoryDto,
  ): Promise<QueryResult> {
    const startTime = Date.now();

    // ENG-48: Reject timeline type until Phase 1 timeline table lands
    if (dto.type === 'timeline') {
      throw new BadRequestException(
        'type="timeline" is not yet supported. Timeline queries will be available in a future release.',
      );
    }

    // ENG-109: Normalize userId for Prisma where clauses.
    // If null (no X-AM-User-ID header), omit filter to query all account users.
    const userIdFilter =
      userId === null
        ? undefined
        : Array.isArray(userId)
          ? { in: userId }
          : userId;

    // v0.9: Use explicit poolIds if provided, otherwise resolve from agentSessionKey
    let poolIds: string[] | undefined = dto.poolIds;
    const singleUserId = Array.isArray(userId)
      ? userId[0]
      : (userId ?? undefined);
    if (!poolIds && dto.agentSessionKey && this.memoryPoolService) {
      try {
        poolIds = await this.memoryPoolService.getAccessiblePoolIds(
          dto.agentSessionKey,
          singleUserId ?? 'default',
          dto.agentId,
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

    // 2. Generate query embedding (priority path — skips batch queue)
    const queryEmbedding = await this.embedding.generateForRecall(searchQuery);

    const subjectTypeFilter = this.buildSubjectTypeFilter(dto);
    const visibilityFilter = this.buildVisibilityFilter(dto);
    const metadataFilter = this.buildMetadataFilter(dto);
    const limit = dto.limit ?? 10;

    // ENG-42: Extract filter params for vector search
    // ENG-48: Merge arc tag into filterTags
    let filterTags = dto.filter?.tags ? [...dto.filter.tags] : undefined;
    if (dto.arc) {
      filterTags = filterTags ? [...filterTags, dto.arc] : [dto.arc];
    }
    const filterMetadata = dto.filter?.metadata;

    // ENG-48: Build temporal range filter from explicit after/before params
    const temporalRangeFilter = this.buildTemporalRangeFilter(dto);

    let scoredMemories: MemoryWithScore[];

    if (hasTemporalIntent) {
      // TEMPORAL PATH
      // ENG-48: Merge explicit after/before with temporal parser range
      const temporalCreatedAt: Record<string, any> = {
        gte: parsed.temporalFilter!.start,
        lte: parsed.temporalFilter!.end,
      };
      if (dto.after) {
        const afterDate = new Date(dto.after);
        if (afterDate > temporalCreatedAt.gte)
          temporalCreatedAt.gte = afterDate;
      }
      if (dto.before) {
        const beforeDate = new Date(dto.before);
        if (beforeDate < temporalCreatedAt.lte)
          temporalCreatedAt.lte = beforeDate;
      }

      const temporalMemories = await this.prisma.memory.findMany({
        where: {
          userId: userIdFilter,
          deletedAt: null,
          supersededById: null,
          searchable: { not: false },
          createdAt: temporalCreatedAt,
          ...subjectTypeFilter,
          ...visibilityFilter,
          ...metadataFilter,
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
        userId ?? 'default',
        queryEmbedding,
        200,
        dto.layers as any,
        undefined,
        poolIds,
        searchQuery,
        filterTags,
        filterMetadata,
      );
      const scoreMap = new Map(vectorResults.map((r) => [r.id, r.score]));

      // Pass 120 candidates to the reranker (not just `limit`=20).
      // The reranker needs a wide pool to surface the best temporal match.
      const TEMPORAL_RERANK_POOL = 120;
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

          const adjustedScore =
            blendedScore *
            this.recallWeightService.recallWeight(memory) *
            this.rankingService.getImportanceMultiplier(memory);
          return { ...memory, score: adjustedScore } as MemoryWithScore;
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, TEMPORAL_RERANK_POOL); // wide pool — reranker will final-sort to `limit`
    } else {
      // STANDARD PATH (ENG-26: pass query text for hybrid search fusion)
      const candidateLimit = Math.max(200, limit * 20);
      const vectorResults = await this.embedding.search(
        userId ?? 'default',
        queryEmbedding,
        candidateLimit,
        dto.layers as any,
        undefined,
        poolIds,
        searchQuery,
        filterTags,
        filterMetadata,
      );

      const scoreMap = new Map(vectorResults.map((r) => [r.id, r.score]));
      const memoryIds = vectorResults.map((r) => r.id);

      // BM25/tsvector hybrid: safety net for exact-keyword queries
      // Skip inline FTS when in pool-only mode (poolIds set, no userId) — pool JOIN is the auth boundary
      const ftsResultIds = new Set<string>();
      const skipFts = poolIds && poolIds.length > 0 && !singleUserId;
      try {
        // ENG-109: When no userId, omit user_id filter to search all account memories
        const ftsResults = skipFts
          ? []
          : singleUserId
            ? await this.prisma.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id FROM memories
               WHERE user_id = $1
                 AND to_tsvector('english', raw) @@ websearch_to_tsquery('english', $2)
                 AND deleted_at IS NULL
                 AND superseded_by_id IS NULL
                 AND searchable IS NOT FALSE
               ORDER BY ts_rank(to_tsvector('english', raw), websearch_to_tsquery('english', $2)) DESC
               LIMIT 100`,
                singleUserId ?? 'default',
                searchQuery,
              )
            : await this.prisma.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id FROM memories
               WHERE to_tsvector('english', raw) @@ websearch_to_tsquery('english', $1)
                 AND deleted_at IS NULL
                 AND superseded_by_id IS NULL
                 AND searchable IS NOT FALSE
               ORDER BY ts_rank(to_tsvector('english', raw), websearch_to_tsquery('english', $1)) DESC
               LIMIT 100`,
                searchQuery,
              );
        let ftsAdded = 0;
        for (const row of ftsResults) {
          ftsResultIds.add(row.id);
          if (!scoreMap.has(row.id)) {
            scoreMap.set(row.id, 0.75);
            memoryIds.push(row.id);
            ftsAdded++;
          } else {
            scoreMap.set(row.id, Math.max(scoreMap.get(row.id)!, 0.75));
          }
        }
        if (ftsAdded > 0) {
          this.logger.debug(
            `[Recall] BM25 hybrid: injected ${ftsAdded} FTS-only candidates`,
          );
        }

        // ILIKE fallback
        if (ftsResults.length === 0) {
          const words = searchQuery
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length >= 4);
          if (words.length > 0) {
            try {
              // ENG-109: Adjust parameter indices when no userId
              const paramOffset = singleUserId ? 2 : 1;
              const ilikeConditions = words
                .map((_, i) => `LOWER(raw) LIKE $${i + paramOffset}`)
                .join(' OR ');
              const ilikeParams = words.map((w) => `%${w}%`);
              const ilikeResults = singleUserId
                ? await this.prisma.$queryRawUnsafe<{ id: string }[]>(
                    `SELECT id FROM memories
                     WHERE user_id = $1
                       AND (${ilikeConditions})
                       AND deleted_at IS NULL
                       AND superseded_by_id IS NULL
                       AND searchable IS NOT FALSE
                     LIMIT 20`,
                    singleUserId ?? 'default',
                    ...ilikeParams,
                  )
                : await this.prisma.$queryRawUnsafe<{ id: string }[]>(
                    `SELECT id FROM memories
                     WHERE (${ilikeConditions})
                       AND deleted_at IS NULL
                       AND superseded_by_id IS NULL
                       AND searchable IS NOT FALSE
                     LIMIT 20`,
                    ...ilikeParams,
                  );
              let ilikeAdded = 0;
              for (const row of ilikeResults) {
                ftsResultIds.add(row.id);
                if (!scoreMap.has(row.id)) {
                  scoreMap.set(row.id, 0.7);
                  memoryIds.push(row.id);
                  ilikeAdded++;
                } else {
                  scoreMap.set(row.id, Math.max(scoreMap.get(row.id)!, 0.7));
                }
              }
              if (ilikeAdded > 0) {
                this.logger.debug(
                  `[Recall] ILIKE fallback: rescued ${ilikeAdded} candidates`,
                );
              }
            } catch (ilikeError) {
              this.logger.debug(
                `[Recall] ILIKE fallback skipped: ${(ilikeError as Error).message}`,
              );
            }
          }
        }
      } catch (ftsError) {
        this.logger.debug(
          `[Recall] BM25 hybrid skipped: ${(ftsError as Error).message}`,
        );
      }

      const memories = await this.prisma.memory.findMany({
        where: {
          id: { in: memoryIds },
          deletedAt: null,
          supersededById: null,
          searchable: { not: false },
          ...subjectTypeFilter,
          ...visibilityFilter,
          ...metadataFilter,
          ...temporalRangeFilter,
        },
        include: { extraction: true },
      });

      const sorted = memories
        .map((memory) => {
          const semanticScore = scoreMap.get(memory.id) ?? 0;
          return { ...memory, score: semanticScore } as MemoryWithScore;
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      const RERANK_POOL = sorted.length;

      const topIds = new Set(sorted.map((m) => m.id));
      const memoryMap = new Map(sorted.map((m) => [m.id, m]));
      const forcedFts: MemoryWithScore[] = [];
      for (const id of ftsResultIds) {
        if (!topIds.has(id)) {
          const mem = memoryMap.get(id);
          if (mem) {
            forcedFts.push({ ...mem, score: 0.75 } as MemoryWithScore);
          }
        }
      }
      this.logger.debug(
        `[Recall] Reranker pool: ${RERANK_POOL} vector + ${forcedFts.length} FTS-only = ${RERANK_POOL + forcedFts.length} total candidates`,
      );
      scoredMemories = [...sorted, ...forcedFts];
    }

    // ── ENG-27: Usage-Weighted Re-ranking ────────────────────────────
    try {
      scoredMemories =
        await this.rankingService.applyUsageWeighting(scoredMemories);
    } catch (error) {
      this.logger.warn(
        `[Recall] Usage weighting failed, proceeding without: ${(error as Error)?.message}`,
      );
    }

    // ── ENG-32: Graph Recall Merge ─────────────────────────────────────
    try {
      scoredMemories = await this.rankingService.mergeGraphResults(
        scoredMemories,
        dto.query,
        singleUserId ?? 'default',
        limit,
      );
    } catch (error) {
      this.logger.warn(
        `[Recall] Graph recall merge failed: ${(error as Error)?.message}`,
      );
    }

    // ── Active Insight Surfacing ──────────────────────────────────────
    scoredMemories = await this.rankingService.surfaceInsights(
      scoredMemories,
      Array.isArray(userId) ? userId : userId ? [userId] : [],
      searchQuery,
      limit,
      queryEmbedding,
    );

    // ── ENG-29: Cross-Encoder Reranking ──────────────────────────
    const rerankQuery = hasTemporalIntent ? dto.query : searchQuery;
    scoredMemories = await this.rankingService.applyReranking(
      scoredMemories,
      rerankQuery,
      limit,
    );

    // v1.7: Agent-scoped filter
    if (dto.filterAgentId) {
      scoredMemories = scoredMemories.filter(
        (m) => m.agentId === dto.filterAgentId,
      );
    }

    // v1.7: Agent boost
    if (dto.agentBoost && dto.agentBoost > 1.0 && dto.agentId) {
      scoredMemories = scoredMemories.map((m) => {
        if (m.agentId === dto.agentId && m.score != null) {
          return { ...m, score: m.score * dto.agentBoost! };
        }
        return m;
      });
      scoredMemories.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }

    let result: MemoryWithScore[] = scoredMemories;
    if (dto.includeChains) {
      result = ((await this.memoryFailureService?.attachChains(
        scoredMemories,
      )) ?? scoredMemories) as MemoryWithScore[];
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
          singleUserId ?? 'default',
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

    const latencyMs = Date.now() - startTime;

    // Fire-and-forget query log for re-ranker training
    if (this.queryLogService) {
      this.queryLogService.logQuery({
        queryText: dto.query,
        queryEmbedding: queryEmbedding,
        agentId: dto.agentId,
        sessionKey: dto.agentSessionKey,
        results: result.map((m, i) => ({
          memoryId: m.id,
          cosineScore: m.score ?? 0,
          rank: i + 1,
        })),
        latencyMs,
      });
    }

    return {
      recallId: randomUUID(),
      memories: result,
      queryTokens: dto.query.split(/\s+/).length,
      latencyMs,
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
   * Perform recall using multi-query retrieval
   */
  private async recallWithMultiQuery(
    userId: string | string[] | null,
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
      userId ?? [],
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
    const metadataFilterMQ = this.buildMetadataFilter(dto);

    const memories = await this.prisma.memory.findMany({
      where: {
        id: { in: memoryIds },
        deletedAt: null,
        supersededById: null,
        searchable: { not: false },
        ...subjectTypeFilter,
        ...visibilityFilterMQ,
        ...metadataFilterMQ,
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
        const adjustedScore =
          blendedScore * this.recallWeightService.recallWeight(memory);

        return { ...memory, score: adjustedScore } as MemoryWithScore;
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    let result: MemoryWithScore[] = scoredMemories;
    if (dto.includeChains) {
      result = ((await this.memoryFailureService?.attachChains(
        scoredMemories,
      )) ?? scoredMemories) as MemoryWithScore[];
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

    // v1.6: Anticipatory Recall — also runs on multi-query path
    let anticipatoryMeta2:
      | import('../anticipatory/dto/anticipatory.dto').AnticipatoryMeta
      | undefined;
    if (dto.anticipatory?.enabled && this.anticipatoryService) {
      try {
        const excludeIds = new Set(result.map((m) => m.id));
        const areResult = await this.anticipatoryService.run(
          dto.query,
          Array.isArray(userId) ? userId[0] : (userId ?? 'default'),
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

    const latencyMsMq = Date.now() - startTime;

    // Fire-and-forget query log for re-ranker training (multi-query path)
    if (this.queryLogService) {
      this.queryLogService.logQuery({
        queryText: dto.query,
        queryEmbedding: [], // multi-query uses multiple embeddings; omit to avoid picking one arbitrarily
        agentId: dto.agentId,
        sessionKey: dto.agentSessionKey,
        results: result.map((m, i) => ({
          memoryId: m.id,
          cosineScore: m.score ?? 0,
          rank: i + 1,
        })),
        latencyMs: latencyMsMq,
      });
    }

    return {
      recallId: randomUUID(),
      memories: result,
      queryTokens: dto.query.split(/\s+/).length,
      latencyMs: latencyMsMq,
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
   * ENG-48: Build Prisma WHERE clause for explicit after/before date range.
   */
  buildTemporalRangeFilter(dto: QueryMemoryDto): Record<string, any> {
    if (!dto.after && !dto.before) return {};
    const createdAt: Record<string, any> = {};
    if (dto.after) createdAt.gte = new Date(dto.after);
    if (dto.before) createdAt.lte = new Date(dto.before);
    return { createdAt };
  }

  /**
   * ENG-42: Build Prisma WHERE clause for tag + metadata pre-filtering.
   */
  buildMetadataFilter(dto: QueryMemoryDto): Record<string, any> {
    const filter: Record<string, any> = {};

    // ENG-42 + ENG-48: Merge filter.tags and arc into a single hasEvery filter
    const allTags = [
      ...(dto.filter?.tags ?? []),
      ...(dto.arc ? [dto.arc] : []),
    ];
    if (allTags.length > 0) {
      filter.tags = { hasEvery: allTags };
    }

    if (dto.filter?.metadata && Object.keys(dto.filter.metadata).length > 0) {
      // Prisma JSON path filter: memory.metadata must contain every key-value pair
      const andConditions = Object.entries(dto.filter.metadata).map(
        ([key, value]) => ({
          metadata: { path: [key], equals: value },
        }),
      );
      filter.AND = andConditions;
    }

    return filter;
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

  async traceTimeline(
    agentId: string,
    dto: TraceTimelineDto,
  ): Promise<TraceTimelineResponse> {
    const { topic, startDate, endDate, method = 'keyword', limit = 100 } = dto;
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

    // Group by day
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

    // Generate all days in range for gap detection
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

    // Sort entries chronologically
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
}
