/**
 * Canary Factory — Seeds two test users with canary-tagged memories
 * for RLS isolation testing.
 *
 * Each user's memories contain a unique canary prefix in the `raw` field.
 * If any endpoint returns memories with the OTHER user's canary prefix,
 * RLS isolation is broken.
 */

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
          `DELETE FROM "Memory" WHERE "userId" IN (
            SELECT id FROM "User" WHERE "agentId" = '${u.agentId}'
          )`,
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM "User" WHERE "agentId" = '${u.agentId}'`,
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM "Agent" WHERE id = '${u.agentId}'`,
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM "Account" WHERE id = '${u.accountId}'`,
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
  const accountId = `test-account-${prefix}-${Date.now()}`;
  const agentId = `test-agent-${prefix}-${Date.now()}`;
  const apiKey = `eng_test_${prefix}_${Date.now()}`;

  // Create account
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Account" (id, email, "createdAt", "updatedAt")
    VALUES ('${accountId}', '${prefix}@test.engram.local', NOW(), NOW())
  `);

  // Create agent with API key
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Agent" (id, name, "accountId", "apiKey", "createdAt", "updatedAt")
    VALUES ('${agentId}', '${prefix}', '${accountId}', '${apiKey}', NOW(), NOW())
  `);

  // Create user
  const userId = `test-user-${prefix}-${Date.now()}`;
  await prisma.$executeRawUnsafe(`
    INSERT INTO "User" (id, "agentId", "createdAt", "updatedAt")
    VALUES ('${userId}', '${agentId}', NOW(), NOW())
  `);

  // Create canary memories
  const memoryIds: string[] = [];
  for (let i = 0; i < memoryCount; i++) {
    const memId = `test-mem-${prefix}-${i}-${Date.now()}`;
    memoryIds.push(memId);

    const content = `${canaryPrefix}${i}: This is test memory ${i} for ${prefix}. Topic: ${getCanaryTopic(i)}`;
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Memory" (id, raw, type, source, importance, "userId", "createdAt", "updatedAt", "searchable")
      VALUES (
        '${memId}',
        '${content.replace(/'/g, "''")}',
        'episodic',
        'CONVERSATION',
        0.5,
        '${userId}',
        NOW() - INTERVAL '${i} days',
        NOW(),
        true
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
