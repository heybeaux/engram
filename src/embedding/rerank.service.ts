import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RerankResult {
  index: number;
  score: number;
}

const RRF_K = 60;

@Injectable()
export class RerankService {
  private readonly logger = new Logger(RerankService.name);
  private readonly rerankUrls: string[];
  private readonly modelWeights: number[];
  private readonly enabled: boolean;
  // Generous timeout for CPU-based rerankers on shared CI runners.
  // 120 candidates × 2 models on CPU can take 3–8 seconds.
  private readonly timeoutMs = 10_000;

  constructor(private configService: ConfigService) {
    const multiUrls = this.configService.get<string>('RERANK_URLS', '');
    const singleUrl = this.configService.get<string>(
      'RERANK_URL',
      'http://localhost:8081',
    );
    this.rerankUrls = multiUrls
      ? multiUrls.split(',').map((u) => u.trim()).filter(Boolean)
      : [singleUrl];

    const weightsStr = this.configService.get<string>('RERANK_MODEL_WEIGHTS', '');
    this.modelWeights = weightsStr
      ? weightsStr.split(',').map((w) => parseFloat(w.trim()) || 1.0)
      : this.rerankUrls.map(() => 1.0);

    this.enabled =
      this.configService.get<string>('RERANK_ENABLED', 'false') === 'true';
  }

  /**
   * Rerank texts by relevance to a query.
   * With multiple endpoints, uses Reciprocal Rank Fusion (RRF) to combine rankings.
   * Gracefully falls back to original order on failure.
   */
  async rerank(query: string, texts: string[]): Promise<RerankResult[]> {
    if (!this.enabled) {
      this.logger.debug('[Rerank] Disabled via RERANK_ENABLED=false, skipping');
      return texts.map((_, index) => ({ index, score: 0 }));
    }

    if (texts.length === 0) {
      return [];
    }

    const start = Date.now();

    if (this.rerankUrls.length === 1) {
      return this.rerankSingle(this.rerankUrls[0], query, texts, start);
    }

    return this.rerankEnsemble(query, texts, start);
  }

  /**
   * Single-model reranking (original behaviour).
   */
  private async rerankSingle(
    url: string,
    query: string,
    texts: string[],
    start: number,
  ): Promise<RerankResult[]> {
    try {
      const results = await this.fetchRankings(url, query, texts);
      const latencyMs = Date.now() - start;
      this.logger.debug(`[Rerank] Single model completed in ${latencyMs}ms`);
      return results;
    } catch (error) {
      this.logger.warn(
        `[Rerank] Single model failed, returning original order: ${(error as Error).message}`,
      );
      return texts.map((_, index) => ({ index, score: 0 }));
    }
  }

  /**
   * Multi-model reranking via Reciprocal Rank Fusion (RRF).
   * score(doc) = Σ weight_i / (k + rank_i(doc))
   */
  private async rerankEnsemble(
    query: string,
    texts: string[],
    start: number,
  ): Promise<RerankResult[]> {
    const results = await Promise.allSettled(
      this.rerankUrls.map((url) => this.fetchRankings(url, query, texts)),
    );

    const successful: Array<{ rankings: RerankResult[]; weight: number }> = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        successful.push({
          rankings: result.value,
          weight: this.modelWeights[i] ?? 1.0,
        });
      } else {
        this.logger.warn(
          `[Rerank] Model ${i + 1} (${this.rerankUrls[i]}) failed: ${result.reason?.message}`,
        );
      }
    });

    if (successful.length === 0) {
      this.logger.warn('[Rerank] All models failed, returning original order');
      return texts.map((_, index) => ({ index, score: 0 }));
    }

    if (successful.length === 1) {
      const latencyMs = Date.now() - start;
      this.logger.debug(`[Rerank] 1/${this.rerankUrls.length} models succeeded in ${latencyMs}ms`);
      return successful[0].rankings;
    }

    // Apply RRF across all successful model rankings
    const rrfScores = new Map<number, number>();
    for (let docIndex = 0; docIndex < texts.length; docIndex++) {
      rrfScores.set(docIndex, 0);
    }

    for (const { rankings, weight } of successful) {
      // Build rank map: docIndex → 1-based rank position
      const rankMap = new Map<number, number>();
      rankings.forEach((r, rankPosition) => {
        rankMap.set(r.index, rankPosition + 1);
      });

      for (const [docIndex] of rrfScores) {
        const rank = rankMap.get(docIndex) ?? texts.length + 1;
        const contribution = weight / (RRF_K + rank);
        rrfScores.set(docIndex, (rrfScores.get(docIndex) ?? 0) + contribution);
      }
    }

    const fused: RerankResult[] = Array.from(rrfScores.entries())
      .map(([index, score]) => ({ index, score }))
      .sort((a, b) => b.score - a.score);

    const latencyMs = Date.now() - start;
    this.logger.debug(
      `[Rerank] RRF ensemble (${successful.length}/${this.rerankUrls.length} models) completed in ${latencyMs}ms`,
    );

    return fused;
  }

  /**
   * Fetch rankings from a single reranker endpoint with timeout.
   */
  private async fetchRankings(
    url: string,
    query: string,
    texts: string[],
  ): Promise<RerankResult[]> {
    const response = await Promise.race([
      fetch(`${url}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, texts, raw_scores: false }),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Rerank request to ${url} timed out`)),
          this.timeoutMs,
        ),
      ),
    ]);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Rerank API error from ${url}: ${response.status} - ${error}`);
    }

    return response.json() as Promise<RerankResult[]>;
  }

  /**
   * Check if at least one reranker endpoint is reachable.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.enabled) return false;

    const checks = await Promise.allSettled(
      this.rerankUrls.map(async (url) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(`${url}/health`, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(timeout);
        return response.ok;
      }),
    );

    return checks.some(
      (r) => r.status === 'fulfilled' && r.value === true,
    );
  }
}
