/**
 * HEY-132: User table cleanup script
 *
 * Identifies and safely removes orphaned/duplicate/test users from the database.
 *
 * ## What it does
 * 1. **Duplicate users**: Finds users with the same (externalId, agentId) pair.
 *    Keeps the oldest record, migrates all related data (memories, sessions, etc.)
 *    from duplicates to the keeper, then soft-deletes the duplicates.
 * 2. **Test/demo users**: Finds users whose externalId or displayName contains
 *    "test", "demo", "fake", "seed", or "sample" AND have 0 memories.
 *    Deletes related rows (should be 0) and soft-deletes the user.
 * 3. **Other orphans**: Finds non-duplicate, non-test users with 0 memories
 *    AND no related data in any FK table. Soft-deletes them if truly orphaned.
 *
 * ## Safety
 * - **Dry run by default**: Running without DRY_RUN=false only prints what
 *   would happen — no database changes are made.
 * - **Soft delete**: Users are never hard-deleted; `deletedAt` is set instead.
 * - **Data migration**: For duplicates, all FK references are migrated to the
 *   keeper before soft-deleting.
 * - **Confirmation prompt**: In live mode, you must type "yes" to proceed.
 *
 * ## Usage
 *   npx ts-node scripts/cleanup-users.ts                  # dry run (default)
 *   DRY_RUN=false npx ts-node scripts/cleanup-users.ts    # live run (with confirmation)
 *
 * ## Known results (dry-run 2025)
 * - 1 safe-to-remove orphan: cmlq314uk001ec9jy8yx7efhp (0 memories, 0 related data)
 */

import { PrismaClient } from '@prisma/client';
import * as readline from 'readline';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN !== 'false';

/** Prompt user for confirmation. Returns true if they type "yes". */
async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${message} (type "yes" to confirm): `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

// Tables that reference user_id and need to be migrated or cleaned
const USER_FK_TABLES = [
  'memories', 'sessions', 'projects', 'feedback', 'entities',
  'graph_entities', 'graph_relationships', 'graph_entity_mentions',
  'memory_pools', 'webhook_subscriptions', 'hierarchy_units',
  'memory_merge_events', 'merge_candidates', 'dedup_configs',
  'dedup_batch_runs', 'audit_logs', 'consolidation_jobs',
  'dream_cycle_reports',
] as const;

const TEST_PATTERNS = ['test', 'demo', 'fake', 'seed', 'sample'];

interface UserWithCounts {
  id: string;
  externalId: string;
  displayName: string | null;
  accountId: string;
  createdAt: Date;
  _count: { memories: number };
}

async function getUsers(): Promise<UserWithCounts[]> {
  return prisma.user.findMany({
    where: { deletedAt: null },
    include: { _count: { select: { memories: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

function isTestUser(u: UserWithCounts): boolean {
  const ext = u.externalId.toLowerCase();
  const name = (u.displayName || '').toLowerCase();
  return TEST_PATTERNS.some(p => ext.includes(p) || name.includes(p));
}

async function findDuplicates(users: UserWithCounts[]) {
  const groups = new Map<string, UserWithCounts[]>();
  for (const u of users) {
    const key = `${u.accountId}::${u.externalId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(u);
  }
  return [...groups.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([key, v]) => ({ key, users: v.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) }));
}

async function migrateUserData(fromId: string, toId: string) {
  console.log(`  Migrating data from ${fromId} → ${toId}`);
  for (const table of USER_FK_TABLES) {
    const result = await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET user_id = $1 WHERE user_id = $2`,
      toId, fromId
    );
    if (result > 0) console.log(`    ${table}: ${result} rows moved`);
  }
  // Also handle sync_user_map
  const syncResult = await prisma.$executeRawUnsafe(
    `UPDATE sync_user_map SET user_id = $1 WHERE user_id = $2`,
    toId, fromId
  );
  if (syncResult > 0) console.log(`    sync_user_map: ${syncResult} rows moved`);
}

async function softDeleteUser(id: string) {
  console.log(`  Soft-deleting user ${id}`);
  await prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });
}

async function countRelatedRows(userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of USER_FK_TABLES) {
    const result = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT count(*) as count FROM "${table}" WHERE user_id = $1`, userId
    );
    const n = Number(result[0].count);
    if (n > 0) counts[table] = n;
  }
  return counts;
}

