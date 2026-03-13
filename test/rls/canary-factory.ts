/**
 * Canary Factory — Seeds two test users with canary-tagged memories
 * for RLS isolation testing.
 *
 * Each user's memories contain a unique canary prefix in the `raw` field.
 * If any endpoint returns memories with the OTHER user's canary prefix,
 * RLS isolation is broken.
 */

import { createHash } from 'crypto';
import type { PrismaService } from '../../src/prisma/prisma.service';

export const CANARY_PREFIX_A = 'RLS_CANARY_A_';
export const CANARY_PREFIX_B = 'RLS_CANARY_B_';

export interface CanaryUser {
  accountId: string;
  agentId: string;
  userId: string;
  apiKey: string;
  canaryPrefix: string;
  memoryIds: string[];
}

export interface CanaryPair {
  userA: CanaryUser;
  userB: CanaryUser;
  cleanup: () => Promise<void>;
}

/**
 * Seed two isolated users with canary memories.
 * Returns auth info + cleanup function.
 */
export async function seedCanaryPair(
  prisma: PrismaService,
): Promise<CanaryPair> {
  const userA = await createCanaryUser(prisma, 'canary-a', CANARY_PREFIX_A, 25);
  const userB = await createCanaryUser(prisma, 'canary-b', CANARY_PREFIX_B, 25);

  return {
    userA,
    userB,
    cleanup: async () => {
      // Delete in reverse dependency order
      for (const u of [userA, userB]) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM memories WHERE user_id IN (
            SELECT id FROM users WHERE account_id = '${u.accountId}'
          )`,
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM users WHERE account_id = '${u.accountId}'`,
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM agents WHERE id = '${u.agentId}'`,
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM accounts WHERE id = '${u.accountId}'`,
        );
      }
    },
  };
}

async function createCanaryUser(
  prisma: PrismaService,
  prefix: string,
  canaryPrefix: string,
  memoryCount: number,
): Promise<CanaryUser> {
  const ts = Date.now();
  const accountId = `test-account-${prefix}-${ts}`;
  const agentId = `test-agent-${prefix}-${ts}`;
  const apiKey = `eng_test_${prefix}_${ts}`;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
  const apiKeyHint = apiKey.slice(-4);

  // Create account
  await prisma.$executeRawUnsafe(`
    INSERT INTO accounts (id, email, password_hash, created_at, updated_at)
    VALUES ('${accountId}', '${prefix}@test.engram.local', 'not-a-real-hash', NOW(), NOW())
  `);

  // Create agent with hashed API key
  await prisma.$executeRawUnsafe(`
    INSERT INTO agents (id, name, account_id, api_key_hash, api_key_hint, created_at, updated_at)
    VALUES ('${agentId}', '${prefix}', '${accountId}', '${apiKeyHash}', '${apiKeyHint}', NOW(), NOW())
  `);

  // Create user linked to account (not agent)
  const userId = `test-user-${prefix}-${ts}`;
  await prisma.$executeRawUnsafe(`
    INSERT INTO users (id, external_id, account_id, is_default, created_at, updated_at)
    VALUES ('${userId}', '${prefix}', '${accountId}', false, NOW(), NOW())
  `);

  // Create canary memories
  const memoryIds: string[] = [];
  for (let i = 0; i < memoryCount; i++) {
    const memId = `test-mem-${prefix}-${i}-${ts}`;
    memoryIds.push(memId);

    const content = `${canaryPrefix}${i}: This is test memory ${i} for ${prefix}. Topic: ${getCanaryTopic(i)}`;
    await prisma.$executeRawUnsafe(`
      INSERT INTO memories (id, raw, layer, source, importance_score, user_id, created_at, updated_at)
      VALUES (
        '${memId}',
        '${content.replace(/'/g, "''")}',
        'IDENTITY',
        'EXPLICIT_STATEMENT',
        0.5,
        '${userId}',
        NOW() - INTERVAL '${i} days',
        NOW()
      )
    `);
  }

  return { accountId, agentId, userId, apiKey, canaryPrefix, memoryIds };
}

/** Rotating topics so canary memories have varied content */
function getCanaryTopic(i: number): string {
  const topics = [
    'coffee preferences',
    'work project update',
    'family dinner plans',
    'travel booking',
    'health checkup',
    'book recommendation',
    'cooking recipe',
    'financial planning',
    'morning routine',
    'weekend activities',
  ];
  return topics[i % topics.length];
}
