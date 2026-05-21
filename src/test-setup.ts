/**
 * Global Jest setup: auto-close NestJS TestingModules after each test suite.
 * This prevents open handles from unclosed modules (Prisma connections, intervals, etc.)
 *
 * ENG-25: Also enforces that tests NEVER run against a production or staging database.
 */
import { Test, TestingModule } from '@nestjs/testing';

// ---------------------------------------------------------------------------
// ENG-25: Production/staging database guard
// ---------------------------------------------------------------------------
// Hostnames that indicate a non-test database. Add more patterns here as
// needed (e.g. additional cloud providers).
const FORBIDDEN_DB_HOSTNAMES = [
  'railway.app',
  'proxy.rlwy.net',
  '.supabase.co',
  '.neon.tech',
  'rds.amazonaws.com',
  '.cockroachlabs.cloud',
  '.planetscale.com',
];

function checkDatabaseUrl(): void {
  const url = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? '';

  if (!url) {
    // No URL configured — let Prisma handle it (may fail later, but not our concern here)
    return;
  }

  const lowerUrl = url.toLowerCase();

  for (const forbidden of FORBIDDEN_DB_HOSTNAMES) {
    if (lowerUrl.includes(forbidden.toLowerCase())) {
      // Print to stderr so it's visible even when Jest captures stdout
      process.stderr.write(
        `\n\n🚨 FATAL: Test suite refused to start!\n` +
          `DATABASE_URL contains a production/staging hostname: "${forbidden}"\n` +
          `URL: ${url.replace(/:\/\/[^@]+@/, '://***@')}\n` +
          `Tests must only run against a local or CI test database.\n` +
          `Set DATABASE_URL to a safe test DB (e.g. postgresql://postgres:postgres@localhost:5432/engram_test)\n\n`,
      );
      process.exit(1);
    }
  }
}

// Run the guard immediately when this file is loaded by Jest
checkDatabaseUrl();

const originalCreateTestingModule = Test.createTestingModule.bind(Test);
const activeModules: TestingModule[] = [];

Test.createTestingModule = function (
  ...args: Parameters<typeof Test.createTestingModule>
) {
  const builder = originalCreateTestingModule(...args);
  const originalCompile = builder.compile.bind(builder);

  builder.compile = async function (
    ...compileArgs: Parameters<typeof builder.compile>
  ) {
    const module = await originalCompile(...compileArgs);
    activeModules.push(module);
    return module;
  };

  return builder;
};

afterEach(async () => {
  while (activeModules.length > 0) {
    const module = activeModules.pop();
    try {
      await module?.close();
    } catch {
      // Module may already be closed
    }
  }
});

// Safety net: ensure all modules are closed after the entire suite
afterAll(async () => {
  while (activeModules.length > 0) {
    const module = activeModules.pop();
    try {
      await module?.close();
    } catch {
      // Module may already be closed
    }
  }
  // Allow any pending microtasks/timers to flush
  await new Promise((resolve) => setTimeout(resolve, 50));
});
