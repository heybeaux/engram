import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
const adapter = new PrismaPg({ connectionString: 'postgresql://postgres:postgres@localhost:54322/engram_kit' });
const prisma = new PrismaClient({ adapter });
async function main() {
  // Count first
  const count = await prisma.memory.count({
    where: { layer: 'INSIGHT', deletedAt: null },
  });
  console.log(`Total INSIGHT memories: ${count}`);

  // Delete the spam patterns
  const r1 = await prisma.memory.deleteMany({
    where: { layer: 'INSIGHT', raw: { startsWith: 'Cross-cutting memory sample' } },
  });
  const r2 = await prisma.memory.deleteMany({
    where: { layer: 'INSIGHT', raw: { startsWith: 'Active entity cluster' } },
  });
  const r3 = await prisma.memory.deleteMany({
    where: { layer: 'INSIGHT', raw: { startsWith: '[Behavioral Consistency]' } },
  });
  console.log(`Deleted: ${r1.count} cross-cutting + ${r2.count} entity cluster + ${r3.count} behavioral = ${r1.count + r2.count + r3.count} total`);
  
  const remaining = await prisma.memory.count({
    where: { layer: 'INSIGHT', deletedAt: null },
  });
  console.log(`Remaining INSIGHT memories: ${remaining}`);
}
main().then(() => prisma.$disconnect());
