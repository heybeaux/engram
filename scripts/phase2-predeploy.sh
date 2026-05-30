#!/usr/bin/env bash
# phase2-predeploy.sh — Phase 2 pre-deploy dry-run
#
# Phase 2 deploys: temporal anchoring (T1–T7), embedding hardening,
# memory_edges/types, fact_keys, version counter, pool agent grants,
# temporal_gap memory type, and the neutered 768 migration (skipped
# on prod by the Phase 1 _prisma_migrations row).
#
# 1. pg18 pg_dump of production (prod is pg16) → restore to scratch DB
#    pgvector must be re-created as superuser after DROP SCHEMA CASCADE.
# 2. prisma migrate deploy against scratch (uses /prisma/migrations on disk)
# 3. Verify counts / schema additions
#
# Required env vars:
#   DATABASE_URL          — Production database URL (read-only for dump)
#   SCRATCH_DATABASE_URL  — Scratch database URL (will be wiped + restored)
#   SCRATCH_SUPERUSER_URL — Same scratch DB but as a superuser (for CREATE EXTENSION vector)
#   PG_DUMP               — Optional: explicit path to pg18 pg_dump binary
#
# Usage:
#   export DATABASE_URL="postgresql://..."
#   export SCRATCH_DATABASE_URL="postgresql://..."
#   export SCRATCH_SUPERUSER_URL="postgresql://..."
#   bash scripts/phase2-predeploy.sh

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${SCRATCH_DATABASE_URL:?SCRATCH_DATABASE_URL must be set}"
: "${SCRATCH_SUPERUSER_URL:?SCRATCH_SUPERUSER_URL must be set (superuser on the scratch DB, needed to CREATE EXTENSION vector)}"

PG_DUMP="${PG_DUMP:-pg_dump}"
DUMP_FILE="/tmp/engram-phase2-prod-dump-$(date +%Y%m%d-%H%M%S).dump"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Phase 2 Pre-Deploy Dry-Run ==="
echo ""

# ── Step 0: Confirm pg_dump is pg18 ─────────────────────────────────────────
PG_DUMP_VERSION=$("$PG_DUMP" --version | awk '{print $NF}')
PG_DUMP_MAJOR=$(echo "$PG_DUMP_VERSION" | cut -d. -f1)
echo "[0/5] pg_dump version: $PG_DUMP_VERSION"
if [[ "$PG_DUMP_MAJOR" -lt 18 ]]; then
  echo "  ERROR: pg_dump must be >= 18 (prod is pg16, scratch may be pg18). Got $PG_DUMP_VERSION."
  echo "         Set PG_DUMP=/path/to/pg18/pg_dump and retry."
  exit 1
fi
echo "  ✓ pg18+ pg_dump confirmed"
echo ""

# ── Step 1: Dump production ──────────────────────────────────────────────────
echo "[1/5] Dumping production DB → $DUMP_FILE"
"$PG_DUMP" \
  --format=custom \
  --no-acl \
  --no-owner \
  "$DATABASE_URL" \
  -f "$DUMP_FILE"

DUMP_SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
echo "  ✓ Dump complete: $DUMP_SIZE"
echo ""

# ── Step 2: Reset scratch + restore ──────────────────────────────────────────
echo "[2/5] Resetting scratch DB and restoring dump"
echo "      WARNING: dropping schema public on scratch DB."

# Drop everything via superuser (needed because vector extension was owned by superuser)
psql "$SCRATCH_SUPERUSER_URL" -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
# Re-create the vector extension as superuser BEFORE restore — pg_restore will
# happily replay vector column types only if the extension already exists.
psql "$SCRATCH_SUPERUSER_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql "$SCRATCH_SUPERUSER_URL" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

pg_restore \
  --no-acl \
  --no-owner \
  --dbname="$SCRATCH_DATABASE_URL" \
  "$DUMP_FILE"

echo "  ✓ Restore complete"
echo ""

# ── Step 3: prisma migrate deploy ────────────────────────────────────────────
echo "[3/5] Running prisma migrate deploy against scratch"
echo "      (Phase 1 _prisma_migrations rows are present in the restore — the"
echo "       neutered 20260520_memories_embedding_768 will be skipped.)"

(
  cd "$REPO_ROOT"
  DATABASE_URL="$SCRATCH_DATABASE_URL" npx prisma migrate deploy
)

echo "  ✓ prisma migrate deploy complete"
echo ""

# ── Step 4: Verify migrations recorded ──────────────────────────────────────
echo "[4/5] Verifying Phase 2 migration rows in _prisma_migrations"

