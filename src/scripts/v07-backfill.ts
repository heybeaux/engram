import { Logger } from '@nestjs/common';

const logger = new Logger('V07Backfill');
/**
 * v0.7 Multi-Agent Backfill Script
 *
 * Populates:
 * 1. Default AgentSession for agent:main
 * 2. Global MemoryPool per user
 * 3. MemoryPoolMembership for all existing memories → global pool
 * 4. createdBySession = 'agent:main' for all existing memories
 *
 * Safe to run multiple times (idempotent).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    logger.log('Starting v0.7 multi-agent backfill...');

    // 1. Create default agent session
    const agentSession = await prisma.agentSession.upsert({
      where: { sessionKey: 'agent:main' },
      update: {},
      create: {
        sessionKey: 'agent:main',
        label: 'Primary Agent',
        status: 'ACTIVE',
      },
    });
    logger.log(
      `✓ Agent session: ${agentSession.id} (${agentSession.sessionKey})`,
    );

    // 2. Create global pool per user
    const users = await prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true, externalId: true },
    });

    for (const user of users) {
      const pool = await prisma.memoryPool.upsert({
        where: { userId_name: { userId: user.id, name: 'global' } },
        update: {},
        create: {
          name: 'global',
          userId: user.id,
          visibility: 'GLOBAL',
          createdBy: 'agent:main',
        },
      });
      logger.log(`✓ Global pool for user ${user.externalId}: ${pool.id}`);

      // 3. Add all existing memories to global pool
      const memories = await prisma.memory.findMany({
        where: { userId: user.id, deletedAt: null },
        select: { id: true },
      });

      let added = 0;
      for (const memory of memories) {
        try {
          await prisma.memoryPoolMembership.create({
            data: {
              memoryId: memory.id,
              poolId: pool.id,
              addedBy: 'agent:main',
            },
          });
          added++;
        } catch (e: any) {
          // Skip duplicates (unique constraint)
          if (e.code !== 'P2002') throw e;
        }
      }
      logger.log(
        `  ✓ Added ${added}/${memories.length} memories to global pool`,
      );
    }

    // 4. Attribute all existing memories to agent:main
    const updated = await prisma.memory.updateMany({
      where: { createdBySession: null },
      data: { createdBySession: 'agent:main' },
    });
    logger.log(`✓ Attributed ${updated.count} memories to agent:main`);

    logger.log('\nBackfill complete!');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  logger.error('Backfill failed:', e);
  process.exit(1);
});
