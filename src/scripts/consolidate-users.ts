/**
 * consolidate-users.ts
 *
 * Fixes fragmented user records caused by the old @@unique([agentId, externalId])
 * constraint. Under the old model the same human (e.g. externalId "beaux") would
 * produce a distinct User row per agent, breaking cross-agent memory recall.
 *
 * What this script does (per account):
 *  1. Groups users by (accountId, externalId).
 *  2. For each group with >1 record, picks a canonical (oldest createdAt).
 *  3. Re-points memories / sessions / feedback / graphEntities to the canonical.
 *  4. Backfills Memory.agentId from the old User.agentId where Memory.agentId is null.
 *  5. Soft-deletes duplicates (sets deletedAt = now()).
 *  6. Marks the canonical record isDefault = true when externalId === 'default'.
 *
 * Safe to re-run (idempotent). Use --dry-run to preview without writing.
 *
 * Usage:
 *   npx ts-node src/scripts/consolidate-users.ts [--dry-run]
 */

import { PrismaClient } from '@prisma/client';

const DRY_RUN = process.argv.includes('--dry-run');
const prisma = new PrismaClient();

interface ConsolidationStats {
  accountsProcessed: number;
  groupsConsolidated: number;
  usersDeduped: number;
  memoriesRepointed: number;
  memoriesAgentIdBackfilled: number;
  sessionsRepointed: number;
  feedbackRepointed: number;
  graphEntitiesRepointed: number;
  graphRelationshipsRepointed: number;
  graphMentionsRepointed: number;
  syncUserMapsRepointed: number;
  entityProfilesRepointed: number;
}

async function run() {
  console.log(`🔍 Starting user consolidation${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const stats: ConsolidationStats = {
    accountsProcessed: 0,
    groupsConsolidated: 0,
    usersDeduped: 0,
    memoriesRepointed: 0,
    memoriesAgentIdBackfilled: 0,
    sessionsRepointed: 0,
    feedbackRepointed: 0,
    graphEntitiesRepointed: 0,
    graphRelationshipsRepointed: 0,
    graphMentionsRepointed: 0,
    syncUserMapsRepointed: 0,
    entityProfilesRepointed: 0,
  };

  // Fetch all accounts
  const accounts = await prisma.account.findMany({
    select: { id: true, email: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`📋 Found ${accounts.length} accounts`);

  for (const account of accounts) {
    stats.accountsProcessed++;
    console.log(`\n▶ Account: ${account.email} (${account.id})`);

    // Fetch all non-deleted users for this account
    const users = await (prisma.user as any).findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'asc' },
    });

    // Group by externalId
    const groups = new Map<string, typeof users>();
    for (const user of users) {
      const key = user.externalId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(user);
    }

    for (const [externalId, group] of groups.entries()) {
      if (group.length <= 1) continue;

      // Canonical = oldest (first in createdAt-sorted list)
      const canonical = group[0];
      const duplicates = group.slice(1).filter((u: any) => !u.deletedAt);

      if (duplicates.length === 0) continue;

      stats.groupsConsolidated++;
      console.log(
        `  ⚡ Consolidating externalId="${externalId}": ` +
          `canonical=${canonical.id}, duplicates=[${duplicates.map((u: any) => u.id).join(', ')}]`,
      );

      for (const dup of duplicates) {
        stats.usersDeduped++;

        if (!DRY_RUN) {
          // Re-point memories
          const { count: mCount } = await prisma.memory.updateMany({
            where: { userId: dup.id },
            data: { userId: canonical.id },
          });
          stats.memoriesRepointed += mCount;

          // Backfill Memory.agentId from dup's agentId if null
          // (dup.agentId was the old agent-scoped FK — use it to attribute memories)
          if (dup.agentId) {
            const { count: baCount } = await prisma.memory.updateMany({
              where: { userId: canonical.id, agentId: null },
              data: { agentId: dup.agentId },
            });
            stats.memoriesAgentIdBackfilled += baCount;
          }

          // Re-point sessions
          const { count: sCount } = await prisma.session.updateMany({
            where: { userId: dup.id },
            data: { userId: canonical.id },
          });
          stats.sessionsRepointed += sCount;

          // Re-point feedback
          const { count: fCount } = await prisma.feedback.updateMany({
            where: { userId: dup.id },
            data: { userId: canonical.id },
          });
          stats.feedbackRepointed += fCount;

          // Re-point graph entities
          const { count: geCount } = await prisma.graphEntity.updateMany({
            where: { userId: dup.id },
            data: { userId: canonical.id },
          });
          stats.graphEntitiesRepointed += geCount;

          // Re-point graph relationships
          const { count: grCount } = await prisma.graphRelationship.updateMany({
            where: { userId: dup.id },
            data: { userId: canonical.id },
          });
          stats.graphRelationshipsRepointed += grCount;

          // Re-point graph mentions
          const { count: gmCount } = await prisma.graphEntityMention.updateMany(
            {
              where: { userId: dup.id },
              data: { userId: canonical.id },
            },
          );
          stats.graphMentionsRepointed += gmCount;

          // Re-point sync user maps
          const { count: suCount } = await prisma.syncUserMap.updateMany({
            where: { cloudUserId: dup.id },
            data: { cloudUserId: canonical.id },
          });
          stats.syncUserMapsRepointed += suCount;

          // Re-point entity profiles
          const { count: epCount } = await prisma.entityProfile.updateMany({
            where: { userId: dup.id },
            data: { userId: canonical.id },
          });
          stats.entityProfilesRepointed += epCount;

          // Soft-delete the duplicate
          await (prisma.user as any).update({
            where: { id: dup.id },
            data: { deletedAt: new Date() },
          });
        } else {
          // Dry-run: just count what would happen
          const mCount = await prisma.memory.count({
            where: { userId: dup.id },
          });
          const sCount = await prisma.session.count({
            where: { userId: dup.id },
          });
          stats.memoriesRepointed += mCount;
          stats.sessionsRepointed += sCount;
          console.log(
            `    [dry-run] would repoint ${mCount} memories, ${sCount} sessions from ${dup.id}`,
          );
        }
      }

      // Mark canonical as isDefault when it's the 'default' externalId
      if (!DRY_RUN && externalId === 'default' && !canonical.isDefault) {
        await (prisma.user as any).update({
          where: { id: canonical.id },
          data: { isDefault: true },
        });
        console.log(`  ✅ Marked ${canonical.id} as isDefault=true`);
      }
    }

    // Also mark any user with externalId 'default' as isDefault across the board
    if (!DRY_RUN) {
      await (prisma.user as any).updateMany({
        where: {
          accountId: account.id,
          externalId: 'default',
          isDefault: false,
          deletedAt: null,
        },
        data: { isDefault: true },
      });
    }
  }

  console.log('\n📊 Consolidation summary:');
  console.log(JSON.stringify(stats, null, 2));

  if (DRY_RUN) {
    console.log('\n⚠️  Dry-run mode: no changes written to database.');
  } else {
    console.log('\n✅ Consolidation complete. Next steps:');
    console.log(
      '   Run the migration to add: ALTER TABLE "users" ADD CONSTRAINT "users_account_id_external_id_key" UNIQUE ("account_id", "external_id");',
    );
  }
}

run()
  .catch((err) => {
    console.error('❌ Consolidation failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
