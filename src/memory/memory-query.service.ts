import { Injectable, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { TemporalParserService } from './temporal/temporal-parser.service';
import { QueryMemoryDto, LoadContextDto } from './dto/query-memory.dto';
import { MultiQueryService } from '../multi-query/multi-query.service';
import { MemoryPoolService } from '../memory-pool/memory-pool.service';
import { MemoryAccessLogService } from '../memory-access-log/memory-access-log.service';
import { AnticipatoryService } from '../anticipatory/anticipatory.service';
import { ResultExplanationDto } from '../multi-query/dto/multi-query.dto';
import { Memory, SubjectType } from '@prisma/client';
import {
  MemoryWithExtraction,
  MemoryWithScore,
  QueryResult,
  ContextResult,
} from './memory.types';
import { RecallWeightService } from './recall-weight.service';
import { MemoryQueryRankingService } from './memory-query-ranking.service';
import { MemoryQueryContextService } from './memory-query-context.service';

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
          searchable: { not: false },
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
        searchQuery,
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
        userId,
        queryEmbedding,
        candidateLimit,
        dto.layers as any,
        undefined,
        poolIds,
        searchQuery,
      );

      const scoreMap = new Map(vectorResults.map((r) => [r.id, r.score]));
      const memoryIds = vectorResults.map((r) => r.id);

      // BM25/tsvector hybrid: safety net for exact-keyword queries
      const ftsResultIds = new Set<string>();
      try {
        const ftsResults = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM memories
           WHERE user_id = $1
             AND to_tsvector('english', raw) @@ websearch_to_tsquery('english', $2)
             AND deleted_at IS NULL
             AND superseded_by_id IS NULL
             AND searchable IS NOT FALSE
           ORDER BY ts_rank(to_tsvector('english', raw), websearch_to_tsquery('english', $2)) DESC
           LIMIT 100`,
          singleUserId,
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
              const ilikeConditions = words
                .map((_, i) => `LOWER(raw) LIKE $${i + 2}`)
                .join(' OR ');
              const ilikeParams = words.map((w) => `%${w}%`);
              const ilikeResults = await this.prisma.$queryRawUnsafe<
                { id: string }[]
              >(
                `SELECT id FROM memories
                 WHERE user_id = $1
                   AND (${ilikeConditions})
                   AND deleted_at IS NULL
                   AND superseded_by_id IS NULL
                   AND searchable IS NOT FALSE
                 LIMIT 20`,
                singleUserId,
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
        singleUserId,
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
      Array.isArray(userId) ? userId : [userId],
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
      result = (await this.attachChains(scoredMemories)) as MemoryWithScore[];
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
        searchable: { not: false },
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
        const adjustedScore =
          blendedScore * this.recallWeightService.recallWeight(memory);

        return { ...memory, score: adjustedScore } as MemoryWithScore;
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    let result: MemoryWithScore[] = scoredMemories;
    if (dto.includeChains) {
      result = (await this.attachChains(scoredMemories)) as MemoryWithScore[];
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

  private async attachChains(
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
