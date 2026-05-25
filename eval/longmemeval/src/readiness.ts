/**
 * Readiness gates for the LongMemEval eval harness.
 *
 * The harness ingests each question into an isolated (userId, agentId),
 * so we can wait on extraction coverage for just that question's session
 * memories instead of relying only on a coarse embedding-status count.
 */

import type { RunConfig } from './types';

interface MemoryListItem {
  extraction?: unknown | null;
}

interface ListMemoriesResponse {
  memories?: MemoryListItem[];
  total?: number;
  totalPages?: number;
}

export interface SessionCoverage {
  total: number;
  extracted: number;
}

export async function waitForSessionReadiness(
  userId: string,
  agentId: string,
  sessionId: string,
  expectedSessionMemories: number,
  config: Pick<RunConfig, 'apiBase' | 'apiKey'>,
  timeoutMs = 120_000,
  pollIntervalMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCoverage: SessionCoverage = { total: 0, extracted: 0 };
  const headers = {
    'Content-Type': 'application/json',
    'X-AM-API-Key': config.apiKey,
    'X-AM-User-ID': userId,
    'X-AM-Agent-ID': agentId,
  };

  while (Date.now() < deadline) {
    lastCoverage = await fetchSessionCoverage(
      config.apiBase,
      headers,
      userId,
      agentId,
      sessionId,
    );
    if (
      lastCoverage.total >= expectedSessionMemories &&
      lastCoverage.extracted >= expectedSessionMemories
    ) {
      return;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Session readiness timeout for ${sessionId}: extracted ` +
      `${lastCoverage.extracted}/${expectedSessionMemories} from ` +
      `${lastCoverage.total} session memories after ${timeoutMs}ms`,
  );
}

export async function fetchSessionCoverage(
  apiBase: string,
  headers: Record<string, string>,
  userId: string,
  agentId: string,
  sessionId: string,
): Promise<SessionCoverage> {
  let offset = 0;
  let total = 0;
  let extracted = 0;
  let expectedTotal = Infinity;

  while (offset < expectedTotal) {
    try {
      const params = new URLSearchParams({
        userId,
        agentId,
        sessionId,
        layer: 'SESSION',
        limit: '100',
        offset: String(offset),
      });
      const response = await fetch(`${apiBase}/v1/memories?${params.toString()}`, { headers });
      if (!response.ok) {
        return { total: 0, extracted: 0 };
      }

      const data = (await response.json()) as ListMemoriesResponse;
      const memories = data.memories ?? [];

      total += memories.length;
      extracted += memories.filter(memory => memory.extraction != null).length;
      expectedTotal = data.total ?? total;

      if (memories.length === 0) {
        break;
      }
      offset += memories.length;
    } catch {
      return { total: 0, extracted: 0 };
    }
  }

  return { total, extracted };
}
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
