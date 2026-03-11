/**
 * Seed Corpus — deterministic test fixtures loader.
 *
 * Loads pre-defined fixture users and memories into the test database.
 * Each fixture user gets an Account, Agent, User, and seeded memories.
 *
 * @see test/fixtures/ for the fixture definitions
 */

import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { ALL_USERS, TOTAL_MEMORY_COUNT } from '../fixtures';
import type { FixtureUser, FixtureMemory } from '../fixtures';

const logger = new Logger('SeedCorpus');

export interface CorpusMemory {
  raw: string;
  layer?: string;
  tags?: string[];
}

export interface SeededUser {
  name: string;
  accountId: string;
  agentId: string;
  userId: string;
  apiKey: string;
  canaryPrefix: string;
  memoryCount: number;
}

export interface SeedCorpusOptions {
  /** Which fixture users to seed (defaults to all) */
  users?: string[];
  /** Prisma internal user ID — only used for legacy single-user seeding */
  internalUserId?: string;
  /** Override fixtures for legacy mode */
  fixtures?: CorpusMemory[];
}

export interface SeedCorpusResult {
  seededUsers: SeededUser[];
  totalMemories: number;
  cleanup: () => Promise<void>;
}

/**
 * Seed the test DB with the full deterministic corpus.
 *
 * Creates accounts, agents, users, and memories for each fixture user.
 * Returns auth info and a cleanup function.
 */
export async function seedCorpus(
  prisma: PrismaService,
  options: SeedCorpusOptions = {},
): Promise<SeedCorpusResult> {
  const requestedUsers = options.users
    ? ALL_USERS.filter((u) => options.users?.includes(u.name))
    : ALL_USERS;

  logger.log(
    `Seeding ${requestedUsers.length} users with ~${TOTAL_MEMORY_COUNT} total memories...`,
  );

  const seededUsers: SeededUser[] = [];
  const ts = Date.now();

  for (const fixtureUser of requestedUsers) {
    const seeded = await seedFixtureUser(prisma, fixtureUser, ts);
    seededUsers.push(seeded);
    logger.log(
      `  ✓ ${fixtureUser.name}: ${fixtureUser.memories.length} memories seeded`,
    );
  }

  logger.log(
    `Corpus seeded: ${seededUsers.length} users, ${seededUsers.reduce((s, u) => s + u.memoryCount, 0)} memories`,
  );

  return {
    seededUsers,
    totalMemories: seededUsers.reduce((s, u) => s + u.memoryCount, 0),
    cleanup: async () => {
      for (const user of seededUsers) {
        await cleanupSeededUser(prisma, user);
      }
      logger.log('Corpus cleaned up');
    },
  };
}

/**
 * Remove all memories created by seedCorpus for a given user.
 */
export async function cleanCorpus(
  prisma: PrismaService,
  internalUserId: string,
): Promise<void> {
  await prisma.memory
    .deleteMany({ where: { userId: internalUserId } })
    .catch(() => {
      /* ignore cleanup errors */
    });
}

// ── Internal helpers ────────────────────────────────────────────

async function seedFixtureUser(
  prisma: PrismaService,
  fixture: FixtureUser,
  ts: number,
): Promise<SeededUser> {
  const accountId = `test-corpus-account-${fixture.name}-${ts}`;
  const agentId = `test-corpus-agent-${fixture.name}-${ts}`;
  const userId = `test-corpus-user-${fixture.name}-${ts}`;
  const apiKey = `eng_test_corpus_${fixture.name}_${ts}`;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
  const apiKeyHint = apiKey.slice(-4);
  // Use unique email per run to avoid unique constraint issues
  const email = `${fixture.name}-${ts}@test.engram.local`;

  // Create account (table: accounts)
  await prisma.$executeRawUnsafe(`
    INSERT INTO accounts (id, email, password_hash, created_at, updated_at)
    VALUES ('${accountId}', '${email}', 'not-a-real-hash', NOW(), NOW())
  `);

  // Create agent with hashed API key (table: agents)
  await prisma.$executeRawUnsafe(`
    INSERT INTO agents (id, name, account_id, api_key_hash, api_key_hint, created_at, updated_at)
    VALUES ('${agentId}', '${fixture.name}', '${accountId}', '${apiKeyHash}', '${apiKeyHint}', NOW(), NOW())
  `);

  // Create user with external_id matching the userId for auth header (table: users)
  await prisma.$executeRawUnsafe(`
    INSERT INTO users (id, external_id, agent_id, created_at, updated_at)
    VALUES ('${userId}', '${userId}', '${agentId}', NOW(), NOW())
  `);

  // Batch insert memories
  await seedMemories(prisma, userId, fixture.memories);

  return {
    name: fixture.name,
    accountId,
    agentId,
    userId,
    apiKey,
    canaryPrefix: fixture.canaryPrefix,
    memoryCount: fixture.memories.length,
  };
}

async function seedMemories(
  prisma: PrismaService,
  userId: string,
  memories: FixtureMemory[],
): Promise<void> {
  // Batch in chunks of 50 for performance
  const BATCH_SIZE = 50;

  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE);
    const values = batch
      .map((m) => {
        const escaped = m.content.replace(/'/g, "''");
        const createdAt = m.created_at.toISOString();
        return `('${m.fixture_id}', '${escaped}', '${m.layer}', '${m.source}', ${m.importanceScore}, '${userId}', '${createdAt}'::timestamptz, NOW())`;
      })
      .join(',\n');

    await prisma.$executeRawUnsafe(`
      INSERT INTO memories (id, raw, layer, source, importance_score, user_id, created_at, updated_at)
      VALUES ${values}
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

async function cleanupSeededUser(
  prisma: PrismaService,
  user: SeededUser,
): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM memories WHERE user_id = '${user.userId}'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE id = '${user.userId}'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM agents WHERE id = '${user.agentId}'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM accounts WHERE id = '${user.accountId}'`,
    );
  } catch {
    /* ignore cleanup errors */
  }
}
