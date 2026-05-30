#!/usr/bin/env bash
# phase1-predeploy.sh — Phase 1 pre-deploy dry-run
#
# 1. pg_dump production → restore to scratch DB
# 2. Apply all Phase 1 migrations against the scratch DB
# 3. Verify row counts look right
#
# Required env vars:
#   DATABASE_URL        — Production database URL (read-only for dump)
#   SCRATCH_DATABASE_URL — Scratch database URL (will be wiped + restored)
#
# Usage:
#   export DATABASE_URL="postgresql://..."
#   export SCRATCH_DATABASE_URL="postgresql://..."
#   bash scripts/phase1-predeploy.sh

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${SCRATCH_DATABASE_URL:?SCRATCH_DATABASE_URL must be set}"

DUMP_FILE="/tmp/engram-phase1-prod-dump-$(date +%Y%m%d-%H%M%S).dump"
MIGRATIONS_DIR="$(cd "$(dirname "$0")/../prisma/migrations" && pwd)"

echo "=== Phase 1 Pre-Deploy Dry-Run ==="
echo ""

# ── Step 1: Dump production ──────────────────────────────────────────────────
echo "[1/4] Dumping production DB → $DUMP_FILE"
pg_dump \
  --format=custom \
  --no-acl \
  --no-owner \
  "$DATABASE_URL" \
  -f "$DUMP_FILE"

DUMP_SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
echo "      Dump complete: $DUMP_SIZE"

# ── Step 2: Restore to scratch ───────────────────────────────────────────────
echo "[2/4] Restoring dump to scratch DB"
echo "      WARNING: This will DROP and recreate the scratch DB schema."

# Drop all objects in scratch to get a clean slate
psql "$SCRATCH_DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>/dev/null || true
psql "$SCRATCH_DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;" || true

pg_restore \
  --no-acl \
  --no-owner \
  --dbname="$SCRATCH_DATABASE_URL" \
  "$DUMP_FILE"

echo "      Restore complete."

# ── Step 3: Apply Phase 1 migrations ────────────────────────────────────────
echo "[3/4] Applying Phase 1 migrations (dry-run against scratch)"

PHASE1_MIGRATIONS=(
  "20260530_skip_768_shrink_on_prod"
  "20260525_per_model_embedding_tables"
  "20260530_backfill_legacy_embeddings_to_openai_small"
)

for migration in "${PHASE1_MIGRATIONS[@]}"; do
  sql_file="$MIGRATIONS_DIR/$migration/migration.sql"
  if [[ ! -f "$sql_file" ]]; then
    echo "  ERROR: Migration file not found: $sql_file"
    exit 1
  fi
  echo "  Applying: $migration"
  psql "$SCRATCH_DATABASE_URL" -f "$sql_file"
  echo "  ✓ $migration"
done

# ── Step 4: Verify row counts ────────────────────────────────────────────────
echo "[4/4] Verifying row counts"

MEMORIES_TOTAL=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM memories;")
MEMORIES_WITH_EMBEDDING=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM memories WHERE embedding IS NOT NULL;")
OPENAI_SMALL_COUNT=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM embedding_openai_small;")
PRISMA_SKIP_ROW=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260520_memories_embedding_768';")

echo ""
echo "  memories total:                $MEMORIES_TOTAL"
echo "  memories with embedding:       $MEMORIES_WITH_EMBEDDING"
echo "  embedding_openai_small rows:   $OPENAI_SMALL_COUNT"
echo "  prisma skip row present:       $PRISMA_SKIP_ROW (expect 1)"
echo ""

# Sanity: openai_small should match memories-with-embedding
if [[ "$OPENAI_SMALL_COUNT" -ne "$MEMORIES_WITH_EMBEDDING" ]]; then
  echo "  WARN: embedding_openai_small count ($OPENAI_SMALL_COUNT) != memories with embedding ($MEMORIES_WITH_EMBEDDING)"
  echo "        This could indicate partial backfill or a conflict skip — investigate before deploying."
else
  echo "  ✓ Row count parity confirmed"
fi

if [[ "$PRISMA_SKIP_ROW" -ne 1 ]]; then
  echo "  ERROR: _prisma_migrations skip row not found — fake-apply migration may have failed."
  exit 1
fi
echo "  ✓ Prisma skip row confirmed"

# Dimension sanity on a sample
SAMPLE_DIM=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT vector_dims(embedding) FROM embedding_openai_small LIMIT 1;")
echo "  sample embedding dims:         $SAMPLE_DIM (expect 1536)"
if [[ "$SAMPLE_DIM" -ne 1536 ]]; then
  echo "  ERROR: unexpected embedding dimensions — expected 1536, got $SAMPLE_DIM"
  exit 1
fi
echo "  ✓ Embedding dimensions correct"

echo ""
echo "=== Pre-deploy dry-run PASSED ==="
echo "    Dump saved to: $DUMP_FILE"
echo "    Keep this file as your rollback restore point."
