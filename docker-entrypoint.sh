#!/bin/sh

echo "Running database migrations..."

# Resolve any previously failed migrations so migrate deploy can proceed.
# This marks ALL failed migrations as rolled back, allowing new migrations to run.
npx prisma migrate resolve --rolled-back 20260221_add_identity_framework_tables 2>&1 || true

# Resolve any other failed migrations dynamically
node -e "
const { execSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const failed = await p.\$queryRaw\`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL AND migration_name != '20260221_add_identity_framework_tables'\`;
  for (const m of failed) {
    console.log('Resolving failed migration:', m.migration_name);
    try { execSync(\`npx prisma migrate resolve --rolled-back \${m.migration_name}\`, { stdio: 'inherit' }); } catch(e) { console.error('Failed to resolve:', m.migration_name); }
  }
  await p.\$disconnect();
})().catch(console.error);
" 2>&1 || true

npx prisma migrate deploy 2>&1 || echo "WARNING: Migration failed. Continuing startup..."

echo "Starting Engram..."
exec node dist/src/main.js
