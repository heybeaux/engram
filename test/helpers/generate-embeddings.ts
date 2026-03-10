/**
 * Generate Embeddings for Seeded Corpus
 *
 * After seeding memories via raw SQL (which skips embedding generation),
 * this helper generates real embedding vectors using the configured
 * EmbeddingService and writes them to both the memories.embedding column
 * and the memory_embeddings table (for pgvector search).
 *
 * Used by the recall benchmark to wire up real semantic search.
 */

import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { EmbeddingService } from '../../src/embedding/embedding.service';
import type { SeedCorpusResult } from './seed-corpus';

const logger = new Logger('GenerateEmbeddings');

const BATCH_SIZE = 10;
/** Max chars to send to embedding model (~375 words ≈ 512 tokens for bge-base) */
const MAX_EMBED_CHARS = 1500;

interface MemoryRow {
  id: string;
  raw: string;
  user_id: string;
  layer: string;
}

/**
 * Generate and store embedding vectors for all memories in the seeded corpus.
 *
 * @param prisma - PrismaService for DB access
 * @param embeddingService - The real EmbeddingService (from embedding module)
 * @param corpus - Result from seedCorpus() with user IDs
 */
export async function generateCorpusEmbeddings(
  prisma: PrismaService,
  embeddingService: EmbeddingService,
  corpus: SeedCorpusResult,
): Promise<void> {
  const userIds = corpus.seededUsers.map((u) => u.userId);

  // Fetch all seeded memories
  const placeholders = userIds.map((_, i) => `$${i + 1}`).join(', ');
  const memories = await prisma.$queryRawUnsafe<MemoryRow[]>(
    `SELECT id, raw, user_id, layer FROM memories WHERE user_id IN (${placeholders}) ORDER BY id`,
    ...userIds,
  );

  logger.log(
    `Generating embeddings for ${memories.length} memories (batch size: ${BATCH_SIZE})...`,
  );

  const modelName = embeddingService.getModelName();
  const dimensions = embeddingService.getDimensions();
  let processed = 0;

  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE);
    const texts = batch.map((m) =>
      m.raw.length > MAX_EMBED_CHARS
        ? m.raw.slice(0, MAX_EMBED_CHARS)
        : m.raw,
    );

    // Generate embeddings in batch
    const embeddings = await embeddingService.embed(texts);

    // Write each embedding to DB
    for (let j = 0; j < batch.length; j++) {
      const mem = batch[j];
      const embedding = embeddings[j];
      const embeddingStr = `[${embedding.join(',')}]`;

      // Update embedding status (skip inline embedding column — it's vector(1536) for OpenAI,
      // but our CI model produces 768-dim vectors. Search uses memory_embeddings table anyway.)
      await prisma.$executeRawUnsafe(
        `UPDATE memories SET embedding_status = 'COMPLETE' WHERE id = $1`,
        mem.id,
      );

      // Insert into memory_embeddings table (used by pgvector search)
      await prisma.$executeRawUnsafe(
        `INSERT INTO memory_embeddings (id, memory_id, model_id, dimensions, embedding, created_at, updated_at)
         VALUES (
           concat('bench_', substr(md5(random()::text), 1, 20)),
           $1, $2, $3, $4::vector, NOW(), NOW()
         )
         ON CONFLICT (memory_id, model_id)
         DO UPDATE SET embedding = $4::vector, updated_at = NOW()`,
        mem.id,
        modelName,
        dimensions,
        embeddingStr,
      );
    }

    processed += batch.length;
    if (processed % 20 === 0 || processed === memories.length) {
      logger.log(`  Embedded ${processed}/${memories.length} memories`);
    }
  }

  logger.log(
    `✓ All ${memories.length} memories embedded (model: ${modelName}, dims: ${dimensions})`,
  );
}
