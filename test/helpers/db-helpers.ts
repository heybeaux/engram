/**
 * Database helpers for test isolation and cleanup.
 *
 * CAUTION: These helpers truncate real tables. They MUST only be called
 * against a test database (enforced by the env guard in test-setup).
 */

import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Delete all rows from the most common test-affecting tables, in FK-safe order.
 *
 * Use this in `afterAll` / `afterEach` when you want a completely clean slate.
 * This is faster than re-running migrations but slower than per-test cleanup.
 */
export async function truncateAll(prisma: PrismaService): Promise<void> {
  // Order matters — child tables first
  const tables = [
    'memory_chain_links',
    'memory_extractions',
    'memories',
    'users',
    'agents',
    'accounts',
    'webhooks',
  ] as const;

  for (const table of tables) {
    await prisma
      .$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`)
      .catch(() => {
        // Table may not exist in this schema version — skip silently
      });
  }
}

/**
 * Alias for truncateAll — semantically cleaner in beforeEach blocks.
 */
export async function resetDb(prisma: PrismaService): Promise<void> {
  return truncateAll(prisma);
}

/**
 * Delete rows created by a specific agent (lighter than truncateAll).
 * Use this for per-test cleanup when you don't want to nuke everything.
 */
export async function cleanupAgent(
  prisma: PrismaService,
  agentId: string,
): Promise<void> {
  // Users now belong to accounts (not agents) — resolve accountId first
  const agent = await prisma.agent
    .findUnique({ where: { id: agentId }, select: { accountId: true } })
    .catch(() => null);
  const accountId = agent?.accountId;
  if (!accountId) return;

  await prisma.memoryChainLink
    .deleteMany({
      where: { source: { user: { accountId } } },
    })
    .catch(() => {});
  await prisma.memoryExtraction
    .deleteMany({
      where: { memory: { user: { accountId } } },
    })
    .catch(() => {});
  await prisma.memory
    .deleteMany({ where: { user: { accountId } } })
    .catch(() => {});
  await prisma.user.deleteMany({ where: { accountId } }).catch(() => {});
}
