import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { LLMService } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { MessageTurnDto } from '../auto/dto/observe.dto';
import { SummaryFact, SummarizeResult } from './dto/summarize.dto';
import { MemoryLayer, MemorySource } from '@prisma/client';

const REDIS_KEY_PREFIX = 'engram:summ:';
const TURNS_KEY = (sid: string) => `${REDIS_KEY_PREFIX}turns:${sid}`;
const USER_KEY = (sid: string) => `${REDIS_KEY_PREFIX}user:${sid}`;
/** TTL for turn buffer keys — 24 h (prevents orphan keys) */
const BUFFER_TTL_SECONDS = 86_400;

const SUMMARIZATION_PROMPT = `You are a conversation summarization system. Given conversation turns, extract key information worth remembering for future sessions.

Extract these categories:
- "fact": Stable information about the user or their world (relationships, location, job, etc.)
- "decision": A decision that was made during the conversation
- "preference": A preference the user expressed (likes, dislikes, how they want things done)
- "action_item": Something that needs to be done (tasks, reminders, commitments)

For each extracted item, provide:
- content: A concise, standalone statement that makes sense without conversation context
- category: One of: fact, decision, preference, action_item
- confidence: 0.0-1.0 how confident you are this is worth remembering
- sourceTurnIndices: Array of turn indices (0-indexed) this was derived from

Rules:
- Make statements standalone — they should be useful months later
- Use the user's actual name if known, never "User" or "the user"
- Merge related information into single coherent statements
- Skip small talk, greetings, and transient information
- Focus on information that would change how you interact with this person

Output valid JSON: { "facts": [...] }
If nothing worth remembering, return { "facts": [] }`;

interface LLMSummarizationResponse {
  facts: Array<{
    content: string;
    category: string;
    confidence: number;
    sourceTurnIndices: number[];
  }>;
}

@Injectable()
export class SummarizationService implements OnModuleDestroy {
  private readonly logger = new Logger(SummarizationService.name);
  private enabled: boolean;
  private batchSize: number;
  private redis: Redis | null = null;

  // In-memory fallback when Redis is unavailable
  private turnBuffers: Map<string, MessageTurnDto[]> = new Map();
  private sessionUserIds: Map<string, string> = new Map();

