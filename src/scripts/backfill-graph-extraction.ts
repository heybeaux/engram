import { Logger } from '@nestjs/common';
import { PrismaClient, Memory } from '@prisma/client';

const logger = new Logger('BackfillGraphExtraction');

interface CLIOptions {
  dryRun: boolean;
  batchSize: number;
}

interface Stats {
  totalProcessed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * Parse command line arguments
 */
function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    dryRun: false,
    batchSize: 50,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--batch-size' && i + 1 < args.length) {
      const size = parseInt(args[i + 1], 10);
      if (!isNaN(size) && size > 0) {
        options.batchSize = size;
        i++; // Skip the next argument since we consumed it
      }
    }
  }

  return options;
}

/**
 * Query memories with no graph entities using LEFT JOIN as specified
 */
async function findMemoriesWithoutGraphEntities(
  prisma: PrismaClient,
  offset: number,
  limit: number,
): Promise<Array<{ id: string; content: string }>> {
  return prisma.$queryRaw<Array<{ id: string; content: string }>>`
    SELECT m.id, m.content 
    FROM memories m
    LEFT JOIN graph_entity_mentions ge ON ge.memory_id = m.id
    WHERE ge.id IS NULL 
      AND m.deleted_at IS NULL
    ORDER BY m.created_at ASC
    OFFSET ${offset}
    LIMIT ${limit}
  `;
}

/**
 * Fetch full memory objects for processing
 */
async function getFullMemories(
  prisma: PrismaClient,
  memoryIds: string[],
): Promise<Memory[]> {
  return prisma.memory.findMany({
    where: {
      id: { in: memoryIds },
      deletedAt: null,
    },
  });
}

/**
 * Count memories with no graph entities
 */
async function countMemoriesWithoutGraphEntities(
  prisma: PrismaClient,
): Promise<number> {
  const result = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count
    FROM memories m
    LEFT JOIN graph_entity_mentions ge ON ge.memory_id = m.id
    WHERE ge.id IS NULL 
      AND m.deleted_at IS NULL
  `;
  return Number(result[0].count);
}

/**
 * Process a batch of memories
 */
async function processBatch(
  extractionService: any,
  memories: Memory[],
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;

  for (const memory of memories) {
    try {
      await extractionService.processMemory(memory);
      succeeded++;
    } catch (error) {
      logger.error(`Failed to process memory ${memory.id}: ${error.message}`);
      failed++;
    }
  }

  return { succeeded, failed };
}

/**
 * Main backfill function
 */
async function main() {
  const options = parseArgs();

  logger.log('Starting graph extraction backfill...');
  logger.log(`Options: ${JSON.stringify(options)}`);

  const prisma = new PrismaClient();

  try {
    // Count total memories to process
    const totalCount = await countMemoriesWithoutGraphEntities(prisma);
    logger.log(`Found ${totalCount} memories without graph entities`);

    if (options.dryRun) {
      logger.log(
        `DRY RUN: Would process ${totalCount} memories in batches of ${options.batchSize}`,
      );
      return;
    }

    if (totalCount === 0) {
      logger.log('No memories to process. Exiting.');
      return;
    }

    // Create NestJS application context once
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('../app.module');

    logger.log('Initializing NestJS application context...');
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false, // Disable NestJS startup logs
    });

    let extractionService;
    try {
      const {
        GraphExtractionService,
      } = require('../graph/services/graph-extraction.service');
      extractionService = app.get(GraphExtractionService);

      // Check if graph extraction is enabled
      if (!extractionService.isEnabled()) {
        logger.warn(
          'Graph extraction is disabled (GRAPH_ENABLED != true). Exiting.',
        );
        return;
      }

      const stats: Stats = {
        totalProcessed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      };

      let offset = 0;
      const startTime = Date.now();

      while (offset < totalCount) {
        const batchStart = Date.now();

        // Get basic memory info using the specified LEFT JOIN query
        const memoryBasics = await findMemoriesWithoutGraphEntities(
          prisma,
          offset,
          options.batchSize,
        );

        if (memoryBasics.length === 0) {
          break;
        }

        // Fetch full memory objects for processing
        const memoryIds = memoryBasics.map((m) => m.id);
        const memories = await getFullMemories(prisma, memoryIds);

        const batchResult = await processBatch(extractionService, memories);

        stats.totalProcessed += memories.length;
        stats.succeeded += batchResult.succeeded;
        stats.failed += batchResult.failed;

        const progress = ((stats.totalProcessed / totalCount) * 100).toFixed(1);
        const batchTime = Date.now() - batchStart;

        logger.log(
          `Processed ${stats.totalProcessed}/${totalCount} (${progress}%) - ` +
            `Batch: ${batchResult.succeeded} succeeded, ${batchResult.failed} failed ` +
            `(${batchTime}ms)`,
        );

        offset += options.batchSize;
      }

      const totalTime = Date.now() - startTime;
      logger.log('\n=== BACKFILL SUMMARY ===');
      logger.log(`Total processed: ${stats.totalProcessed}`);
      logger.log(`Succeeded: ${stats.succeeded}`);
      logger.log(`Failed: ${stats.failed}`);
      logger.log(`Skipped: ${stats.skipped}`);
      logger.log(`Total time: ${(totalTime / 1000).toFixed(2)}s`);
      logger.log('Backfill complete!');
    } finally {
      await app.close();
    }
  } catch (error) {
    logger.error('Backfill failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  logger.error('Script failed:', error);
  process.exit(1);
});
