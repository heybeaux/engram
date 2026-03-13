/**
 * Staging Seeder — fixture-based
 *
 * Reads the 5 test fixture users (alice, bob, carol, dave, eve) and inserts
 * all ~1,210 memories into the staging database via direct Prisma (no RLS proxy).
 *
 * Usage:
 *   DATABASE_URL=<staging-url> npx ts-node --compiler-options '{"module":"CommonJS"}' \
 *     src/scripts/seed-staging.ts
 *
 *   # With --clean flag to remove all seeded data:
 *   DATABASE_URL=<staging-url> npx ts-node --compiler-options '{"module":"CommonJS"}' \
 *     src/scripts/seed-staging.ts --clean
 *
 * NEVER run against production!
 */

import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import * as path from 'path';

// Load fixtures via require to keep the script self-contained at runtime
// (the test/ dir is outside src/ but ts-node handles cross-dir imports fine)
// Note: We use an inline type instead of `typeof import('../../test/fixtures/index')`
// because the test/ directory is excluded from tsconfig.build.json.
interface FixtureMemory {
  fixture_id: string;
  content: string;
  layer: string;
  memoryType?: string;
  source: string;
  importanceScore: number;
  tags: string[];
  created_at: Date;
  metadata?: Record<string, unknown>;
}
interface FixtureUser {
  name: string;
  email: string;
  canaryPrefix: string;
  memories: FixtureMemory[];
}
const fixtureRoot = path.resolve(__dirname, '../../test/fixtures');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ALL_USERS, TOTAL_MEMORY_COUNT } = require(path.join(
  fixtureRoot,
  'index',
)) as { ALL_USERS: FixtureUser[]; TOTAL_MEMORY_COUNT: number };

// ── Constants ───────────────────────────────────────────────────────────────

/** Canary prefixes used by each fixture user — all start with RLS_CANARY_ */
const ALL_CANARY_PREFIXES = ALL_USERS.map((u) => u.canaryPrefix);

/** Stable seeded account/agent IDs so the script is idempotent */
const SEED_PREFIX = 'seed_stg_';

