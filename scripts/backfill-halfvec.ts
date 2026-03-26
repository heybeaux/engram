/**
 * Backfill halfvec shadow column — ENG-51
 *
 * Casts existing float32 embeddings to float16 (halfvec) in batches.
 * Safe to re-run: only updates rows where embedding_halfvec IS NULL.
 *
 * Usage:
 *   npx ts-node scripts/backfill-halfvec.ts
 */

import { PrismaClient } from '@prisma/client';

const BATCH_SIZE = 500;

async function main() {
  const prisma = new PrismaClient();

  try {
    // Check pgvector version
    const [{ extversion }] = await prisma.$queryRaw<
      { extversion: string }[]
    >`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;

    console.log(`pgvector version: ${extversion}`);

    const [major, minor] = extversion.split('.').map(Number);
    if (major === 0 && minor < 7) {
      console.error(
        `ERROR: pgvector >= 0.7.0 required for halfvec. Found ${extversion}`,
      );
      process.exit(1);
    }

    // Check if shadow column exists
    const colCheck = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count FROM information_schema.columns
      WHERE table_name = 'memory_embeddings' AND column_name = 'embedding_halfvec'
    `;
    if (Number(colCheck[0].count) === 0) {
      console.error(
        'ERROR: embedding_halfvec column not found. Run the migration first.',
      );
      process.exit(1);
    }

    // Count rows to backfill
    const [{ total }] = await prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*) as total FROM memory_embeddings
      WHERE embedding IS NOT NULL AND embedding_halfvec IS NULL
    `;
    const totalRows = Number(total);
    console.log(`Rows to backfill: ${totalRows}`);

    if (totalRows === 0) {
      console.log('Nothing to backfill — all rows already have halfvec.');
      return;
    }

    const startTime = Date.now();
    let updated = 0;
    let batchNum = 0;

    while (updated < totalRows) {
      batchNum++;
      const [result] = await prisma.$queryRaw<{ count: bigint }[]>`
        WITH batch AS (
          SELECT id FROM memory_embeddings
          WHERE embedding IS NOT NULL AND embedding_halfvec IS NULL
          LIMIT ${BATCH_SIZE}
        )
        UPDATE memory_embeddings me
        SET embedding_halfvec = me.embedding::halfvec(768)
        FROM batch
        WHERE me.id = batch.id
        RETURNING (SELECT COUNT(*) FROM batch) as count
      `;

      // If no rows returned, we're done (handles race condition)
      if (!result) break;

      const batchCount = Number(result.count);
      if (batchCount === 0) break;

      updated += batchCount;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `  Batch ${batchNum}: ${batchCount} rows (${updated}/${totalRows}, ${elapsed}s)`,
      );
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nBackfill complete: ${updated} rows in ${totalTime}s`);
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
