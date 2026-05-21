import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueryType, RetrievalSignalType } from '@prisma/client';

export interface LogQueryInput {
  accountId: string;
  queryText: string;
  queryType?: QueryType;
  strategyConfig?: Record<string, any>;
  resultCount: number;
  latencyMs: number;
  armId?: string;
}

export interface LogSignalInput {
  accountId: string;
  queryId: string;
  memoryId?: string;
  signalType: RetrievalSignalType;
  weight: number;
  strategyId?: string;
  rank?: number;
  propensity?: number;
  metadata?: Record<string, any>;
}

@Injectable()
export class RetrievalSignalsService {
  private readonly logger = new Logger(RetrievalSignalsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Log a retrieval query execution for signal attribution and latency tracking.
   * Returns the generated queryId (cuid).
   */
  async logQuery(input: LogQueryInput): Promise<string> {
    const queryType =
      input.queryType ?? this.classifyQueryType(input.queryText);

    const log = await this.prisma.retrievalLog.create({
      data: {
        accountId: input.accountId,
        queryText: input.queryText,
        queryType,
        strategyConfig: input.strategyConfig ?? undefined,
        resultCount: input.resultCount,
        latencyMs: input.latencyMs,
        armId: input.armId,
      },
    });

    return log.id;
  }

  /**
   * Record a retrieval signal (implicit or explicit feedback).
   */
  async logSignal(input: LogSignalInput): Promise<string> {
    const signal = await this.prisma.retrievalSignal.create({
      data: {
        accountId: input.accountId,
        queryId: input.queryId,
        memoryId: input.memoryId,
        signalType: input.signalType,
        weight: input.weight,
        strategyId: input.strategyId,
        rank: input.rank,
        propensity: input.propensity,
        metadata: input.metadata ?? undefined,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days TTL
      },
    });

    return signal.id;
  }

  /**
   * Fetch recent retrieval queries for an account, with their attached signals.
   * Used by Ginnung cockpit to render the Engram panel's "recent retrievals" view.
   *
   * Note: per-result similarity scores live in the original query response
   * (X-Query-Id header → `memories[*].score`) and are NOT persisted at retrieval
   * time. Signals returned here are feedback + downstream-behavior events.
   */
  async getRecentQueries(
    accountId: string,
    options: { limit?: number; since?: Date } = {},
  ): Promise<
    Array<{
      queryId: string;
      queryText: string;
      queryType: string | null;
      resultCount: number;
      latencyMs: number;
      createdAt: Date;
      signals: Array<{
        memoryId: string | null;
        rank: number | null;
        weight: number;
        signalType: string;
        propensity: number | null;
        createdAt: Date;
      }>;
    }>
  > {
    const take = Math.min(options.limit ?? 20, 100);

    const logs = await this.prisma.retrievalLog.findMany({
      where: {
        accountId,
        ...(options.since ? { createdAt: { gte: options.since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    if (logs.length === 0) return [];

    const signals = await this.prisma.retrievalSignal.findMany({
      where: {
        accountId,
        queryId: { in: logs.map((l) => l.id) },
      },
      orderBy: { rank: 'asc' },
    });

    const signalsByQuery = new Map<string, typeof signals>();
    for (const s of signals) {
      const bucket = signalsByQuery.get(s.queryId) ?? [];
      bucket.push(s);
      signalsByQuery.set(s.queryId, bucket);
    }

    return logs.map((log) => ({
      queryId: log.id,
      queryText: log.queryText,
      queryType: log.queryType,
      resultCount: log.resultCount,
      latencyMs: log.latencyMs,
      createdAt: log.createdAt,
      signals: (signalsByQuery.get(log.id) ?? []).map((s) => ({
        memoryId: s.memoryId,
        rank: s.rank,
        weight: s.weight,
        signalType: s.signalType,
        propensity: s.propensity,
        createdAt: s.createdAt,
      })),
    }));
  }

  /**
   * Compute propensity score p(item_i at position_k) for IPS correction.
   * Under static RRF with fixed weights, propensity is approximated as
   * 1/(k + rank) normalized by the total number of results.
   */
  computePropensity(
    rank: number,
    resultCount: number,
    rrfK: number = 60,
  ): number {
    if (resultCount === 0) return 0;
    // Propensity = probability of item appearing at this rank
    // Under RRF: score(d) = 1/(k + rank). Normalize across result set.
    const rawScore = 1 / (rrfK + rank);
    const totalMass = Array.from(
      { length: resultCount },
      (_, i) => 1 / (rrfK + i),
    ).reduce((sum, s) => sum + s, 0);
    return rawScore / totalMass;
  }

  /**
   * Classify a query into one of 3 buckets: FACTUAL, SEMANTIC, or TEMPORAL.
   *
   * Heuristic rules:
   * - TEMPORAL: query contains temporal expressions (yesterday, last week, dates, etc.)
   * - FACTUAL: query is short and contains mostly nouns/proper nouns or question words
   * - SEMANTIC: everything else (conversational, abstract queries)
   */
  classifyQueryType(queryText: string): QueryType {
    const lower = queryText.toLowerCase().trim();

    // Temporal indicators
    const temporalPatterns = [
      /\b(yesterday|today|tomorrow|last\s+(week|month|year|night|time))\b/,
      /\b(this\s+(week|month|year|morning|afternoon|evening))\b/,
      /\b(recent(ly)?|latest|newest|earlier|before|after|since|ago|during)\b/,
      /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/, // date patterns
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/,
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
      /\b(when\s+did|when\s+was|how\s+long\s+ago)\b/,
    ];
    for (const pattern of temporalPatterns) {
      if (pattern.test(lower)) {
        return QueryType.TEMPORAL;
      }
    }

    // Factual indicators: short queries with question words targeting specific facts
    const factualPatterns = [
      /^(what|who|where|which|how\s+many|how\s+much)\b/,
      /\b(name|number|address|email|phone|date|price|cost|amount)\b/,
      /\b(zip\s*code|error\s*code|status\s*code|version\s*(number|id)?)\b/,
    ];
    const words = lower.split(/\s+/);
    if (words.length <= 6) {
      for (const pattern of factualPatterns) {
        if (pattern.test(lower)) {
          return QueryType.FACTUAL;
        }
      }
    }

    // Default: semantic (conversational, abstract)
    return QueryType.SEMANTIC;
  }
}
