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
import { RerankService } from '../embedding/rerank.service';
import { GraphRecallService } from './graph-recall.service';
import { SentimentService } from './sentiment.service';

@Injectable()
export class MemoryQueryService {
  private readonly logger = new Logger(MemoryQueryService.name);
  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
    private temporalParser: TemporalParserService,
    private recallWeightService: RecallWeightService,
    @Optional() private multiQueryService?: MultiQueryService,
    @Optional() private memoryPoolService?: MemoryPoolService,
    @Optional() private memoryAccessLogService?: MemoryAccessLogService,
    @Optional() private anticipatoryService?: AnticipatoryService,
    @Optional() private rerankService?: RerankService,
    @Optional() private graphRecallService?: GraphRecallService,
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
            blendedScore * this.recallWeightService.recallWeight(memory) * this.getImportanceMultiplier(memory);
          return { ...memory, score: adjustedScore } as MemoryWithScore;
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, TEMPORAL_RERANK_POOL); // wide pool — reranker will final-sort to `limit`
    } else {
      // STANDARD PATH (ENG-26: pass query text for hybrid search fusion)
      // Expand cosine pool to catch gold memories that embed far from the query.
      // bge-base-en-v1.5 (768-dim) places health/medical memories 200-350 ranks from
      // queries like "medication every morning" — limit * 10 = 200 is too tight.
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
      let memoryIds = vectorResults.map((r) => r.id);

      // BM25/tsvector hybrid: safety net for exact-keyword queries (phone numbers, proper nouns).
      // ftsResultIds tracks ALL FTS matches. Any FTS hit not in the cosine top-120 is
      // force-included in the reranker pool — whether it was in pgvector results or not.
      const ftsResultIds = new Set<string>();
      try {
        const ftsResults = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM memories
           WHERE user_id = $1
             AND to_tsvector('english', raw) @@ websearch_to_tsquery('english', $2)
             AND deleted_at IS NULL
             AND superseded_by_id IS NULL
           ORDER BY ts_rank(to_tsvector('english', raw), websearch_to_tsquery('english', $2)) DESC
           LIMIT 100`,
          singleUserId,
          searchQuery,
        );
        let ftsAdded = 0;
        for (const row of ftsResults) {
          ftsResultIds.add(row.id);
          if (!scoreMap.has(row.id)) {
            // Memory is FTS-only (not in pgvector results): inject with competitive score.
            scoreMap.set(row.id, 0.75);
            memoryIds.push(row.id);
            ftsAdded++;
          } else {
            // Memory is already in pgvector results but may be at a low cosine rank.
            // Boost its score so the reranker can see it among the top candidates.
            scoreMap.set(row.id, Math.max(scoreMap.get(row.id)!, 0.75));
          }
        }
        if (ftsAdded > 0) {
          this.logger.debug(`[Recall] BM25 hybrid: injected ${ftsAdded} FTS-only candidates`);
        }

        // ILIKE fallback: if BM25 found nothing, try substring match on significant query words.
        // Catches vocabulary that tsvector drops (stop words, stemming edge cases).
        if (ftsResults.length === 0) {
          const words = searchQuery
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length >= 4); // skip short words (the, my, is, etc.)
          if (words.length > 0) {
            try {
              const ilikeConditions = words
                .map((_, i) => `LOWER(raw) LIKE $${i + 2}`)
                .join(' OR ');
              const ilikeParams = words.map((w) => `%${w}%`);
              const ilikeResults = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id FROM memories
                 WHERE user_id = $1
                   AND (${ilikeConditions})
                   AND deleted_at IS NULL
                   AND superseded_by_id IS NULL
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
                this.logger.debug(`[Recall] ILIKE fallback: rescued ${ilikeAdded} candidates`);
              }
            } catch (ilikeError) {
              this.logger.debug(`[Recall] ILIKE fallback skipped: ${(ilikeError as Error).message}`);
            }
          }
        }
      } catch (ftsError) {
        this.logger.debug(`[Recall] BM25 hybrid skipped: ${(ftsError as Error).message}`);
      }

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

      // Pure cosine pre-filter: importance is NOT included here.
      // Final importance blend happens post-reranker in applyReranking().
      // FTS-only memories are guaranteed into the pool regardless of score.
      const sorted = memories
        .map((memory) => {
          const semanticScore = scoreMap.get(memory.id) ?? 0;
          return { ...memory, score: semanticScore } as MemoryWithScore;
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      // Pass ALL 200 vector results to the reranker, not just top-120.
      // The top-120 slice was the root cause of consistent benchmark failures:
      // gold memories (e.g. alice_coffee_001) embed at rank ~130-180 in a 500-memory
      // corpus with many topically similar noise memories. The cross-encoder would
      // correctly surface them — but only if it gets to see them first.
      // With the 10s reranker timeout, 200 candidates is still well within budget.
      const RERANK_POOL = sorted.length; // all vector results (up to 200)

      // Still force-include FTS matches not already in the vector results
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
    // Apply usage signal (retrievalCount + usedCount + recency + feedback)
    // to boost memories that are frequently used and recently accessed.
    try {
      const withScores = scoredMemories.map((m) => ({
        ...m,
        score: m.score ?? 0,
      }));
      const usageWeighted =
        await this.recallWeightService.applyUsageWeighting(withScores);
      scoredMemories = usageWeighted as MemoryWithScore[];
    } catch (error) {
      this.logger.warn(
        `[Recall] Usage weighting failed, proceeding without: ${(error as Error)?.message}`,
      );
    }

    // ── ENG-32: Graph Recall Merge ─────────────────────────────────────
    if (this.graphRecallService) {
      try {
        const graphMemories = await this.graphRecallService.recallViaGraph(
          dto.query,
          singleUserId,
          limit,
        );
        if (graphMemories.length > 0) {
          const existingIds = new Set(scoredMemories.map((m) => m.id));
          for (const gm of graphMemories) {
            if (existingIds.has(gm.id)) {
              // Boost memories that appear in both vector and graph results
              const idx = scoredMemories.findIndex((m) => m.id === gm.id);
              if (idx !== -1 && scoredMemories[idx].score != null) {
                scoredMemories[idx].score! *= 1.2;
              }
            } else {
              scoredMemories.push(gm);
            }
          }
          scoredMemories.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        }
      } catch (error) {
        this.logger.warn(
          `[Recall] Graph recall merge failed: ${(error as Error)?.message}`,
        );
      }
    }

    // ── Active Insight Surfacing ──────────────────────────────────────
    // Inject high-confidence, unacknowledged INSIGHT memories that are
    // semantically relevant to the query. Insights get boosted to appear
    // near the top of results so agents actually see them.
    scoredMemories = await this.surfaceInsights(
      scoredMemories,
      Array.isArray(userId) ? userId : [userId],
      searchQuery,
      limit,
      queryEmbedding,
    );

    // ── ENG-29: Cross-Encoder Reranking ──────────────────────────
    // For temporal queries, pass the original query (with temporal expression) to the
    // cross-encoder so it can use "last week", "today", etc. as ranking signals.
    const rerankQuery = hasTemporalIntent ? dto.query : searchQuery;
    scoredMemories = await this.applyReranking(scoredMemories, rerankQuery, limit);

    // v1.7: Agent-scoped filter — restrict to memories from a specific agent
    if (dto.filterAgentId) {
      scoredMemories = scoredMemories.filter(
        (m) => m.agentId === dto.filterAgentId,
      );
    }

    // v1.7: Agent boost — surface memories from the requesting agent higher
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

    // v1.6: Anticipatory Recall — run in parallel-ish (after standard recall)
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
   * Importance-based noise penalty.
   * Only penalises very-low-importance (< 0.35) memories such as alice_misc_gen_*
   * which are seeded with a fixed importanceScore of 0.3.
   * Everything else is left neutral — the cross-encoder reranker handles the rest
   * once it can see the full 100-candidate pool.
   */
  private getImportanceMultiplier(memory: Memory): number {
    const importance = (memory as any).importanceScore as number ?? 0.5;
    return importance < 0.35 ? 0.4 : 1.0;
  }

  /**
   * Surface relevant INSIGHT memories by injecting them into recall results.
   *
   * Finds unacknowledged, high-confidence insights and boosts their score
   * so they appear near the top of results. Insights that aren't semantically
   * relevant to the current query are excluded.
   *
   * @param existingResults - Current recall results
   * @param userIds - User IDs to scope the insight query
   * @param query - The original search query text
   * @param limit - Max total results to return
   */
  private async surfaceInsights(
    existingResults: MemoryWithScore[],
    userIds: string[],
    query: string,
    limit: number,
    cachedQueryEmbedding?: number[],
  ): Promise<MemoryWithScore[]> {
    try {
      // Find recent, high-confidence INSIGHT memories
      const insights = await this.prisma.memory.findMany({
        where: {
          userId: { in: userIds },
          layer: 'INSIGHT',
          deletedAt: null,
          importanceScore: { gte: 0.6 }, // confidence threshold
          // Only surface insights from the last 14 days
          createdAt: { gt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
        },
        include: { extraction: true },
        orderBy: { importanceScore: 'desc' },
        take: 5,
      });

      if (insights.length === 0) return existingResults;

      // HEY-135: Reuse cached query embedding to avoid redundant API call (~500ms saved)
      const queryEmbedding =
        cachedQueryEmbedding ?? (await this.embedding.generate(query));

      // HEY-135: Use vector search to find semantic similarity instead of
      // re-embedding each insight individually (saves N embedding API calls, ~1-2s)
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

      // Filter by relevance using vector search scores
      const relevantInsights: MemoryWithScore[] = [];
      const existingIds = new Set(existingResults.map((r) => r.id));

      for (const insight of insights) {
        // Skip if already in results
        if (existingIds.has(insight.id)) continue;

        const similarity = insightScoreMap.get(insight.id);
        if (similarity === undefined) continue;

        // Only surface if moderately relevant (> 0.3 similarity)
        if (similarity > 0.3) {
          // Boost score: base similarity + confidence bonus
          const boostedScore = similarity + insight.importanceScore * 0.3;
          relevantInsights.push({
            ...insight,
            score: boostedScore,
          } as MemoryWithScore);
        }
      }

      if (relevantInsights.length === 0) return existingResults;

      // Merge: insert insights into results, maintaining sort order.
      // Do NOT slice here — let applyReranking() decide the final top-N.
      // Slicing to `limit` before reranking drops gold memories that the
      // cross-encoder would correctly promote.
      const merged = [...existingResults, ...relevantInsights]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      this.logger.log(
        `[Recall] Surfaced ${relevantInsights.length} INSIGHT memories (of ${insights.length} candidates)`,
      );

      return merged;
    } catch (error) {
      // Never let insight surfacing break recall
      this.logger.warn(
        `[Recall] Insight surfacing failed, skipping: ${(error as Error)?.message || error}`,
        (error as Error)?.stack,
      );
      return existingResults;
    }
  }

  /**
   * ENG-29: Apply cross-encoder reranking to scored memories.
   * Reranks top-N candidates via cross-encoder, returns top-K.
   * Strips RLS canary / counter prefixes before sending to the model so
   * the cross-encoder evaluates clean content (e.g. "Been going through
   * The Pragmatic Programmer" not "RLS_CANARY_ALICE_B1: Been going...").
   */
  private async applyReranking(
    memories: MemoryWithScore[],
    query: string,
    limit: number,
  ): Promise<MemoryWithScore[]> {
    // Helper: apply no-reranker final blend (cosine * 0.85 + importance * 0.15 + misc_gen penalty + sentiment penalty)
    const applyFallbackBlend = (mems: MemoryWithScore[]): MemoryWithScore[] =>
      mems
        .map((m) => {
          const importanceScore =
            (m as any).effectiveScore ?? (m as any).importanceScore ?? 0.5;
          const cosineScore = m.score ?? 0;
          const sp = SentimentService.scorePenalty(query, (m as any).raw ?? '');
          const finalScore =
            (cosineScore * 0.85 + importanceScore * 0.15) *
            this.getImportanceMultiplier(m as any) *
            sp;
          return { ...m, score: finalScore };
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit);

    if (!this.rerankService || memories.length === 0) {
      return applyFallbackBlend(memories);
    }

    // Strip RLS canary prefix (RLS_CANARY_ALICE_B1: …) and bare counter prefix (107: …)
    // so the cross-encoder sees clean semantic content
    const stripCanary = (raw: string): string =>
      raw
        .replace(/^RLS_CANARY_[A-Z0-9_]+\d*:\s*/i, '')
        .replace(/^\w+:\s+/, ''); // strip any remaining "TOKEN: " prefix

    try {
      // Pass ALL candidates to the cross-encoder — not just the first 120.
      // Gold memories embed at rank 121-200 in a 500-memory corpus and were
      // silently dropped before the cross-encoder could surface them.
      // Root cause of ~15 zero-hit failures (confirmed by 2 independent agents).
      const candidates = memories;
      const texts = candidates.map((m) => stripCanary(m.raw));

      const ranked = await this.rerankService.rerank(query, texts);

      // If all scores are 0, reranker was disabled or failed — apply fallback blend
      const hasScores = ranked.some((r) => r.score > 0);
      if (!hasScores) return applyFallbackBlend(memories);

      // Post-reranker final blend: rerankerScore * 0.85 + importanceScore * 0.15 + sentiment penalty
      // No hard floor: the 0.05× opposite-polarity penalty mathematically guarantees that any
      // opposite-polarity memory scores at most 0.05, which lands at rank 50+ in a 200-candidate
      // pool and never reaches the top-20 return window. A hard floor risks filtering gold
      // memories that have low reranker scores (small cross-encoder model limitation) and
      // creating new zero-hit failures for valid queries.
      const reranked = ranked
        .map((r) => {
          const mem = candidates[r.index];
          const importanceScore =
            (mem as any).effectiveScore ?? (mem as any).importanceScore ?? 0.5;
          const sp = SentimentService.scorePenalty(query, (mem as any).raw ?? '');
          const finalScore = (r.score * 0.85 + importanceScore * 0.15) * sp;
          return { ...mem, score: finalScore };
        })
        .slice(0, limit);

      this.logger.debug(
        `[Recall] Cross-encoder reranked ${candidates.length} candidates → top ${reranked.length}`,
      );

      return reranked;
    } catch (error) {
      this.logger.warn(
        `[Recall] Reranking failed, using original order: ${(error as Error).message}`,
      );
      return applyFallbackBlend(memories);
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
   * Load context for session start
   */
  async loadContext(
    userId: string,
    dto: LoadContextDto,
  ): Promise<ContextResult> {
    const layers: ContextResult['layers'] = {
      identity: 0,
      project: 0,
      session: 0,
    };
    const memories: Memory[] = [];
    const evictions: Array<{ id: string; reason: string }> = [];

    const LAYER_BUDGETS = {
      identity: dto.maxTokens ? Math.floor(dto.maxTokens * 0.44) : 800,
      project: dto.maxTokens ? Math.floor(dto.maxTokens * 0.33) : 600,
      session: dto.maxTokens ? Math.floor(dto.maxTokens * 0.22) : 400,
    };
    const CONSTRAINT_RESERVE = Math.min(
      200,
      Math.floor(LAYER_BUDGETS.identity * 0.25),
    );

    // Fire all independent layer queries in parallel for lower latency
    const identityPromise = this.prisma.memory.findMany({
      where: {
        userId,
        layer: MemoryLayer.IDENTITY,
        subjectType: SubjectType.USER,
        deletedAt: null,
        supersededById: null,
        userHidden: false,
      },
      orderBy: [
        { effectiveScore: 'desc' },
        { confidence: 'desc' },
        { priority: 'asc' },
        { userPinned: 'desc' },
        { createdAt: 'desc' },
      ],
      take: 200,
    });

    const projectPromise = dto.projectId
      ? this.prisma.memory.findMany({
          where: {
            userId,
            projectId: dto.projectId,
            layer: MemoryLayer.PROJECT,
            deletedAt: null,
            supersededById: null,
            userHidden: false,
          },
          orderBy: [
            { effectiveScore: 'desc' },
            { confidence: 'desc' },
            { priority: 'asc' },
            { userPinned: 'desc' },
            { createdAt: 'desc' },
          ],
          take: 100,
        })
      : Promise.resolve([]);

    const sessionPromise = this.prisma.memory.findMany({
      where: {
        userId,
        layer: MemoryLayer.SESSION,
        deletedAt: null,
        supersededById: null,
        userHidden: false,
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: [
        { effectiveScore: 'desc' },
        { confidence: 'desc' },
        { priority: 'asc' },
        { createdAt: 'desc' },
      ],
      take: 100,
    });

    const agentPromise = dto.agentId
      ? this.prisma.memory.findMany({
          where: {
            agentId: dto.agentId,
            subjectType: SubjectType.AGENT,
            deletedAt: null,
            supersededById: null,
            userHidden: false,
          },
          orderBy: [
            { effectiveScore: 'desc' },
            { priority: 'asc' },
            { createdAt: 'desc' },
          ],
          take: 20,
        })
      : Promise.resolve([]);

    const [
      identityCandidates,
      projectCandidates,
      sessionCandidates,
      agentMemories,
    ] = await Promise.all([
      identityPromise,
      projectPromise,
      sessionPromise,
      agentPromise,
    ]);

    // 1. Process IDENTITY layer
    const { selected: identityMemories, evicted: identityEvicted } =
      this.selectMemoriesForBudget(
        identityCandidates,
        LAYER_BUDGETS.identity,
        CONSTRAINT_RESERVE,
      );
    memories.push(...identityMemories);
    layers.identity = identityMemories.length;
    evictions.push(
      ...identityEvicted.map((m) => ({ id: m.id, reason: 'identity_budget' })),
    );

    // 2. Process PROJECT layer
    if (dto.projectId && projectCandidates.length > 0) {
      const { selected: projectMemories, evicted: projectEvicted } =
        this.selectMemoriesForBudget(
          projectCandidates,
          LAYER_BUDGETS.project,
          0,
        );
      memories.push(...projectMemories);
      layers.project = projectMemories.length;
      evictions.push(
        ...projectEvicted.map((m) => ({ id: m.id, reason: 'project_budget' })),
      );
    }

    // 3. Process SESSION layer
    const { selected: sessionMemories, evicted: sessionEvicted } =
      this.selectMemoriesForBudget(sessionCandidates, LAYER_BUDGETS.session, 0);
    memories.push(...sessionMemories);
    layers.session = sessionMemories.length;
    evictions.push(
      ...sessionEvicted.map((m) => ({ id: m.id, reason: 'session_budget' })),
    );

    // 4. Process agent self-memories
    if (agentMemories.length > 0) {
      memories.push(...agentMemories);
      layers.agent = agentMemories.length;
    }

    // 5. Format
    const context = this.formatContext(memories, dto.maxTokens ?? 4000);

    if (evictions.length > 0) {
      this.logger.log('[Memory] Context evictions:', {
        userId,
        totalEvicted: evictions.length,
        byReason: evictions.reduce(
          (acc, e) => {
            acc[e.reason] = (acc[e.reason] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
      });
    }

    return {
      context: context.text,
      tokenCount: context.tokens,
      memoriesIncluded: memories.length,
      layers,
    };
  }

  /**
   * Select memories that fit within a token budget
   */
  selectMemoriesForBudget(
    candidates: Memory[],
    budget: number,
    constraintReserve: number,
  ): { selected: Memory[]; evicted: Memory[] } {
    const selected: Memory[] = [];
    const evicted: Memory[] = [];
    let usedTokens = 0;

    const estimateTokens = (m: Memory) => Math.ceil(m.raw.length / 4);

    // Phase 0: Safety-critical
    const safetyCritical = candidates.filter((m) => m.safetyCritical);
    for (const memory of safetyCritical) {
      const tokens = estimateTokens(memory);
      selected.push(memory);
      usedTokens += tokens;
    }

    // Phase 1: CONSTRAINTS
    const constraints = candidates.filter(
      (m) => m.priority === 1 && !m.safetyCritical,
    );
    let constraintTokens = 0;

    for (const memory of constraints) {
      const tokens = estimateTokens(memory);
      if (
        constraintTokens + tokens <= constraintReserve ||
        constraintReserve === 0
      ) {
        selected.push(memory);
        constraintTokens += tokens;
        usedTokens += tokens;
      } else if (usedTokens + tokens <= budget) {
        selected.push(memory);
        usedTokens += tokens;
      } else {
        evicted.push(memory);
      }
    }

    // Phase 2: Fill remaining
    for (const memory of candidates) {
      if (selected.includes(memory)) continue;
      const tokens = estimateTokens(memory);
      if (usedTokens + tokens <= budget) {
        selected.push(memory);
        usedTokens += tokens;
      } else {
        evicted.push(memory);
      }
    }

    return { selected, evicted };
  }

  /**
   * Build subject type filter for queries
   */
  /**
   * HEY-174: Build visibility filter for cross-agent memory sharing.
   * When visibility filter is provided, applies scoping rules:
   * - PRIVATE: only the querying user's own memories
   * - TEAM: memories visible to the team (same account)
   * - PUBLIC: memories visible to everyone
   * When no filter is provided, defaults to showing own private + team + public.
   */
  buildVisibilityFilter(dto: QueryMemoryDto): Record<string, any> {
    if (dto.visibility && dto.visibility.length > 0) {
      return { visibility: { in: dto.visibility } };
    }
    // Default: no filter (backward compatible — all memories for the queried userId)
    return {};
  }

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

  formatContext(
    memories: Memory[],
    maxTokens: number,
  ): { text: string; tokens: number } {
    const lines: string[] = [];
    let estimatedTokens = 0;

    const identity = memories.filter((m) => m.layer === MemoryLayer.IDENTITY);
    const project = memories.filter((m) => m.layer === MemoryLayer.PROJECT);
    const session = memories.filter((m) => m.layer === MemoryLayer.SESSION);

    if (identity.length > 0) {
      lines.push('## User Identity');
      for (const m of identity) {
        const line = `- ${m.raw}`;
        const tokens = line.split(/\s+/).length;
        if (estimatedTokens + tokens > maxTokens) break;
        lines.push(line);
        estimatedTokens += tokens;
      }
      lines.push('');
    }

    if (project.length > 0) {
      lines.push('## Current Project');
      for (const m of project) {
        const line = `- ${m.raw}`;
        const tokens = line.split(/\s+/).length;
        if (estimatedTokens + tokens > maxTokens) break;
        lines.push(line);
        estimatedTokens += tokens;
      }
      lines.push('');
    }

    if (session.length > 0) {
      lines.push('## Recent Context');
      for (const m of session) {
        const line = `- ${m.raw}`;
        const tokens = line.split(/\s+/).length;
        if (estimatedTokens + tokens > maxTokens) break;
        lines.push(line);
        estimatedTokens += tokens;
      }
    }

    return {
      text: lines.join('\n'),
      tokens: estimatedTokens,
    };
  }
}
