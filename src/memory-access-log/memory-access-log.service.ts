import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { rlsContext } from '../prisma/rls-context';

/**
 * Access types matching the MemoryAccessType enum that Phase 1 will add to Prisma.
 * Using string literals until the schema is generated.
 */
export enum MemoryAccessType {
  CREATED = 'CREATED',
  READ = 'READ',
  RECALLED = 'RECALLED',
  INJECTED = 'INJECTED',
  UPDATED = 'UPDATED',
  SUPERSEDED = 'SUPERSEDED',
}

export interface LogAccessParams {
  memoryId: string;
  agentSessionKey: string;
  accessType: MemoryAccessType;
  context?: string;
  tokensCost?: number;
}

export interface AttributionResult {
  memoryId: string;
  createdBy: {
    sessionKey: string;
    label: string | null;
    createdAt: Date;
  } | null;
  accessHistory: Array<{
    sessionKey: string;
    accessType: string;
    context: string | null;
    at: Date;
  }>;
  accessCount: number;
  uniqueSessions: number;
}

export interface SessionSummaryResult {
  sessionKey: string;
  label: string | null;
  status: string;
  memoriesCreated: number;
  memoriesAccessed: number;
  uniqueMemories: number;
  uniqueMemoriesAccessed: number;
  duration: number | null;
  topTopics: string[];
}

