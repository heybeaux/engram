import { Injectable, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import {
  ContextualRecallDto,
  ContextualRecallResponseDto,
  DelegationContextDto,
} from './dto/contextual-recall.dto';
import { MemoryPoolService } from '../memory-pool/memory-pool.service';
import { MemoryAccessLogService } from '../memory-access-log/memory-access-log.service';
import { TemporalParserService } from './temporal/temporal-parser.service';

interface SessionState {
  recentEmbeddings: number[][]; // last N message embeddings
  recalledIds: Set<string>;
  lastRecallAt: number;
  recallCount: number;
}

@Injectable()
export class ContextualRecallService {
  private readonly logger = new Logger(ContextualRecallService.name);
  // ⚠️ Ephemeral session state — resets on restart. Flagged for DB persistence in M-6. (HEY-346 triage)
  private sessions = new Map<string, SessionState>();
  private lastSweep = Date.now();

  // HEY-361: Session TTL — evict sessions idle for more than 1 hour
  private readonly SESSION_TTL_MS = 60 * 60 * 1000;
  private readonly SWEEP_INTERVAL_MS = 5 * 60 * 1000; // sweep every 5 min

  // Cosine distance threshold for topic shift detection
  private readonly TOPIC_SHIFT_THRESHOLD = 0.4;
  // Max recent embeddings to keep per session
  private readonly MAX_RECENT_EMBEDDINGS = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    @Optional() private readonly memoryPoolService?: MemoryPoolService,
    @Optional()
    private readonly memoryAccessLogService?: MemoryAccessLogService,
    @Optional() private readonly temporalParser?: TemporalParserService,
  ) {}

  async recall(
    userId: string | string[] | null,
    dto: ContextualRecallDto,
  ): Promise<ContextualRecallResponseDto> {
    const startTime = Date.now();
    const session = this.getOrCreateSession(dto.sessionKey);

    // 1. Generate embedding for the incoming text
    const queryEmbedding = await this.embedding.generate(dto.text);

    // 2. Detect topic shift
    const topicShift = this.detectTopicShift(queryEmbedding, session);

    // Store this embedding for future comparisons
    session.recentEmbeddings.push(queryEmbedding);
    if (session.recentEmbeddings.length > this.MAX_RECENT_EMBEDDINGS) {
      session.recentEmbeddings.shift();
    }

    // 3. If no topic shift, return empty (no recall needed)
    if (!topicShift) {
      return {
        memories: [],
        topicShift: false,
        tokenCount: 0,
        latencyMs: Date.now() - startTime,
      };
    }

    // v0.7: Resolve accessible pool IDs
    let poolIds: string[] | undefined;
    if (dto.agentSessionKey && this.memoryPoolService) {
      try {
        const singleUserId = Array.isArray(userId) ? userId[0] : userId;
        poolIds = await this.memoryPoolService.getAccessiblePoolIds(
          dto.agentSessionKey,
          singleUserId ?? 'default',
        );
      } catch (err) {
        this.logger.warn('[ContextualRecall] Failed to resolve pool IDs:', err);
      }
    }

    // HEY-575: Parse temporal intent and build a createdAt filter
    let temporalCreatedAt: { gte?: Date; lte?: Date } | undefined;
    let semanticText = dto.text;
    if (this.temporalParser) {
      const parsed = this.temporalParser.parse(dto.text, new Date());
      if (parsed.temporalFilter) {
        temporalCreatedAt = {
          gte: parsed.temporalFilter.start,
          lte: parsed.temporalFilter.end,
        };
        semanticText = parsed.semanticQuery;
        this.logger.log('[ContextualRecall] Temporal intent detected:', {
          expression: parsed.temporalFilter.expression,
          start: parsed.temporalFilter.start.toISOString(),
          end: parsed.temporalFilter.end.toISOString(),
        });
      }
    }

    // 4. Semantic search
    const limit = dto.maxResults ?? 5;
    const minScore = dto.minScore ?? 0.35;
    const excludeSet = new Set([
      ...(dto.excludeIds ?? []),
      ...session.recalledIds,
    ]);

    // Re-embed with temporal-stripped semantic query if applicable
    const searchEmbedding =
      semanticText !== dto.text
        ? await this.embedding.generate(semanticText)
        : queryEmbedding;

    const vectorResults = await this.embedding.search(
      userId ?? 'default',
      searchEmbedding,
      limit + excludeSet.size, // over-fetch to account for filtering
      undefined,
      undefined,
      poolIds,
    );

    // HEY-189: If delegation context provided, fetch delegator's memories and merge
    let delegatorMemoryIds: Set<string> | undefined;
    const boostFactor = dto.delegationContext?.boostFactor ?? 1.5;
    if (dto.delegationContext) {
      delegatorMemoryIds = await this.getDelegatorMemoryIds(
        dto.delegationContext,
        userId ?? 'default',
      );
    }

    // 5. Filter: exclude already-known IDs, apply score threshold
    this.logger.log(
      `[ContextualRecall] vectorResults: ${vectorResults.length}, scores: [${vectorResults
        .slice(0, 5)
        .map((r) => r.score.toFixed(3))
        .join(', ')}], minScore: ${minScore}`,
    );
    // Filter by minimum score and exclusions, apply delegation boost
    const candidates = vectorResults
      .filter((r) => r.score >= minScore && !excludeSet.has(r.id))
      .map((r) => ({
        ...r,
        score:
          delegatorMemoryIds && delegatorMemoryIds.has(r.id)
            ? Math.min(r.score * boostFactor, 1.0)
            : r.score,
      }))
      .sort((a, b) => b.score - a.score);

    // Apply relative score gap: drop results scoring < 70% of the top result.
    // This prunes irrelevant tail results that pass the absolute floor but are
    // much weaker than the best match, improving precision without hurting recall.
    const topScore = candidates.length > 0 ? candidates[0].score : 0;
    const scoreFloor = topScore * 0.7;
    const filteredIds = candidates
      .filter((r) => r.score >= scoreFloor)
      .slice(0, limit)
      .map((r) => ({ id: r.id, score: r.score }));

    if (filteredIds.length === 0) {
      return {
        memories: [],
        topicShift: true,
        tokenCount: 0,
        latencyMs: Date.now() - startTime,
      };
    }

    // 6. Fetch full memory records (apply temporal filter if present)
    const scoreMap = new Map(filteredIds.map((r) => [r.id, r.score]));
    const memories = await this.prisma.memory.findMany({
      where: {
        id: { in: filteredIds.map((r) => r.id) },
        deletedAt: null,
        supersededById: null,
        searchable: { not: false },
        ...(temporalCreatedAt ? { createdAt: temporalCreatedAt } : {}),
      },
      include: {
        extraction: true,
      },
    });

    // 7. Build response, respecting token budget
    const maxTokens = dto.maxTokens ?? 500;
    let tokenCount = 0;
    const result: ContextualRecallResponseDto['memories'] = [];

    // Sort by score descending
    const sorted = memories.sort(
      (a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0),
    );

    for (const memory of sorted) {
      const rawText = memory.raw;
      const approxTokens = Math.ceil(rawText.length / 4); // rough estimate
      if (tokenCount + approxTokens > maxTokens && result.length > 0) break;

      result.push({
        id: memory.id,
        raw: rawText,
        layer: memory.layer,
        score: scoreMap.get(memory.id) ?? 0,
        topics: memory.extraction?.topics ?? [],
      });
      tokenCount += approxTokens;
      session.recalledIds.add(memory.id);
    }

    // Update session state
    session.lastRecallAt = Date.now();
    session.recallCount++;

    // Update retrieval counts
    const resultIds = result.map((m) => m.id);
    if (resultIds.length > 0) {
      await this.prisma.memory.updateMany({
        where: { id: { in: resultIds } },
        data: {
          retrievalCount: { increment: 1 },
          lastRetrievedAt: new Date(),
        },
      });

      // v0.7: Log recalled memories (fire-and-forget)
      if (dto.agentSessionKey && this.memoryAccessLogService) {
        this.memoryAccessLogService
          .logRecalled(resultIds, dto.agentSessionKey, dto.text)
          .catch(() => {});
      }
    }

    return {
      memories: result,
      topicShift: true,
      tokenCount,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Detect topic shift by comparing current embedding against recent embeddings.
   * Returns true if cosine distance > threshold (meaning topics diverged).
   */
  private detectTopicShift(
    currentEmbedding: number[],
    session: SessionState,
  ): boolean {
    if (session.recentEmbeddings.length === 0) {
      // First message in session — treat as topic shift to seed context
      return true;
    }

    // Compare against the most recent embedding
    const lastEmbedding =
      session.recentEmbeddings[session.recentEmbeddings.length - 1];
    const similarity = this.cosineSimilarity(currentEmbedding, lastEmbedding);
    const distance = 1 - similarity;

    return distance > this.TOPIC_SHIFT_THRESHOLD;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  private getOrCreateSession(sessionKey: string): SessionState {
    // HEY-361: Periodic sweep of stale sessions
    this.sweepStaleSessions();

    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = {
        recentEmbeddings: [],
        recalledIds: new Set(),
        lastRecallAt: 0,
        recallCount: 0,
      };
      this.sessions.set(sessionKey, session);
    }
    // Track last access for TTL eviction
    session.lastRecallAt = Date.now();
    return session;
  }

  /**
   * HEY-361: Evict sessions that haven't been accessed within TTL.
   * Runs at most once per SWEEP_INTERVAL_MS to avoid perf overhead.
   */
  private sweepStaleSessions(): void {
    const now = Date.now();
    if (now - this.lastSweep < this.SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;

    let evicted = 0;
    for (const [key, session] of this.sessions) {
      if (now - session.lastRecallAt > this.SESSION_TTL_MS) {
        this.sessions.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.logger.debug(
        `[SessionTTL] Evicted ${evicted} stale sessions, ${this.sessions.size} remaining`,
      );
    }
  }

  /**
   * Clean up session state (call on session end)
   */
  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  /**
   * HEY-189: Get memory IDs associated with the delegating agent's session.
   * These memories get a score boost so the delegatee surfaces the delegator's context.
   */
  private async getDelegatorMemoryIds(
    delegation: DelegationContextDto,
    userId: string | string[],
  ): Promise<Set<string>> {
    const singleUserId = Array.isArray(userId) ? userId[0] : userId;

    // Find memories created/accessed by the delegating agent session
    const accessLogs = await this.prisma.memoryAccessLog.findMany({
      where: {
        agentSession: {
          sessionKey: delegation.delegatingAgentSessionKey,
        },
        accessType: { in: ['CREATED', 'READ', 'RECALLED'] },
      },
      select: { memoryId: true },
      take: 200,
    });

    const ids = new Set(accessLogs.map((l) => l.memoryId));

    // Also include memories created by the delegator's session directly
    const createdMemories = await this.prisma.memory.findMany({
      where: {
        createdBySession: delegation.delegatingAgentSessionKey,
        userId: singleUserId,
        deletedAt: null,
      },
      select: { id: true },
      take: 200,
    });

    for (const m of createdMemories) {
      ids.add(m.id);
    }

    return ids;
  }
}