async function main() {
  console.log(`\n🔍 HEY-132 User Cleanup — ${DRY_RUN ? 'DRY RUN' : '⚠️  LIVE RUN'}\n`);

  if (!DRY_RUN) {
    const confirmed = await confirm(
      '⚠️  This will modify the database. Are you sure you want to proceed?',
    );
    if (!confirmed) {
      console.log('Aborted.');
      await prisma.$disconnect();
      process.exit(0);
    }
    console.log('');
  }

  const users = await getUsers();
  console.log(`Total active users: ${users.length}\n`);

  // 1. Find duplicates
  const dupes = await findDuplicates(users);
  console.log(`=== DUPLICATE GROUPS (same externalId + agentId): ${dupes.length} ===`);
  for (const { key, users: group } of dupes) {
    const keeper = group[0];
    const toRemove = group.slice(1);
    console.log(`\n  Key: ${key}`);
    console.log(`  Keeper: ${keeper.id} (created ${keeper.createdAt.toISOString()}, ${keeper._count.memories} memories)`);
    for (const u of toRemove) {
      const related = await countRelatedRows(u.id);
      console.log(`  Remove: ${u.id} (created ${u.createdAt.toISOString()}, ${u._count.memories} memories)`);
      if (Object.keys(related).length > 0) {
        console.log(`    Related data to migrate: ${JSON.stringify(related)}`);
      }
      if (!DRY_RUN) {
        await migrateUserData(u.id, keeper.id);
        await softDeleteUser(u.id);
      }
    }
  }

  // 2. Find test/demo users with 0 memories
  const testUsers = users.filter(u => isTestUser(u));
  const testUsersZero = testUsers.filter(u => u._count.memories === 0);
  console.log(`\n=== TEST/DEMO USERS: ${testUsers.length} total, ${testUsersZero.length} with 0 memories ===`);
  for (const u of testUsers) {
    const related = await countRelatedRows(u.id);
    const action = u._count.memories === 0 ? '🗑️  REMOVE' : '⚠️  KEEP (has memories)';
    console.log(`  ${action}: ${u.id} ext=${u.externalId} name=${u.displayName || '(none)'} memories=${u._count.memories}`);
    if (Object.keys(related).length > 0) {
      console.log(`    Related: ${JSON.stringify(related)}`);
    }
    if (!DRY_RUN && u._count.memories === 0) {
      // Delete related rows first (should be 0 for most)
      for (const table of USER_FK_TABLES) {
        await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE user_id = $1`, u.id);
      }
      await prisma.$executeRawUnsafe(`DELETE FROM sync_user_map WHERE user_id = $1`, u.id);
      await softDeleteUser(u.id);
    }
  }

  // 3. Other users with 0 memories (not test, not duplicate)
  const dupeIds = new Set(dupes.flatMap(d => d.users.slice(1).map(u => u.id)));
  const testIds = new Set(testUsers.map(u => u.id));
  const orphanZero = users.filter(u => u._count.memories === 0 && !dupeIds.has(u.id) && !testIds.has(u.id));
  console.log(`\n=== OTHER USERS WITH 0 MEMORIES: ${orphanZero.length} ===`);
  for (const u of orphanZero) {
    const related = await countRelatedRows(u.id);
    console.log(`  ${u.id} ext=${u.externalId} name=${u.displayName || '(none)'} created=${u.createdAt.toISOString()}`);
    if (Object.keys(related).length > 0) {
      console.log(`    Related: ${JSON.stringify(related)} — SKIPPING (has related data)`);
    } else {
      console.log(`    No related data — safe to remove`);
      if (!DRY_RUN) await softDeleteUser(u.id);
    }
  }

  // Summary
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total users: ${users.length}`);
  console.log(`Duplicate groups: ${dupes.length}`);
  console.log(`Test/demo users: ${testUsers.length} (${testUsersZero.length} removable)`);
  console.log(`Other 0-memory users: ${orphanZero.length}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN — no changes made' : 'LIVE — changes applied'}\n`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