PHASE2_MIGRATIONS=(
  "20260331_add_memory_edges"
  "20260331_add_memory_types"
  "20260520_memories_embedding_768"
  "20260520_pool_grant_agent_id"
  "20260521_add_memory_version"
  "20260521_add_temporal_gap_memory_type"
  "20260521_add_version_to_memories"
  "20260522_add_fact_keys_hey574"
  "20260526_add_temporal_fields"
)

for m in "${PHASE2_MIGRATIONS[@]}"; do
  COUNT=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '$m' AND finished_at IS NOT NULL;")
  if [[ "$COUNT" -ne 1 ]]; then
    echo "  ✗ $m not recorded (count=$COUNT)"
    exit 1
  fi
  echo "  ✓ $m"
done
echo ""

# ── Step 5: Schema + row-count sanity ───────────────────────────────────────
echo "[5/5] Schema + row-count sanity"

# memory_edges table + indexes
MEMORY_EDGES=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='memory_edges');")
echo "  memory_edges exists:           $MEMORY_EDGES  (expect t)"

# memory_event_times table + indexes
EVENT_TIMES=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='memory_event_times');")
echo "  memory_event_times exists:     $EVENT_TIMES  (expect t)"

# observed_at column
OBSERVED_AT=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='observed_at');")
echo "  memories.observed_at:          $OBSERVED_AT  (expect t)"

# temporal_anchor_source column
TAS=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='temporal_anchor_source');")
echo "  memories.temporal_anchor_src:  $TAS  (expect t)"

# version column
VER_COL=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='version');")
echo "  memories.version:              $VER_COL  (expect t)"

# parent_memory_id column
PMI=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memories' AND column_name='parent_memory_id');")
echo "  memories.parent_memory_id:     $PMI  (expect t)"

# memory_extractions.fact_keys
FACT_KEYS=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memory_extractions' AND column_name='fact_keys');")
echo "  memory_extractions.fact_keys:  $FACT_KEYS  (expect t)"

# pool_grants.agent_id
PG_AGENT=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pool_grants' AND column_name='agent_id');")
echo "  pool_grants.agent_id:          $PG_AGENT  (expect t)"

# Enum values
for v in DECISION OUTCOME GOAL TEMPORAL_GAP FACT_KEY; do
  HAS=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
    "SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'MemoryType' AND e.enumlabel = '$v');")
  echo "  MemoryType=$v:                  $HAS  (expect t)"
done
HAS_HIST=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'MemorySource' AND e.enumlabel = 'HISTORICAL');")
echo "  MemorySource=HISTORICAL:       $HAS_HIST  (expect t)"

# Row counts on touched tables (should match production — migrations don't move rows)
MEMORIES=$(psql "$SCRATCH_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM memories;")
EMBEDDING_OPENAI_SMALL=$(psql "$SCRATCH_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM embedding_openai_small;")
MEMORY_EDGES_COUNT=$(psql "$SCRATCH_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM memory_edges;")
EVENT_TIMES_COUNT=$(psql "$SCRATCH_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM memory_event_times;")
POOL_GRANTS=$(psql "$SCRATCH_DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM pool_grants;")
echo ""
echo "  memories:                      $MEMORIES"
echo "  embedding_openai_small:        $EMBEDDING_OPENAI_SMALL  (expect 30926 from Phase 1 backfill)"
echo "  memory_edges:                  $MEMORY_EDGES_COUNT  (expect 0, fresh table)"
echo "  memory_event_times:            $EVENT_TIMES_COUNT  (expect 0, fresh table)"
echo "  pool_grants:                   $POOL_GRANTS"

# 768 migration must NOT have actually altered the embedding column dimension
EMBED_DIM=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT vector_dims(embedding) FROM memories WHERE embedding IS NOT NULL LIMIT 1;" || echo "")
echo "  memories.embedding sample dim: ${EMBED_DIM:-<no rows>}  (expect 1536; if 768, the 768 ALTER ran and prod data would be corrupted)"
if [[ -n "$EMBED_DIM" && "$EMBED_DIM" != "1536" ]]; then
  echo "  ERROR: memories.embedding is not 1536-d — the neutered 768 migration likely ran. STOP."
  exit 1
fi

# Orphaned FKs check
ORPHAN_EDGES=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM memory_edges e WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.source_id) OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.target_id);")
ORPHAN_TIMES=$(psql "$SCRATCH_DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM memory_event_times t WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = t.memory_id);")
echo "  orphan memory_edges:           $ORPHAN_EDGES  (expect 0)"
echo "  orphan memory_event_times:     $ORPHAN_TIMES  (expect 0)"

echo ""
echo "=== Phase 2 pre-deploy dry-run PASSED ==="
echo "    Dump saved to: $DUMP_FILE"
echo "    Keep this file as your rollback restore point."
