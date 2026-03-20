/**
 * Test user factory helpers.
 *
 * Creates the minimum database entities (Account → Agent → User) needed by
 * most integration tests. Cleans up after itself when you call the returned
 * cleanup() function.
 */

import { PrismaService } from '../../src/prisma/prisma.service';
import { createHash, randomBytes } from 'crypto';

export interface TestUserFixture {
  /** Internal Prisma Account id */
  accountId: string;
  /** Internal Prisma Agent id */
  agentId: string;
  /** Plain-text API key (pass in X-AM-API-Key header) */
  apiKey: string;
  /** SHA-256 hash of the API key (stored in DB) */
  apiKeyHash: string;
  /** External user ID (pass in X-AM-User-ID header) */
  userId: string;
  /** Tear down — deletes agent, account, and all associated data */
  cleanup: () => Promise<void>;
}

export interface CreateTestUserOptions {
  /** Override the generated external userId */
  userId?: string;
  /** Override the agent name */
  agentName?: string;
  /** Override the account email */
  email?: string;
}

/**
 * Create a test account + agent combo in the DB.
 *
 * @example
 * const user = await createTestUser(prisma);
 * // ... run test using user.apiKey + user.userId
 * await user.cleanup();
 */
export async function createTestUser(
  prisma: PrismaService,
  overrides: CreateTestUserOptions = {},
): Promise<TestUserFixture> {
  const suffix = randomBytes(6).toString('hex');
  const userId = overrides.userId ?? `test-user-${suffix}`;
  const email = overrides.email ?? `test-${suffix}@test.local`;
  const agentName = overrides.agentName ?? `Test Agent ${suffix}`;
  const apiKey = `sk-test-${suffix}`;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

  const account = await prisma.account.create({
    data: {
      name: `Test Account ${suffix}`,
      email,
      passwordHash: 'not-a-real-hash',
    },
  });

  const agent = await prisma.agent.create({
    data: {
      name: agentName,
      apiKeyHash,
      apiKeyHint: suffix.slice(0, 4),
      accountId: account.id,
    },
  });

  const cleanup = async () => {
    // Delete in reverse FK order
    await prisma.memoryChainLink
      .deleteMany({
        where: { source: { user: { accountId: account.id } } },
      })
      .catch(() => {});
    await prisma.memoryExtraction
      .deleteMany({
        where: { memory: { user: { accountId: account.id } } },
      })
      .catch(() => {});
    await prisma.memory
      .deleteMany({ where: { user: { accountId: account.id } } })
      .catch(() => {});
    await prisma.user
      .deleteMany({ where: { accountId: account.id } })
      .catch(() => {});
    await prisma.agent.deleteMany({ where: { id: agent.id } }).catch(() => {});
    await prisma.account
      .deleteMany({ where: { id: account.id } })
      .catch(() => {});
  };

  return {
    accountId: account.id,
    agentId: agent.id,
    apiKey,
    apiKeyHash,
    userId,
    cleanup,
  };
}