  constructor(
    private config: ConfigService,
    private llm: LLMService,
    private memoryService: MemoryService,
  ) {
    this.enabled =
      this.config.get<string>('SUMMARIZATION_ENABLED', 'true') !== 'false';
    this.batchSize = parseInt(
      this.config.get<string>('SUMMARIZATION_BATCH_SIZE', '5'),
      10,
    );

    const redisUrl = this.config.get<string>('REDIS_URL');
    if (redisUrl) {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      this.redis.connect().catch((err) => {
        this.logger.warn(
          `[Summarization] Redis connect failed, falling back to in-memory: ${err.message}`,
        );
        this.redis = null;
      });
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get getBatchSize(): number {
    return this.batchSize;
  }

  /**
   * Summarize an array of conversation turns via LLM
   */
  async summarize(
    turns: MessageTurnDto[],
    userName?: string,
  ): Promise<SummaryFact[]> {
    if (turns.length === 0) return [];

    const conversation = turns
      .map((t, i) => `[${i}] ${t.role.toUpperCase()}: ${t.content}`)
      .join('\n\n');

    const systemPrompt = userName
      ? `${SUMMARIZATION_PROMPT}\n\nThe user's name is "${userName}".`
      : SUMMARIZATION_PROMPT;

    try {
      const result = await this.llm.json<LLMSummarizationResponse>(
        [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Conversation:\n${conversation}\n\nExtract key information:`,
          },
        ],
        undefined,
        { temperature: 0.2 },
      );

      const facts = (result.facts || []).map((f) => ({
        content: f.content,
        category: this.normalizeCategory(f.category),
        confidence:
          typeof f.confidence === 'number'
            ? Math.max(0, Math.min(1, f.confidence))
            : 0.7,
        sourceTurnIndices: Array.isArray(f.sourceTurnIndices)
          ? f.sourceTurnIndices
          : [],
      }));

      return facts;
    } catch (error) {
      this.logger.error('[Summarization] LLM summarization failed:', error);
      return [];
    }
  }

  /**
   * Summarize turns and store resulting memories
   */
  async summarizeAndStore(
    userId: string,
    turns: MessageTurnDto[],
    options?: {
      sessionId?: string;
      projectId?: string;
      userName?: string;
      minImportance?: number;
    },
  ): Promise<SummarizeResult> {
    const startTime = Date.now();
    const minImportance = options?.minImportance ?? 0.4;

    const facts = await this.summarize(turns, options?.userName);
    const toStore = facts.filter((f) => f.confidence >= minImportance);

    let created = 0;
    for (const fact of toStore) {
      try {
        await this.memoryService.remember(userId, {
          raw: fact.content,
          layer: this.categoryToLayer(fact.category),
          importanceHint: this.confidenceToHint(fact.confidence),
          source: 'AGENT_OBSERVATION' as MemorySource,
          context: {
            projectId: options?.projectId,
            sessionId: options?.sessionId,
          },
          // Summary metadata encoded in source attribution
          sourceTurnIndex: fact.sourceTurnIndices[0] ?? 0,
        });
        created++;
      } catch (error) {
        this.logger.error(
          '[Summarization] Failed to store summary fact:',
          error,
        );
      }
    }

    return {
      facts,
      created,
      totalTurns: turns.length,
      processingMs: Date.now() - startTime,
    };
  }

  // ─── Redis-backed buffer helpers ──────────────────────────────────

  private async getRedisBuffer(sessionId: string): Promise<MessageTurnDto[]> {
    if (!this.redis) return this.turnBuffers.get(sessionId) || [];
    const raw = await this.redis.get(TURNS_KEY(sessionId));
    return raw ? (JSON.parse(raw) as MessageTurnDto[]) : [];
  }

  private async setRedisBuffer(
    sessionId: string,
    turns: MessageTurnDto[],
  ): Promise<void> {
    if (!this.redis) {
      this.turnBuffers.set(sessionId, turns);
      return;
    }
    if (turns.length === 0) {
      await this.redis.del(TURNS_KEY(sessionId), USER_KEY(sessionId));
    } else {
      const pipeline = this.redis.pipeline();
      pipeline.set(
        TURNS_KEY(sessionId),
        JSON.stringify(turns),
        'EX',
        BUFFER_TTL_SECONDS,
      );
      // TTL refresh for user key handled in setRedisUserId
      await pipeline.exec();
    }
  }

  private async setRedisUserId(
    sessionId: string,
    userId: string,
  ): Promise<void> {
    if (!this.redis) {
      this.sessionUserIds.set(sessionId, userId);
      return;
    }
    await this.redis.set(USER_KEY(sessionId), userId, 'EX', BUFFER_TTL_SECONDS);
  }

  private async getRedisUserId(sessionId: string): Promise<string | undefined> {
    if (!this.redis) return this.sessionUserIds.get(sessionId);
    const val = await this.redis.get(USER_KEY(sessionId));
    return val ?? undefined;
  }

  private async deleteRedisBuffer(sessionId: string): Promise<void> {
    if (!this.redis) {
      this.turnBuffers.delete(sessionId);
      return;
    }
    await this.redis.del(TURNS_KEY(sessionId), USER_KEY(sessionId));
  }

  /** Return all session ids that have non-empty buffers (for shutdown flush). */
  private async allBufferedSessionIds(): Promise<string[]> {
    if (!this.redis || this.redis.status === 'end') {
      return [...this.turnBuffers.entries()]
        .filter(([, t]) => t.length > 0)
        .map(([sid]) => sid);
    }

    try {
      const keys = await this.redis.keys(`${REDIS_KEY_PREFIX}turns:*`);
      return keys.map((k) => k.slice(`${REDIS_KEY_PREFIX}turns:`.length));
    } catch (error) {
      this.logger.warn(
        `[Shutdown] Could not list Redis summarization buffers; skipping Redis flush: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Add turns to a session buffer. When buffer reaches batchSize, auto-summarize.
   * Returns summarization result if batch was triggered, null otherwise.
   */
  async addTurnsToBuffer(
    userId: string,
    sessionId: string,
    turns: MessageTurnDto[],
    options?: { projectId?: string; userName?: string },
  ): Promise<SummarizeResult | null> {
    if (!this.enabled) return null;

    const buffer = await this.getRedisBuffer(sessionId);
    buffer.push(...turns);
    await this.setRedisBuffer(sessionId, buffer);
    await this.setRedisUserId(sessionId, userId);

    if (buffer.length >= this.batchSize) {
      const batch = buffer.splice(0, this.batchSize);
      await this.setRedisBuffer(sessionId, buffer);

      return this.summarizeAndStore(userId, batch, {
        sessionId,
        projectId: options?.projectId,
        userName: options?.userName,
      });
    }

    return null;
  }

  /**
   * Flush remaining turns in a session buffer
   */
  async flushBuffer(
    userId: string,
    sessionId: string,
    options?: { projectId?: string; userName?: string },
  ): Promise<SummarizeResult | null> {
    const buffer = await this.getRedisBuffer(sessionId);
    if (buffer.length === 0) return null;

    await this.deleteRedisBuffer(sessionId);
    return this.summarizeAndStore(userId, buffer, {
      sessionId,
      projectId: options?.projectId,
      userName: options?.userName,
    });
  }

  /**
   * Get current buffer size for a session
   */
  async getBufferSize(sessionId: string): Promise<number> {
    const buffer = await this.getRedisBuffer(sessionId);
    return buffer.length;
  }

  /**
   * HEY-362: Flush all non-empty turn buffers on module destroy (graceful shutdown).
   * Best-effort — errors are logged but don't prevent shutdown.
   */
  async onModuleDestroy(): Promise<void> {
    const sessionIds = await this.allBufferedSessionIds();
    if (sessionIds.length === 0) {
      await this.closeRedis();
      return;
    }

    this.logger.log(
      `[Shutdown] Flushing ${sessionIds.length} non-empty summarization buffers`,
    );

    const results = await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        const userId = await this.getRedisUserId(sessionId);
        if (!userId) {
          this.logger.warn(
            `[Shutdown] No userId for session ${sessionId}, skipping flush`,
          );
          return null;
        }
        return this.flushBuffer(userId, sessionId);
      }),
    );

    const flushed = results.filter(
      (r) => r.status === 'fulfilled' && r.value,
    ).length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    this.logger.log(
      `[Shutdown] Summarization flush complete: ${flushed} flushed, ${failed} failed`,
    );

    await this.closeRedis();
  }

  private async closeRedis(): Promise<void> {
    if (!this.redis) return;
    if (this.redis.status === 'end') return;
    await this.redis.quit().catch(() => {});
  }

  private normalizeCategory(category: string): SummaryFact['category'] {
    const valid: SummaryFact['category'][] = [
      'fact',
      'decision',
      'preference',
      'action_item',
    ];
    const normalized = category
      ?.toLowerCase()
      .replace(/\s+/g, '_') as SummaryFact['category'];
    return valid.includes(normalized) ? normalized : 'fact';
  }

  private categoryToLayer(category: SummaryFact['category']): MemoryLayer {
    switch (category) {
      case 'preference':
        return MemoryLayer.IDENTITY;
      case 'fact':
        return MemoryLayer.IDENTITY;
      case 'decision':
        return MemoryLayer.PROJECT;
      case 'action_item':
        return MemoryLayer.PROJECT;
      default:
        return MemoryLayer.SESSION;
    }
  }

  private confidenceToHint(confidence: number): any {
    if (confidence >= 0.9) return 'CRITICAL';
    if (confidence >= 0.7) return 'HIGH';
    if (confidence >= 0.5) return 'MEDIUM';
    return 'LOW';
  }
}
