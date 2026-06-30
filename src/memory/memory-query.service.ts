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
import {
  EmbeddingStatus,
  Memory,
  MemoryLayer,
  SubjectType,
} from '@prisma/client';
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
    const sessionIdFilter = this.buildSessionIdFilter(dto);
    const allowInsightSurfacing =
      !dto.layers || dto.layers.includes(MemoryLayer.INSIGHT);
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
    const keywordRescueMap = new Map<string, MemoryWithScore>();

    if (hasTemporalIntent) {
      // TEMPORAL PATH — HEY-575: Adaptive window expansion
      // ENG-48 after/before merging is applied on the first expansion pass below
      const adaptiveEnabled = process.env.TEMPORAL_QUERY_ADAPTIVE !== 'false';
      const minResults = parseInt(
        process.env.TEMPORAL_QUERY_MIN_RESULTS ?? '5',
        10,
      );
      const maxExpand = parseInt(
        process.env.TEMPORAL_QUERY_MAX_EXPAND ?? '3',
        10,
      );
      const timeoutMs = parseInt(
        process.env.TEMPORAL_QUERY_TIMEOUT_MS ?? '200',
        10,
      );

      let activeFilter = parsed.temporalFilter!;
      // Cap expansion end at the original filter's end to prevent the window
      // from creeping into the present for past-anchored queries (e.g. "years ago").
      const originalFilterEnd = parsed.temporalFilter!.end;
      let temporalMemories: MemoryWithExtraction[];
      let expandPass = 0;
      const expandStart = Date.now();
      const expandDeadline = expandStart + timeoutMs;

      // HEY-575: log expansion-loop entry config so we can correlate later
      // termination reasons against the configured envelope.
      this.logger.log({
        event: 'recall.temporal_expand.enter',
        adaptiveEnabled,
        minResults,
        maxExpand,
        timeoutMs,
        initialWindow: {
          start: activeFilter.start.toISOString(),
          end: originalFilterEnd.toISOString(),
        },
      });

      let timedOut = false;
      do {
        const passStart = Date.now();
        // Clamp end to originalFilterEnd so expansion never pulls in memories
        // newer than the parsed temporal intent allows.
        const clampedEnd =
          activeFilter.end > originalFilterEnd
            ? originalFilterEnd
            : activeFilter.end;

        const activeCreatedAt: Record<string, any> = {
          gte: activeFilter.start,
          lte: clampedEnd,
        };
        if (expandPass === 0) {
          // Only apply explicit after/before on the first pass
          if (dto.after) {
            const afterDate = new Date(dto.after);
            if (afterDate > activeCreatedAt.gte)
              activeCreatedAt.gte = afterDate;
          }
          if (dto.before) {
            const beforeDate = new Date(dto.before);
            if (beforeDate < activeCreatedAt.lte)
              activeCreatedAt.lte = beforeDate;
          }
        }

        // Temporal C1+M1: filter on effective event time (observedAt ?? createdAt).
        // OR-clause keeps the [userId, observedAt] index usable for the
        // observedAt branch; memories without observedAt fall back to createdAt.
        temporalMemories = await this.prisma.memory.findMany({
          where: {
            userId: userIdFilter,
            deletedAt: null,
            supersededById: null,
            searchable: { not: false },
            embeddingStatus: { not: EmbeddingStatus.DUPLICATE },
            isDuplicateOf: null,
            OR: [
              { observedAt: activeCreatedAt },
              { observedAt: null, createdAt: activeCreatedAt },
            ],
            ...subjectTypeFilter,
            ...visibilityFilter,
            ...metadataFilter,
            ...sessionIdFilter,
            ...(dto.filterAgentId ? { agentId: dto.filterAgentId } : {}),
          },
          include: { extraction: true },
          orderBy: [
            { observedAt: { sort: 'desc', nulls: 'last' } },
            { createdAt: 'desc' },
          ],
          take: 200,
        });

        this.logger.debug({
          event: 'recall.temporal_expand.pass',
          pass: expandPass,
          windowStart: (activeCreatedAt.gte as Date).toISOString(),
          windowEnd: (activeCreatedAt.lte as Date).toISOString(),
          windowMultiplier: Math.pow(2, expandPass),
          candidatesFound: temporalMemories.length,
          elapsedMs: Date.now() - passStart,
        });

        expandPass++;

        // Widen the window by doubling the span each pass
        activeFilter = this.temporalParser.expandWindow(activeFilter, 2.0);

        // Retrieval C2 fix: the deadline may only terminate the loop AFTER at
        // least 2 passes have completed. Previously this guard fired right
        // after pass 0 whenever the (default 200ms) deadline had elapsed,
        // so expansion never ran even once.
        if (
          adaptiveEnabled &&
          temporalMemories.length < minResults &&
          expandPass <= maxExpand &&
          expandPass >= 2 &&
          Date.now() >= expandDeadline
        ) {
          timedOut = true;
          break;
        }
      } while (
        adaptiveEnabled &&
        temporalMemories.length < minResults &&
        expandPass <= maxExpand
      );

      const terminationReason = timedOut
        ? 'timeout'
        : !adaptiveEnabled
          ? 'adaptive_disabled'
          : temporalMemories.length >= minResults
            ? 'min_results_satisfied'
            : expandPass > maxExpand
              ? 'max_expand_reached'
              : 'unknown';

      if (timedOut) {
        this.logger.warn({
          event: 'recall.temporal_expand.timeout',
          passes: expandPass,
          candidatesFound: temporalMemories.length,
          minResults,
          timeoutMs,
          elapsedMs: Date.now() - expandStart,
        });
      }

      this.logger.log({
        event: 'recall.temporal_expand.exit',
        passes: expandPass,
        candidatesFound: temporalMemories.length,
        terminationReason,
        elapsedMs: Date.now() - expandStart,
      });

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
          // Temporal C1: score against effective event time, not ingest time
          const temporalScore = this.temporalParser.calculateTemporalRelevance(
            memory.observedAt ?? memory.createdAt,
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
      const keywordRescueIds = new Set<string>();

      // BM25/tsvector hybrid: safety net for exact-keyword queries.
      // In pool-auth mode (no userId), scope FTS via pool-membership subquery.
      // When account auth resolves multiple users, search all resolved users
      // instead of collapsing keyword rescue to the first user.
      const ftsResultIds = new Set<string>();
      const poolOnlyMode = poolIds && poolIds.length > 0 && !singleUserId;
      const resolvedUserIds = Array.isArray(userId)
        ? userId
        : singleUserId
          ? [singleUserId]
          : [];
      try {
        const ftsResults = poolOnlyMode
          ? await this.prisma.$queryRawUnsafe<{ id: string }[]>(
              `SELECT m.id FROM memories m
               WHERE m.id IN (
                 SELECT mpm.memory_id FROM memory_pool_memberships mpm
                 WHERE mpm.pool_id = ANY($1::text[])
               )
                 AND to_tsvector('english', m.raw) @@ websearch_to_tsquery('english', $2)
                 AND m.deleted_at IS NULL
                 AND m.superseded_by_id IS NULL
                 AND m.searchable IS NOT FALSE
                 AND m.embedding_status != 'DUPLICATE'
                 AND m.is_duplicate_of IS NULL
               ORDER BY ts_rank(to_tsvector('english', m.raw), websearch_to_tsquery('english', $2)) DESC
               LIMIT 100`,
              poolIds,
              searchQuery,
            )
          : resolvedUserIds.length > 0
            ? await this.prisma.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id FROM memories
               WHERE user_id = ANY($1::text[])
                 AND to_tsvector('english', raw) @@ websearch_to_tsquery('english', $2)
                 AND deleted_at IS NULL
                 AND superseded_by_id IS NULL
                 AND searchable IS NOT FALSE
                 AND embedding_status != 'DUPLICATE'
                 AND is_duplicate_of IS NULL
               ORDER BY ts_rank(to_tsvector('english', raw), websearch_to_tsquery('english', $2)) DESC
               LIMIT 100`,
                resolvedUserIds,
                searchQuery,
              )
            : await this.prisma.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id FROM memories
               WHERE to_tsvector('english', raw) @@ websearch_to_tsquery('english', $1)
                 AND deleted_at IS NULL
                 AND superseded_by_id IS NULL
                 AND searchable IS NOT FALSE
                 AND embedding_status != 'DUPLICATE'
                 AND is_duplicate_of IS NULL
               ORDER BY ts_rank(to_tsvector('english', raw), websearch_to_tsquery('english', $1)) DESC
               LIMIT 100`,
                searchQuery,
              );
        // RRF fusion (k=60): BM25 rank contributes 1/(k+rank) so rank-1
        // BM25 hit scores ≈0.016, rank-100 ≈0.006. This prevents a flat
        // 0.75 override from promoting low-quality exact-keyword matches
        // above high-quality semantic matches.
        const RRF_K = 60;
        let ftsAdded = 0;
        for (let ftsRank = 0; ftsRank < ftsResults.length; ftsRank++) {
          const row = ftsResults[ftsRank];
          const bm25Score = 1 / (RRF_K + ftsRank + 1);
          ftsResultIds.add(row.id);
          keywordRescueIds.add(row.id);
          if (!scoreMap.has(row.id)) {
            scoreMap.set(row.id, 1.25);
            memoryIds.push(row.id);
            ftsAdded++;
          } else {
            scoreMap.set(row.id, Math.max(scoreMap.get(row.id)!, 1.25));
          }
        }
        if (ftsAdded > 0) {
          this.logger.debug(
            `[Recall] BM25 hybrid (RRF): injected ${ftsAdded} FTS-only candidates`,
          );
        }

        // Lexical rescue runs alongside FTS, not only when FTS returns zero.
        // websearch_to_tsquery can be too strict for natural questions (for
        // example requiring filler terms such as "tell" or "need"), while a
        // curated ILIKE pass catches exact domain words like medication/roast.
        const words = this.extractLexicalRescueTerms(searchQuery);
        if (words.length > 0) {
          try {
            const hasResolvedUsers = resolvedUserIds.length > 0;
            const paramOffset = hasResolvedUsers ? 2 : 1;
            const ilikeConditions = words
              .map((_, i) => `LOWER(raw) LIKE $${i + paramOffset}`)
              .join(' OR ');
            const ilikeParams = words.map((w) => `%${w}%`);
            const ilikeResults = poolOnlyMode
              ? await this.prisma.$queryRawUnsafe<{ id: string }[]>(
                  `SELECT m.id FROM memories m
                   WHERE m.id IN (
                     SELECT mpm.memory_id FROM memory_pool_memberships mpm
                     WHERE mpm.pool_id = ANY($1::text[])
                   )
                     AND (${words
                       .map((_, i) => `LOWER(m.raw) LIKE $${i + 2}`)
                       .join(' OR ')})
                     AND m.deleted_at IS NULL
                     AND m.superseded_by_id IS NULL
                     AND m.searchable IS NOT FALSE
                     AND m.embedding_status != 'DUPLICATE'
                     AND m.is_duplicate_of IS NULL
                   ORDER BY m.importance_score DESC, m.created_at DESC
                   LIMIT 20`,
                  poolIds,
                  ...ilikeParams,
                )
              : hasResolvedUsers
                ? await this.prisma.$queryRawUnsafe<{ id: string }[]>(
                    `SELECT id FROM memories
                   WHERE user_id = ANY($1::text[])
                     AND (${ilikeConditions})
                     AND deleted_at IS NULL
                     AND superseded_by_id IS NULL
                     AND searchable IS NOT FALSE
                     AND embedding_status != 'DUPLICATE'
                     AND is_duplicate_of IS NULL
                   ORDER BY importance_score DESC, created_at DESC
                   LIMIT 20`,
                    resolvedUserIds,
                    ...ilikeParams,
                  )
                : await this.prisma.$queryRawUnsafe<{ id: string }[]>(
                    `SELECT id FROM memories
                   WHERE (${ilikeConditions})
                     AND deleted_at IS NULL
                     AND superseded_by_id IS NULL
                     AND searchable IS NOT FALSE
                     AND embedding_status != 'DUPLICATE'
                     AND is_duplicate_of IS NULL
                   ORDER BY importance_score DESC, created_at DESC
                   LIMIT 20`,
                    ...ilikeParams,
                  );
            let ilikeAdded = 0;
            for (const row of ilikeResults) {
              ftsResultIds.add(row.id);
              keywordRescueIds.add(row.id);
              if (!scoreMap.has(row.id)) {
                scoreMap.set(row.id, 1.1);
                memoryIds.push(row.id);
                ilikeAdded++;
              } else {
                scoreMap.set(row.id, Math.max(scoreMap.get(row.id)!, 1.1));
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

        if (this.isIdentityProfileQuery(searchQuery) && !poolOnlyMode) {
          try {
            const identityResults = await this.prisma.memory.findMany({
              where: {
                ...(userIdFilter !== undefined ? { userId: userIdFilter } : {}),
                deletedAt: null,
                supersededById: null,
                searchable: { not: false },
                embeddingStatus: { not: EmbeddingStatus.DUPLICATE },
                isDuplicateOf: null,
                OR: [
                  { tags: { has: 'identity' } },
                  { tags: { has: 'work' } },
                  { tags: { has: 'career' } },
                  { raw: { contains: 'developer', mode: 'insensitive' } },
                  { raw: { contains: 'building', mode: 'insensitive' } },
                ],
                ...subjectTypeFilter,
                ...visibilityFilter,
                ...metadataFilter,
                ...temporalRangeFilter,
                ...sessionIdFilter,
                ...(dto.filterAgentId ? { agentId: dto.filterAgentId } : {}),
              },
              orderBy: [{ importanceScore: 'desc' }, { createdAt: 'desc' }],
              take: 10,
              select: { id: true },
            });
            let identityAdded = 0;
            for (const row of identityResults) {
              keywordRescueIds.add(row.id);
              if (!scoreMap.has(row.id)) {
                scoreMap.set(row.id, 1.15);
                memoryIds.push(row.id);
                identityAdded++;
              } else {
                scoreMap.set(row.id, Math.max(scoreMap.get(row.id)!, 1.15));
              }
            }
            if (identityAdded > 0) {
              this.logger.debug(
                `[Recall] identity rescue: injected ${identityAdded} candidates`,
              );
            }
          } catch (identityError) {
            this.logger.debug(
              `[Recall] identity rescue skipped: ${(identityError as Error).message}`,
            );
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
          embeddingStatus: { not: EmbeddingStatus.DUPLICATE },
          isDuplicateOf: null,
          ...(dto.filterAgentId ? { agentId: dto.filterAgentId } : {}),
          ...subjectTypeFilter,
          ...visibilityFilter,
          ...metadataFilter,
          ...temporalRangeFilter,
          ...sessionIdFilter,
        },
        include: { extraction: true },
      });

      const sorted = memories
        .map((memory) => {
          const semanticScore = scoreMap.get(memory.id) ?? 0;
          return {
            ...memory,
            score: semanticScore,
            __keywordRescued: keywordRescueIds.has(memory.id),
          } as MemoryWithScore;
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      const RERANK_POOL = sorted.length;

      const topIds = new Set(sorted.map((m) => m.id));
      const memoryMap = new Map(sorted.map((m) => [m.id, m]));
      for (const id of keywordRescueIds) {
        const mem = memoryMap.get(id);
        if (mem) keywordRescueMap.set(id, mem);
      }
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

    // Temporal H1+H2: first/earliest mention intent — sort ascending by event
    // time and skip usage boost (which would bury old cold memories).
    if (parsed.firstMentionIntent) {
      scoredMemories = scoredMemories.sort((a, b) => {
        const ta = ((a as any).observedAt ?? a.createdAt) as Date;
        const tb = ((b as any).observedAt ?? b.createdAt) as Date;
        return new Date(ta).getTime() - new Date(tb).getTime();
      });
    }

    // ── ENG-27: Usage-Weighted Re-ranking ────────────────────────────
    // Skip usage boost for first-mention queries — the oldest memory is by
    // definition cold (never accessed) but it IS the right answer.
    try {
      if (!parsed.firstMentionIntent) {
        scoredMemories =
          await this.rankingService.applyUsageWeighting(scoredMemories);
      }
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
      {
        allow: allowInsightSurfacing,
        where: allowInsightSurfacing
          ? this.buildInsightSurfacingWhere(
              userIdFilter,
              dto,
              subjectTypeFilter,
              visibilityFilter,
              metadataFilter,
              sessionIdFilter,
              temporalRangeFilter,
            )
          : undefined,
      },
    );

    // ── ENG-29: Cross-Encoder Reranking ──────────────────────────
    const rerankQuery = hasTemporalIntent ? dto.query : searchQuery;
    scoredMemories = await this.rankingService.applyReranking(
      scoredMemories,
      rerankQuery,
      limit,
    );

    // Exact keyword/ILIKE rescued memories are deterministic high-signal hits.
    // Keep them sticky after reranking so the cross-encoder cannot drop fresh
    // exact-match writes from the final top-N.
    const missingKeywordHits = [...keywordRescueMap.entries()]
      .filter(([id]) => !scoredMemories.some((m) => m.id === id))
      .map(
        ([, mem]) =>
          ({ ...mem, score: Math.max(mem.score ?? 0, 1.1) }) as MemoryWithScore,
      );
    if (missingKeywordHits.length > 0) {
      scoredMemories = [...missingKeywordHits, ...scoredMemories]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit);
    }

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

    let result: MemoryWithScore[] = this.filterRecallSurvivors(scoredMemories);
    if (dto.includeChains) {
      result = ((await this.memoryFailureService?.attachChains(result)) ??
        result) as MemoryWithScore[];
      result = this.filterRecallSurvivors(result);
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

    result = this.filterRecallSurvivors(result);

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
    const sessionIdFilterMQ = this.buildSessionIdFilter(dto);

    const memories = await this.prisma.memory.findMany({
      where: {
        id: { in: memoryIds },
        deletedAt: null,
        supersededById: null,
        searchable: { not: false },
        embeddingStatus: { not: EmbeddingStatus.DUPLICATE },
        isDuplicateOf: null,
        ...subjectTypeFilter,
        ...visibilityFilterMQ,
        ...metadataFilterMQ,
        ...sessionIdFilterMQ,
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

    // Apply the same post-processing chain as the standard path so multi-query
    // is not silently downgraded to cosine-only ranking (retrieval H4), then
    // enforce survivor filtering again after graph/insight/rerank additions.
    let postProcessedMQ: MemoryWithScore[] = scoredMemories;
    try {
      postProcessedMQ =
        await this.rankingService.applyUsageWeighting(postProcessedMQ);
    } catch (err) {
      this.logger.warn(
        `[MultiQuery] Usage weighting failed: ${(err as Error)?.message}`,
      );
    }
    try {
      postProcessedMQ = await this.rankingService.mergeGraphResults(
        postProcessedMQ,
        dto.query,
        Array.isArray(userId)
          ? (userId[0] ?? 'default')
          : (userId ?? 'default'),
        dto.limit ?? 10,
      );
    } catch (err) {
      this.logger.warn(
        `[MultiQuery] Graph recall merge failed: ${(err as Error)?.message}`,
      );
    }
    const mqUserIds = Array.isArray(userId) ? userId : userId ? [userId] : [];
    postProcessedMQ = await this.rankingService.surfaceInsights(
      postProcessedMQ,
      mqUserIds,
      dto.query,
      dto.limit ?? 10,
    );
    postProcessedMQ = await this.rankingService.applyReranking(
      postProcessedMQ,
      dto.query,
      dto.limit ?? 10,
    );

    let result: MemoryWithScore[] = this.filterRecallSurvivors(postProcessedMQ);
    if (dto.includeChains) {
      result = ((await this.memoryFailureService?.attachChains(result)) ??
        result) as MemoryWithScore[];
      result = this.filterRecallSurvivors(result);
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

    result = this.filterRecallSurvivors(result);

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

  private extractLexicalRescueTerms(query: string): string[] {
    const stopWords = new Set([
      'about',
      'does',
      'doing',
      'have',
      'mine',
      'need',
      'tell',
      'that',
      'this',
      'what',
      'when',
      'where',
      'which',
      'whose',
      'with',
      'your',
    ]);

    return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
      .filter((word) => word.length >= 4 && !stopWords.has(word))
      .slice(0, 8);
  }

  private isIdentityProfileQuery(query: string): boolean {
    const normalized = query.toLowerCase();
    return (
      /who\s+am\s+i/.test(normalized) ||
      /what\s+do\s+i\s+do/.test(normalized) ||
      /what\s+am\s+i\s+building/.test(normalized)
    );
  }

  private filterRecallSurvivors<T extends MemoryWithScore>(memories: T[]): T[] {
    return memories.filter((memory) => {
      const embeddingStatus = (memory as any).embeddingStatus;
      return (
        embeddingStatus !== EmbeddingStatus.DUPLICATE &&
        (memory as any).isDuplicateOf == null &&
        (memory as any).supersededById == null &&
        (memory as any).deletedAt == null &&
        (memory as any).searchable !== false
      );
    });
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
   * HEY-578: Build Prisma WHERE clause for sessionId filter.
   *
   * Clients pass EXTERNAL session IDs (e.g. "lme-e47becba"), but
   * memories.sessionId stores the INTERNAL session cuid. Filter via the
   * Session relation so EITHER the internal id OR the external id matches.
   */
  buildSessionIdFilter(dto: QueryMemoryDto): Record<string, any> {
    if (!dto.sessionId) return {};
    return {
      session: {
        OR: [{ id: dto.sessionId }, { externalId: dto.sessionId }],
      },
    };
  }

  buildInsightSurfacingWhere(
    userIdFilter: string | { in: string[] } | undefined,
    dto: QueryMemoryDto,
    subjectTypeFilter: Record<string, any>,
    visibilityFilter: Record<string, any>,
    metadataFilter: Record<string, any>,
    sessionIdFilter: Record<string, any>,
    temporalRangeFilter: Record<string, any>,
  ): Record<string, any> {
    const recentCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const explicitCreatedAt = temporalRangeFilter.createdAt ?? {};
    const createdAt: Record<string, any> = {
      gte:
        explicitCreatedAt.gte && explicitCreatedAt.gte > recentCutoff
          ? explicitCreatedAt.gte
          : recentCutoff,
    };

    if (explicitCreatedAt.lte) {
      createdAt.lte = explicitCreatedAt.lte;
    }

    return {
      ...(userIdFilter !== undefined ? { userId: userIdFilter } : {}),
      layer: MemoryLayer.INSIGHT,
      deletedAt: null,
      supersededById: null,
      searchable: { not: false },
      embeddingStatus: { not: EmbeddingStatus.DUPLICATE },
      isDuplicateOf: null,
      importanceScore: { gte: 0.6 },
      createdAt,
      ...subjectTypeFilter,
      ...visibilityFilter,
      ...metadataFilter,
      ...sessionIdFilter,
      ...(dto.filterAgentId ? { agentId: dto.filterAgentId } : {}),
    };
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
