import { Injectable, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { EmbeddingStatus, Memory, MemoryLayer } from '@prisma/client';
import { MemoryWithScore } from './memory.types';
import { RecallWeightService } from './recall-weight.service';
import { RerankService } from '../embedding/rerank.service';
import { GraphRecallService } from './graph-recall.service';
import { SentimentService } from './sentiment.service';

export interface InsightSurfacingOptions {
  allow?: boolean;
  where?: Record<string, any>;
}

@Injectable()
export class MemoryQueryRankingService {
  private readonly logger = new Logger(MemoryQueryRankingService.name);

  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
    private recallWeightService: RecallWeightService,
    @Optional() private rerankService?: RerankService,
    @Optional() private graphRecallService?: GraphRecallService,
  ) {}

  private isRecallSurvivor(memory: Partial<Memory>): boolean {
    return (
      (memory as any).embeddingStatus !== EmbeddingStatus.DUPLICATE &&
      (memory as any).isDuplicateOf == null &&
      (memory as any).supersededById == null &&
      (memory as any).deletedAt == null &&
      (memory as any).searchable !== false
    );
  }

  /**
   * Importance-based noise penalty.
   * Only penalises very-low-importance (< 0.35) memories such as alice_misc_gen_*
   * which are seeded with a fixed importanceScore of 0.3.
   * Everything else is left neutral — the cross-encoder reranker handles the rest
   * once it can see the full 100-candidate pool.
   */
  getImportanceMultiplier(memory: Memory): number {
    const importance = ((memory as any).importanceScore as number) ?? 0.5;
    return importance < 0.35 ? 0.4 : 1.0;
  }

  /**
   * ENG-27: Apply usage-weighted re-ranking.
   * Uses retrievalCount + usedCount + recency + feedback to boost
   * memories that are frequently used and recently accessed.
   */
  async applyUsageWeighting(
    scoredMemories: MemoryWithScore[],
  ): Promise<MemoryWithScore[]> {
    const withScores = scoredMemories.map((m) => ({
      ...m,
      score: m.score ?? 0,
    }));
    const usageWeighted =
      await this.recallWeightService.applyUsageWeighting(withScores);
    return usageWeighted as MemoryWithScore[];
  }

  /**
   * ENG-32: Merge graph recall results into scored memories.
   * Boosts memories that appear in both vector and graph results.
   */
  async mergeGraphResults(
    scoredMemories: MemoryWithScore[],
    query: string,
    userId: string,
    limit: number,
  ): Promise<MemoryWithScore[]> {
    if (!this.graphRecallService) return scoredMemories;

    const graphMemories = await this.graphRecallService.recallViaGraph(
      query,
      userId,
      limit,
    );
    if (graphMemories.length === 0) return scoredMemories;

    const existingIds = new Set(scoredMemories.map((m) => m.id));
    for (const gm of graphMemories) {
      if (!this.isRecallSurvivor(gm)) continue;

      if (existingIds.has(gm.id)) {
        // Boost memories that appear in both vector and graph results
        const idx = scoredMemories.findIndex((m) => m.id === gm.id);
        if (idx !== -1 && scoredMemories[idx].score != null) {
          scoredMemories[idx].score *= 1.2;
        }
      } else {
        scoredMemories.push(gm);
      }
    }
    scoredMemories.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return scoredMemories;
  }

  /**
   * Surface relevant INSIGHT memories by injecting them into recall results.
   *
   * Finds unacknowledged, high-confidence insights and boosts their score
   * so they appear near the top of results. Insights that aren't semantically
   * relevant to the current query are excluded.
   */
  async surfaceInsights(
    existingResults: MemoryWithScore[],
    userIds: string[],
    query: string,
    limit: number,
    cachedQueryEmbedding?: number[],
    options?: InsightSurfacingOptions,
  ): Promise<MemoryWithScore[]> {
    try {
      if (options?.allow === false) return existingResults;

      const where = options?.where ?? {
        userId: { in: userIds },
        layer: 'INSIGHT',
        deletedAt: null,
        supersededById: null,
        searchable: { not: false },
        embeddingStatus: { not: EmbeddingStatus.DUPLICATE },
        isDuplicateOf: null,
        importanceScore: { gte: 0.6 },
        createdAt: { gt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
      };

      // Find recent, high-confidence INSIGHT memories
      const insights = await this.prisma.memory.findMany({
        where,
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
        if (!this.isRecallSurvivor(insight as any)) continue;

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
      const merged = [...existingResults, ...relevantInsights].sort(
        (a, b) => (b.score ?? 0) - (a.score ?? 0),
      );

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
  applyReranking(
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
      return Promise.resolve(applyFallbackBlend(memories));
    }

    // Strip RLS canary prefix (RLS_CANARY_ALICE_B1: …) and bare counter prefix (107: …)
    // so the cross-encoder sees clean semantic content
    const stripCanary = (raw: string): string =>
      raw.replace(/^RLS_CANARY_[A-Z0-9_]+\d*:\s*/i, '').replace(/^\w+:\s+/, ''); // strip any remaining "TOKEN: " prefix

    const candidates = memories;
    const texts = candidates.map((m) => stripCanary(m.raw));

    return this.rerankService
      .rerank(query, texts)
      .then((ranked) => {
        // If all scores are 0, reranker was disabled or failed — apply fallback blend
        const hasScores = ranked.some((r) => r.score > 0);
        if (!hasScores) return applyFallbackBlend(memories);

        // Post-reranker final blend: rerankerScore * 0.85 + importanceScore * 0.15 + sentiment penalty
        const reranked = ranked
          .map((r) => {
            const mem = candidates[r.index];
            const importanceScore =
              (mem as any).effectiveScore ??
              (mem as any).importanceScore ??
              0.5;
            const sp = SentimentService.scorePenalty(
              query,
              (mem as any).raw ?? '',
            );
            const finalScore = (r.score * 0.85 + importanceScore * 0.15) * sp;
            return { ...mem, score: finalScore };
          })
          .slice(0, limit);

        this.logger.debug(
          `[Recall] Cross-encoder reranked ${candidates.length} candidates → top ${reranked.length}`,
        );

        return reranked;
      })
      .catch((error) => {
        this.logger.warn(
          `[Recall] Reranking failed, using original order: ${(error as Error).message}`,
        );
        return applyFallbackBlend(memories);
      });
  }
}
