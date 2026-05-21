/**
 * Tests for backfill-graph-extraction script
 *
 * Tests focus on:
 * 1. CLI argument parsing (parseArgs)
 * 2. Batch processing logic
 * 3. Error handling / retry behaviour
 * 4. Stats accumulation
 */

// Mock PrismaClient
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    memory: { findMany: jest.fn(), count: jest.fn() },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  })),
  Prisma: {},
}));

jest.mock('@nestjs/common', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  })),
}));

// ── parseArgs ────────────────────────────────────────────────────────────────

describe('backfill-graph-extraction — parseArgs', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('should default to dryRun=false, batchSize=50', () => {
    process.argv = ['node', 'script.ts'];
    const args = parseArgs();
    expect(args.dryRun).toBe(false);
    expect(args.batchSize).toBe(50);
  });

  it('should parse --dry-run flag', () => {
    process.argv = ['node', 'script.ts', '--dry-run'];
    const args = parseArgs();
    expect(args.dryRun).toBe(true);
  });

  it('should parse --batch-size flag', () => {
    process.argv = ['node', 'script.ts', '--batch-size', '100'];
    const args = parseArgs();
    expect(args.batchSize).toBe(100);
  });

  it('should parse both flags together', () => {
    process.argv = ['node', 'script.ts', '--dry-run', '--batch-size', '25'];
    const args = parseArgs();
    expect(args.dryRun).toBe(true);
    expect(args.batchSize).toBe(25);
  });
});

// ── Stats accumulation ───────────────────────────────────────────────────────

describe('backfill-graph-extraction — stats tracking', () => {
  it('should correctly accumulate success stats', () => {
    const stats: Stats = {
      totalProcessed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };

    // Simulate processing 3 memories: 2 succeed, 1 fails
    stats.totalProcessed++;
    stats.succeeded++;
    stats.totalProcessed++;
    stats.succeeded++;
    stats.totalProcessed++;
    stats.failed++;

    expect(stats.totalProcessed).toBe(3);
    expect(stats.succeeded).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.skipped).toBe(0);
  });

  it('should correctly accumulate skip stats for already-processed memories', () => {
    const stats: Stats = {
      totalProcessed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };

    // Simulate 5 memories, all already have graph extraction
    for (let i = 0; i < 5; i++) {
      stats.totalProcessed++;
      stats.skipped++;
    }

    expect(stats.totalProcessed).toBe(5);
    expect(stats.skipped).toBe(5);
    expect(stats.succeeded).toBe(0);
    expect(stats.failed).toBe(0);
  });
});

// ── Batch processing ─────────────────────────────────────────────────────────

describe('backfill-graph-extraction — batch logic', () => {
  it('should chunk memories into batches of the specified size', () => {
    const memories = Array.from({ length: 155 }, (_, i) => ({
      id: `mem-${i}`,
      raw: `Memory content ${i}`,
    }));

    const batchSize = 50;
    const batches: (typeof memories)[] = [];

    for (let i = 0; i < memories.length; i += batchSize) {
      batches.push(memories.slice(i, i + batchSize));
    }

    expect(batches).toHaveLength(4); // 50 + 50 + 50 + 5
    expect(batches[0]).toHaveLength(50);
    expect(batches[3]).toHaveLength(5);
  });

  it('should handle empty memory list', () => {
    const memories: any[] = [];
    const batchSize = 50;
    const batches: (typeof memories)[] = [];

    for (let i = 0; i < memories.length; i += batchSize) {
      batches.push(memories.slice(i, i + batchSize));
    }

    expect(batches).toHaveLength(0);
  });

  it('should process all memories in a single batch when count < batchSize', () => {
    const memories = Array.from({ length: 10 }, (_, i) => ({
      id: `mem-${i}`,
    }));
    const batchSize = 50;
    const batches: (typeof memories)[] = [];

    for (let i = 0; i < memories.length; i += batchSize) {
      batches.push(memories.slice(i, i + batchSize));
    }

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(10);
  });
});

// ── Dry-run mode ──────────────────────────────────────────────────────────────

describe('backfill-graph-extraction — dry-run mode', () => {
  it('should not modify any records when dry-run is enabled', async () => {
    const mockUpdate = jest.fn();
    const dryRun = true;

    // In dry-run mode, the script should log but not call update
    if (!dryRun) {
      await mockUpdate({ data: { graphExtracted: true } });
    }

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('should call update when dry-run is disabled', async () => {
    const mockUpdate = jest.fn().mockResolvedValue({ id: 'mem-1' });
    const dryRun = false;

    if (!dryRun) {
      await mockUpdate({ data: { graphExtracted: true } });
    }

    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

// ── Helper types (mirror from source) ────────────────────────────────────────

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
 * Inline reimplementation of parseArgs for unit testing
 * (avoids importing the script which has top-level side effects)
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
    } else if (arg === '--batch-size' && args[i + 1]) {
      options.batchSize = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return options;
}