function seedAccountId(name: string) {
  return `${SEED_PREFIX}acct_${name}`;
}
function seedAgentId(name: string) {
  return `${SEED_PREFIX}agent_${name}`;
}
function seedUserId(name: string) {
  return `${SEED_PREFIX}user_${name}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Generate a deterministic-but-unique API key for a fixture user */
function makeApiKey(name: string): string {
  const raw = crypto
    .createHmac('sha256', 'engram-staging-seed-v1')
    .update(name)
    .digest('hex')
    .slice(0, 32);
  return `eng_stg_${name}_${raw}`;
}

// ── Clean mode ──────────────────────────────────────────────────────────────

async function clean(prisma: PrismaClient) {
  console.log('🧹  Cleaning seeded staging data...\n');

  // Memories are identified by canary prefix in their raw content
  // We delete in reverse-dependency order.

  let memCount = 0;
  for (const prefix of ALL_CANARY_PREFIXES) {
    const { count } = await prisma.memory.deleteMany({
      where: { raw: { startsWith: prefix }, deletedAt: null },
    });
    // Also catch soft-deleted ones
    const { count: softCount } = await prisma.memory.deleteMany({
      where: { raw: { startsWith: prefix } },
    });
    memCount += count + softCount;
  }
  console.log(`  Deleted ${memCount} memories`);

  // Delete users, agents, accounts seeded by this script
  for (const name of ALL_USERS.map((u) => u.name)) {
    const userId = seedUserId(name);
    const agentId = seedAgentId(name);
    const accountId = seedAccountId(name);

    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    console.log(`  Cleaned ${name}`);
  }

  console.log('\n✅  Staging data cleaned.\n');
}

// ── Idempotency check ────────────────────────────────────────────────────────

async function alreadySeeded(prisma: PrismaClient): Promise<boolean> {
  for (const prefix of ALL_CANARY_PREFIXES) {
    const count = await prisma.memory.count({
      where: { raw: { startsWith: prefix } },
    });
    if (count > 0) return true;
  }
  return false;
}

// ── Main seeder ──────────────────────────────────────────────────────────────

async function seed(prisma: PrismaClient) {
  console.log('🌱  Seeding staging environment from test fixtures...\n');
  console.log(`   Fixture users : ${ALL_USERS.map((u) => u.name).join(', ')}`);
  console.log(`   Total memories: ~${TOTAL_MEMORY_COUNT}\n`);

  // Safety check
  if (process.env.NODE_ENV === 'production') {
    throw new Error('❌  ABORT: Cannot seed production!');
  }

  // Idempotency
  if (await alreadySeeded(prisma)) {
    console.log(
      '⚠️   Canary memories already exist. Skipping (use --clean first to reseed).\n',
    );
    await printSummaryFromExisting(prisma);
    return;
  }

  const results: Array<{
    name: string;
    email: string;
    accountId: string;
    agentId: string;
    apiKey: string;
    memoryCount: number;
  }> = [];

  for (const fixtureUser of ALL_USERS) {
    const { name, email, canaryPrefix, memories } = fixtureUser;

    console.log(`\n── ${name.toUpperCase()} (${memories.length} memories) ──`);

    const accountId = seedAccountId(name);
    const agentId = seedAgentId(name);
    const userId = seedUserId(name);
    const apiKey = makeApiKey(name);
    const apiKeyHash = sha256(apiKey);

    // 1. Account
    console.log(`   Creating account...`);
    await prisma.account.upsert({
      where: { id: accountId },
      update: {},
      create: {
        id: accountId,
        email: email,
        passwordHash: sha256(`staging-password-${name}`),
        name: `Staging — ${name.charAt(0).toUpperCase() + name.slice(1)}`,
        plan: 'PRO',
        isAdmin: false,
      },
    });

    // 2. Agent (API key holder)
    console.log(`   Creating agent...`);
    await prisma.agent.upsert({
      where: { id: agentId },
      update: {},
      create: {
        id: agentId,
        name: `${name}-staging-agent`,
        apiKeyHash,
        apiKeyHint: apiKey.slice(-8),
        accountId,
      },
    });

    // 3. User
    console.log(`   Creating user...`);
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        externalId: `fixture_${name}`,
        displayName: name.charAt(0).toUpperCase() + name.slice(1),
        accountId,
      },
    });

    // 4. Memories — batch insert
    console.log(`   Inserting ${memories.length} memories...`);
    let inserted = 0;
    const BATCH = 100;

    for (let i = 0; i < memories.length; i += BATCH) {
      const batch = memories.slice(i, i + BATCH);
      await prisma.$transaction(
        batch.map((m) => {
          const priority = derivePriority(m.memoryType);
          return prisma.memory.create({
            data: {
              userId,
              raw: m.content,
              layer: m.layer,
              memoryType: m.memoryType ?? null,
              source: m.source,
              importanceScore: m.importanceScore,
              effectiveScore: m.importanceScore,
              priority,
              tags: m.tags,
              metadata: (m.metadata as any) ?? undefined,
              createdAt: m.created_at,
              // fixture_id stored in metadata for traceability
              // (not a DB column, but useful for debugging)
            } as any,
          });
        }),
      );
      inserted += batch.length;
      process.stdout.write(
        `\r   Inserted ${inserted}/${memories.length} memories...`,
      );
    }
    console.log(`\r   ✓ Inserted ${inserted} memories          `);

    results.push({
      name,
      email,
      accountId,
      agentId,
      apiKey,
      memoryCount: memories.length,
    });
  }

  printSummaryTable(results);
}

function derivePriority(
  memoryType?: string | null,
): number {
  switch (memoryType) {
    case 'CONSTRAINT':
      return 1;
    case 'PREFERENCE':
    case 'TASK':
      return 2;
    case 'FACT':
      return 3;
    default:
      return 4;
  }
}

function printSummaryTable(
  results: Array<{
    name: string;
    email: string;
    accountId: string;
    agentId: string;
    apiKey: string;
    memoryCount: number;
  }>,
) {
  console.log('\n\n📊  STAGING SEED SUMMARY');
  console.log('═'.repeat(120));
  console.log(
    `${'User'.padEnd(8)} ${'Email'.padEnd(30)} ${'AccountID'.padEnd(25)} ${'Memories'.padEnd(10)} API Key`,
  );
  console.log('─'.repeat(120));
  for (const r of results) {
    console.log(
      `${r.name.padEnd(8)} ${r.email.padEnd(30)} ${r.accountId.padEnd(25)} ${String(r.memoryCount).padEnd(10)} ${r.apiKey}`,
    );
  }
  console.log('═'.repeat(120));
  console.log('\n⚠️   Save these API keys — they cannot be recovered!');
  console.log(
    '    Use X-AM-API-Key: <apiKey> header to authenticate with the staging API.\n',
  );
}

async function printSummaryFromExisting(prisma: PrismaClient) {
  console.log('\n📊  EXISTING SEED (reconstructed from DB)');
  console.log('═'.repeat(100));
  for (const u of ALL_USERS) {
    const accountId = seedAccountId(u.name);
    const agentId = seedAgentId(u.name);
    const apiKey = makeApiKey(u.name);
    const count = await prisma.memory.count({
      where: { raw: { startsWith: u.canaryPrefix } },
    });
    console.log(
      `${u.name.padEnd(8)} | ${u.email.padEnd(30)} | ${accountId.padEnd(25)} | ${String(count).padEnd(8)} | ${apiKey}`,
    );
    void agentId; // used for structure, not reprinted
  }
  console.log('═'.repeat(100));
  console.log('\n⚠️   API keys are deterministic — see makeApiKey() to regenerate.\n');
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const isClean = process.argv.includes('--clean');
  const prisma = new PrismaClient();

  try {
    if (isClean) {
      await clean(prisma);
    } else {
      await seed(prisma);
    }
  } catch (err) {
    console.error('\n❌  Seed script failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
