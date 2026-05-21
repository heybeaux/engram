/**
 * Cross-tenant isolation assertions.
 *
 * Helpers for verifying that a response does NOT contain data belonging to
 * another user / agent (i.e., data with the given canaryPrefix in its content).
 */

import type { Response } from 'supertest';

/**
 * Assert that a supertest response contains no memories belonging to `userId`
 * (identified by a known `canaryPrefix` injected into their memory content at seed time).
 *
 * Throws if any memory in the response body matches the canary string.
 *
 * @param response   - supertest Response object
 * @param userId     - the user ID whose data must NOT appear
 * @param canaryPrefix - a unique string that was written into that user's memories
 *
 * @example
 * // User A seeded memories with content starting with 'CANARY-USER-A:'
 * const res = await request(app.getHttpServer())
 *   .post('/v1/memories/query')
 *   .set(asUser(userB.apiKey, userB.userId))
 *   .send({ query: 'test', limit: 20 });
 *
 * assertNoCrossTenantLeak(res, userA.userId, 'CANARY-USER-A:');
 */
export function assertNoCrossTenantLeak(
  response: Response,
  userId: string,
  canaryPrefix: string,
): void {
  const body = response.body as Record<string, unknown>;

  // Handle both { memories: [...] } and direct array responses
  const memories: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray(body?.memories)
      ? (body.memories as unknown[])
      : [];

  const leaks = memories.filter((m) => {
    const mem = m as Record<string, string>;
    const raw = String(mem?.raw ?? mem?.content ?? '');
    return raw.startsWith(canaryPrefix);
  });

  if (leaks.length > 0) {
    throw new Error(
      `Cross-tenant data leak detected! ` +
        `Response for a different user contains ${leaks.length} memory/memories ` +
        `belonging to userId "${userId}" (canary: "${canaryPrefix}"). ` +
        `Leaked IDs: ${leaks.map((m) => (m as Record<string, string>).id).join(', ')}`,
    );
  }
}

/**
 * Assert that a single memory object does not belong to `userId`.
 *
 * Checks both the `userId` field (if present) and the canary prefix in `raw`.
 */
export function assertMemoryNotOwnedBy(
  memory: Record<string, unknown>,
  userId: string,
  canaryPrefix?: string,
): void {
  if (memory?.userId === userId) {
    throw new Error(
      `Cross-tenant leak: memory ${String(memory.id)} has userId "${userId}" but should not be visible.`,
    );
  }
  if (canaryPrefix) {
    const rawValue = memory?.raw ?? memory?.content;
    const raw = typeof rawValue === 'string' ? rawValue : '';
    if (raw.startsWith(canaryPrefix)) {
      throw new Error(
        `Cross-tenant leak: memory ${String(memory.id)} contains canary "${canaryPrefix}" belonging to userId "${userId}".`,
      );
    }
  }
}
