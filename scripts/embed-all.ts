import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as http from 'http';

const adapter = new PrismaPg({ connectionString: 'postgresql://postgres:postgres@localhost:54322/engram_kit' });
const prisma = new PrismaClient({ adapter });

const MODELS = ['bge-base', 'minilm', 'gte-base', 'nomic'];
const DIMS: Record<string, number> = { 'bge-base': 768, 'minilm': 384, 'gte-base': 768, 'nomic': 768 };
const BATCH = 10;

function embedBatch(texts: string[], model: string): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ input: texts.map(t => t.slice(0, 512)), model });
    const req = http.request({
      hostname: '127.0.0.1', port: 8080, path: '/v1/embeddings',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          const embeddings = d.data?.map((e: any) => e.embedding) || [];
          resolve(embeddings);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function main() {
  const memories = await prisma.memory.findMany({
    where: { deletedAt: null },
    select: { id: true, raw: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`Total memories: ${memories.length}`);

  for (const model of MODELS) {
    console.log(`\n=== Embedding with ${model} (${DIMS[model]}d) ===`);
    
    // Find which memories already have this model's embedding
    const existing = await prisma.memoryEmbedding.findMany({
      where: { modelId: model },
      select: { memoryId: true },
    });
    const existingSet = new Set(existing.map(e => e.memoryId));
    const pending = memories.filter(m => !existingSet.has(m.id));
    console.log(`  Pending: ${pending.length} (${existing.length} already done)`);

    let ok = 0, fail = 0;
    const start = Date.now();

    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      try {
        const embeddings = await embedBatch(batch.map(m => m.raw), model);
        
        for (let j = 0; j < batch.length && j < embeddings.length; j++) {
          const vecStr = '[' + embeddings[j].join(',') + ']';
          const dims = DIMS[model];
          try {
            await prisma.$executeRaw`
              INSERT INTO memory_embeddings (id, memory_id, model_id, dimensions, embedding, created_at, updated_at)
              VALUES (gen_random_uuid()::text, ${batch[j].id}, ${model}, ${dims}, ${vecStr}::vector, NOW(), NOW())
              ON CONFLICT (memory_id, model_id) DO NOTHING
            `;
            ok++;
          } catch(e: any) {
            fail++;
            if (fail <= 5) console.error(`  Store fail: ${e.message?.slice(0, 100)}`);
          }
        }
      } catch(e: any) {
        fail += batch.length;
        if (fail <= 5) console.error(`  Embed fail: ${e.message?.slice(0, 100)}`);
      }

      if ((i + BATCH) % 200 === 0 || i + BATCH >= pending.length) {
        const elapsed = (Date.now() - start) / 1000;
        const rate = ok / elapsed;
        const eta = pending.length > ok ? (pending.length - ok) / rate : 0;
        console.log(`  ${model}: ${ok}/${pending.length} (${rate.toFixed(1)}/s, ETA ${eta.toFixed(0)}s) fail=${fail}`);
      }
    }
  }

  const totalEmbs = await prisma.memoryEmbedding.count();
  console.log(`\nDone. Total embeddings stored: ${totalEmbs}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e.message); process.exit(1); });
