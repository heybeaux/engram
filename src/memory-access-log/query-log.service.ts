import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { rlsContext } from '../prisma/rls-context';

export interface QueryLogEntry {
  queryText: string;
  queryEmbedding: number[];
  agentId?: string;
  sessionKey?: string;
  results: Array<{ memoryId: string; cosineScore: number; rank: number }>;
  latencyMs: number;
}

@Injectable()
export class QueryLogService {
  private readonly logger = new Logger(QueryLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Log a query for re-ranker training. Fire-and-forget.
   */
  logQuery(entry: QueryLogEntry): void {
    // Fire-and-forget outlives the request's RLS transaction; escape inherited tx.
    void rlsContext.run(undefined as any, () =>
      this.writeQueryLog(entry).catch((err) => {
        this.logger.warn(`Failed to log query: ${err.message}`, err.stack);
      }),
    );
  }

  /**
   * Write query log entry to the database.
   */
  async writeQueryLog(entry: QueryLogEntry): Promise<void> {
    await (this.prisma as any).queryLog.create({
      data: {
        queryText: entry.queryText,
        queryEmbedding: entry.queryEmbedding,
        agentId: entry.agentId,
        sessionKey: entry.sessionKey,
        resultsReturned: entry.results.map((r) => ({
          memory_id: r.memoryId,
          cosine_score: r.cosineScore,
          rank: r.rank,
        })),
        resultCount: entry.results.length,
        latencyMs: entry.latencyMs,
      },
    });
  }
}