@Injectable()
export class MemoryAccessLogService {
  private readonly logger = new Logger(MemoryAccessLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve an AgentSession ID from a session key, creating if needed.
   */
  private async resolveSessionId(sessionKey: string): Promise<string> {
    // Try to find existing session
    const existing = await (this.prisma as any).agentSession.findUnique({
      where: { sessionKey },
      select: { id: true },
    });
    if (existing) return existing.id;

    // Auto-create session (upsert to handle race conditions)
    const parentKey = sessionKey.includes(':subagent:')
      ? sessionKey.split(':subagent:')[0]
      : null;

    const session = await (this.prisma as any).agentSession.upsert({
      where: { sessionKey },
      update: {},
      create: {
        sessionKey,
        parentKey,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    return session.id;
  }

  /**
   * Log a memory creation event. Fire-and-forget.
   */
  async logCreated(
    memoryId: string,
    agentSessionKey: string,
    context?: string,
  ): Promise<void> {
    this.logAccessFireAndForget({
      memoryId,
      agentSessionKey,
      accessType: MemoryAccessType.CREATED,
      context,
    });
  }

  /**
   * Log memory recall events (batch). Fire-and-forget.
   */
  async logRecalled(
    memoryIds: string[],
    agentSessionKey: string,
    context?: string,
  ): Promise<void> {
    this.logBatchFireAndForget(
      memoryIds.map((memoryId) => ({
        memoryId,
        agentSessionKey,
        accessType: MemoryAccessType.RECALLED,
        context,
      })),
    );
  }

  /**
   * Log memory injection into context window (batch). Fire-and-forget.
   */
  async logInjected(
    memoryIds: string[],
    agentSessionKey: string,
    context?: string,
    tokensCost?: number,
  ): Promise<void> {
    this.logBatchFireAndForget(
      memoryIds.map((memoryId) => ({
        memoryId,
        agentSessionKey,
        accessType: MemoryAccessType.INJECTED,
        context,
        tokensCost,
      })),
    );
  }

  /**
   * Log a memory update event. Fire-and-forget.
   */
  async logUpdated(
    memoryId: string,
    agentSessionKey: string,
    context?: string,
  ): Promise<void> {
    this.logAccessFireAndForget({
      memoryId,
      agentSessionKey,
      accessType: MemoryAccessType.UPDATED,
      context,
    });
  }

  /**
   * Fire-and-forget single log entry.
   */
  private logAccessFireAndForget(params: LogAccessParams): void {
    // Fire-and-forget work can outlive the request transaction opened by the
    // RLS interceptor. Detach it from AsyncLocalStorage so it does not inherit
    // a closed transactional Prisma client after the HTTP response completes.
    void rlsContext.run(undefined as any, () =>
      this.writeLogEntry(params).catch((err) => {
        this.logger.warn(`Failed to log access: ${err.message}`, err.stack);
      }),
    );
  }

  /**
   * Fire-and-forget batch log entries.
   */
  private logBatchFireAndForget(entries: LogAccessParams[]): void {
    if (entries.length === 0) return;
    // See logAccessFireAndForget: access logs are intentionally detached from
    // request-scoped RLS transactions because these writes are async telemetry.
    void rlsContext.run(undefined as any, () =>
      this.writeBatchLogEntries(entries).catch((err) => {
        this.logger.warn(
          `Failed to log batch access: ${err.message}`,
          err.stack,
        );
      }),
    );
  }

  /**
   * Write a single log entry to the database.
   */
  async writeLogEntry(params: LogAccessParams): Promise<void> {
    const agentSessionId = await this.resolveSessionId(params.agentSessionKey);
    await (this.prisma as any).memoryAccessLog.create({
      data: {
        memoryId: params.memoryId,
        agentSessionId,
        accessType: params.accessType,
        context: params.context,
        tokensCost: params.tokensCost,
      },
    });
  }

  /**
   * Write batch log entries using createMany for efficiency.
   */
  async writeBatchLogEntries(entries: LogAccessParams[]): Promise<void> {
    if (entries.length === 0) return;

    // Resolve all unique session keys
    const uniqueKeys = [...new Set(entries.map((e) => e.agentSessionKey))];
    const sessionIdMap = new Map<string, string>();
    for (const key of uniqueKeys) {
      sessionIdMap.set(key, await this.resolveSessionId(key));
    }

    await (this.prisma as any).memoryAccessLog.createMany({
      data: entries.map((e) => ({
        memoryId: e.memoryId,
        agentSessionId: sessionIdMap.get(e.agentSessionKey),
        accessType: e.accessType,
        context: e.context,
        tokensCost: e.tokensCost,
      })),
    });
  }

  /**
   * Get full attribution trail for a memory.
   * Returns shape expected by the dashboard: { memoryId, createdBySession, accessLog, pools }
   */
  async getAttribution(memoryId: string): Promise<any> {
    // Get the memory's creator session key
    const memory = await this.prisma.memory.findUnique({
      where: { id: memoryId },
      select: { id: true, createdBySession: true } as any,
    });

    let createdBySession: any = null;
    const createdBySessionKey = (memory as any)?.createdBySession;
    if (createdBySessionKey) {
      const session = await (this.prisma as any).agentSession.findUnique({
        where: { sessionKey: createdBySessionKey },
      });
      if (session) {
        createdBySession = {
          id: session.id,
          sessionKey: session.sessionKey,
          label: session.label ?? null,
          status: session.status,
          parentSessionKey: session.parentKey ?? null,
          taskDescription: session.taskDescription ?? null,
          startedAt: session.createdAt,
          endedAt: session.endedAt ?? null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt ?? session.createdAt,
        };
      }
    }

    // Get access history
    const logs = await (this.prisma as any).memoryAccessLog.findMany({
      where: { memoryId },
      orderBy: { createdAt: 'desc' },
      include: {
        agentSession: {
          select: { sessionKey: true },
        },
      },
      take: 100,
    });

    const accessLog = logs.map((log: any) => ({
      id: log.id,
      memoryId: log.memoryId,
      sessionKey: log.agentSession.sessionKey,
      accessType: log.accessType,
      metadata: log.context ? { context: log.context } : undefined,
      createdAt: log.createdAt,
    }));

    // Get pool memberships
    let pools: any[] = [];
    try {
      const memberships = await (
        this.prisma as any
      ).memoryPoolMembership.findMany({
        where: { memoryId },
        include: {
          pool: true,
        },
      });
      pools = memberships.map((m: any) => ({
        id: m.pool.id,
        name: m.pool.name,
        description: m.pool.description ?? null,
        visibility: m.pool.visibility,
        createdBySession: m.pool.createdBy ?? null,
        createdAt: m.pool.createdAt,
        updatedAt: m.pool.updatedAt,
      }));
    } catch (err) {
      this.logger.warn(
        `Failed to fetch pool memberships: ${(err as Error).message}`,
      );
    }

    return {
      memoryId,
      createdBySession,
      accessLog,
      pools,
    };
  }

  /**
   * Get aggregate stats for an agent session.
   */
  async getSessionSummary(sessionKey: string): Promise<SessionSummaryResult> {
    const session = await (this.prisma as any).agentSession.findUnique({
      where: { sessionKey },
    });

    if (!session) {
      return {
        sessionKey,
        label: null,
        status: 'UNKNOWN',
        memoriesCreated: 0,
        memoriesAccessed: 0,
        uniqueMemories: 0,
        uniqueMemoriesAccessed: 0,
        duration: null,
        topTopics: [],
      };
    }

    // Count memories created
    const createdCount = await (this.prisma as any).memoryAccessLog.count({
      where: {
        agentSessionId: session.id,
        accessType: MemoryAccessType.CREATED,
      },
    });

    // Count all access events (non-CREATED)
    const accessLogs = await (this.prisma as any).memoryAccessLog.findMany({
      where: {
        agentSessionId: session.id,
        accessType: { not: MemoryAccessType.CREATED },
      },
      select: { memoryId: true },
    });

    const uniqueMemoryIds = new Set(accessLogs.map((l: any) => l.memoryId));

    // Calculate duration in milliseconds. The dashboard formats numeric ms;
    // returning ISO-8601 durations here produced NaN duration cards.
    const durationEnd = session.endedAt ?? new Date();
    const duration = Math.max(
      0,
      new Date(durationEnd).getTime() - new Date(session.createdAt).getTime(),
    );

    return {
      sessionKey: session.sessionKey,
      label: session.label,
      status: session.status,
      memoriesCreated: createdCount,
      memoriesAccessed: accessLogs.length,
      uniqueMemories: uniqueMemoryIds.size,
      uniqueMemoriesAccessed: uniqueMemoryIds.size,
      duration,
      topTopics: [],
    };
  }
}
