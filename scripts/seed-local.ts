import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync } from 'fs';

async function main() {
  const adapter = new PrismaPg({ connectionString: 'postgresql://postgres:postgres@localhost:54322/engram_kit' });
  const prisma = new PrismaClient({ adapter });

  const memories = JSON.parse(readFileSync('/tmp/memory-recovery/memory-snapshots/complete-dataset.json', 'utf-8'));
  console.log(`Loading ${memories.length} memories...`);

  let success = 0, failed = 0;
  const BATCH = 200;
  const VALID_LAYERS = ['IDENTITY','PROJECT','SESSION','TASK','INSIGHT'];
  const VALID_SOURCES = ['EXPLICIT_STATEMENT','AGENT_OBSERVATION','AGENT_REFLECTION','CORRECTION','PATTERN_DETECTED','SYSTEM','GIT_HISTORY'];

  for (let i = 0; i < memories.length; i += BATCH) {
    const batch = memories.slice(i, i + BATCH);
    const data = batch.map((m: any) => ({
      raw: m.raw || m.content || '',
      layer: VALID_LAYERS.includes(m.layer) ? m.layer : 'TASK',
      source: VALID_SOURCES.includes(m.source) ? m.source : 'AGENT_OBSERVATION',
      userId: 'local-beaux',
      priority: m.priority || 3,
      confidence: m.confidence || 1.0,
      importanceScore: m.importanceScore || 0.5,
      effectiveScore: m.effectiveScore || 0.5,
      subjectType: 'USER' as const,
      subjectId: 'local-beaux',
    })).filter((d: any) => d.raw.trim().length > 0);
    
    try {
      const result = await prisma.memory.createMany({ data, skipDuplicates: true });
      success += result.count;
    } catch(e: any) {
      failed += batch.length;
      console.error(`Batch ${i}: ${e.message.slice(0,150)}`);
    }
    
    if ((i + BATCH) % 1000 === 0 || i + BATCH >= memories.length) {
      console.log(`Progress: ${Math.min(i+BATCH, memories.length)}/${memories.length} ok=${success} fail=${failed}`);
    }
  }

  const total = await prisma.memory.count();
  console.log(`\nDone. ${success} inserted. Total in DB: ${total}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
