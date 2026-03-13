/**
 * Cleanup script for Engram staging cloud DB.
 * 
 * Run with: npx tsx scripts/cleanup-cloud-db.ts
 * Requires DATABASE_URL env var pointing to the staging DB.
 * 
 * CRITICAL: Do NOT run prisma migrate dev or prisma migrate reset.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DRY_RUN = process.env.DRY_RUN !== 'false'; // default: dry run

const KEEP_AGENTS = {
  beaux: 'cmllz86ff0002kd01v5wqqiy4',
  kit: 'cmlqran5n0001qa01uz6eimq2',
  rook: 'cmlv91gek009ite01qmb107hv',
};

const DELETE_AGENT_IDS = [
  'cmlo08xbm01fmse01adlq48f6', // embed-test
  'cmlo40lfg0001mv01qmjvu5ov', // ChatGPT
  'cmlq0w4f8005fqs01yel4qrpp', // Default Agent
  'cmlq5na1y0003pg01z2uhfxsk', // claude
  'cmlv9u6ev00bbte01hejdz0ag', // Default Agent
  'cmlv9zl9h00nnte01e5f5gwcm', // Default Agent
  'cmlva15a200o1te01552loki4', // Default Agent
];

const JUNK_USER_EXTERNAL_IDS = [
  'fake-user-id-attacker',
  'dashboard-test',
  'your-user-id',
  'test',
  'default',
];

// Kit came online Feb 17, 2026
const KIT_ONLINE_DATE = new Date('2026-02-17T00:00:00Z');

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : '*** LIVE ***'}\n`);

  // 1. Rename Default Agent → Beaux
  console.log('=== Step 1: Rename agent to "Beaux" ===');
  const agent = await prisma.agent.findUnique({ where: { id: KEEP_AGENTS.beaux } });
  console.log(`  Current name: "${agent?.name}" → "Beaux"`);
  if (!DRY_RUN) {
    await prisma.agent.update({
      where: { id: KEEP_AGENTS.beaux },
      data: { name: 'Beaux' },
    });
    console.log('  ✅ Renamed');
  }

  // 2. Delete junk users (by externalId, belonging to kept agents)
  console.log('\n=== Step 2: Delete junk users ===');
  const junkUsers = await prisma.user.findMany({
    where: { externalId: { in: JUNK_USER_EXTERNAL_IDS }, deletedAt: null },
    select: { id: true, externalId: true, accountId: true },
  });
  for (const u of junkUsers) {
    console.log(`  Junk user: ${u.externalId} (${u.id}) account=${u.accountId}`);
  }
  if (!DRY_RUN && junkUsers.length > 0) {
    // Check if any have memories first
    const memCount = await prisma.memory.count({
      where: { userId: { in: junkUsers.map(u => u.id) } },
    });
    console.log(`  Memories owned by junk users: ${memCount}`);
    const result = await prisma.user.deleteMany({
      where: { id: { in: junkUsers.map(u => u.id) } },
    });
    console.log(`  ✅ Deleted ${result.count} junk users`);
  }

  // 3. Delete junk agents (cascade deletes their users)
  console.log('\n=== Step 3: Delete junk agents ===');
  const agentsToDelete = await prisma.agent.findMany({
    where: { id: { in: DELETE_AGENT_IDS } },
    select: { id: true, name: true, accountId: true },
  });
  for (const a of agentsToDelete) {
    const userCount = a.accountId ? await prisma.user.count({ where: { accountId: a.accountId } }) : 0;
    console.log(`  Agent: "${a.name}" (${a.id}) — ${userCount} users (will cascade)`);
  }
  if (!DRY_RUN) {
    // Delete one by one to handle cascades properly
    for (const a of agentsToDelete) {
      await prisma.agent.delete({ where: { id: a.id } });
      console.log(`  ✅ Deleted agent ${a.id}`);
    }
  }

  // 4. Backfill Memory.agentId
  console.log('\n=== Step 4: Backfill Memory.agentId ===');
  const nullCount = await prisma.memory.count({ where: { agentId: null } });
  console.log(`  Memories with agentId=null: ${nullCount}`);

  if (nullCount > 0) {
    const beforeKit = await prisma.memory.count({
      where: { agentId: null, createdAt: { lt: KIT_ONLINE_DATE } },
    });
    const afterKit = nullCount - beforeKit;
    console.log(`  Before ${KIT_ONLINE_DATE.toISOString()}: ${beforeKit} → rook-agent`);
    console.log(`  On/after ${KIT_ONLINE_DATE.toISOString()}: ${afterKit} → Beaux`);

    if (!DRY_RUN) {
      const r1 = await prisma.memory.updateMany({
        where: { agentId: null, createdAt: { lt: KIT_ONLINE_DATE } },
        data: { agentId: KEEP_AGENTS.rook },
      });
      console.log(`  ✅ Backfilled ${r1.count} memories → rook-agent`);

      const r2 = await prisma.memory.updateMany({
        where: { agentId: null, createdAt: { gte: KIT_ONLINE_DATE } },
        data: { agentId: KEEP_AGENTS.beaux },
      });
      console.log(`  ✅ Backfilled ${r2.count} memories → Beaux`);
    }
  }

  // 5. Summary
  console.log('\n=== Final state ===');
  const remainingAgents = await prisma.agent.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, accountId: true },
  });
  console.log(`  Agents: ${remainingAgents.length}`);
  for (const a of remainingAgents) {
    const uc = a.accountId ? await prisma.user.count({ where: { accountId: a.accountId } }) : 0;
    const mc = await prisma.memory.count({ where: { agentId: a.id } });
    console.log(`    ${a.name} (${a.id}): ${uc} users, ${mc} memories`);
  }
  const stillNull = await prisma.memory.count({ where: { agentId: null } });
  console.log(`  Memories with agentId=null: ${stillNull}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
