#!/usr/bin/env bash
# phase1-verify.sh — Phase 1 post-deploy verification
#
# Run immediately after production migration deploy to confirm:
#   1. embedding_openai_small count matches memories with non-null embedding
#   2. No dimensional corruption (sample check)
#   3. Prisma skip row is present
#   4. Per-model tables exist
#
# Required env vars:
#   DATABASE_URL — Production database URL
#
# Usage:
#   export DATABASE_URL="postgresql://..."
#   bash scripts/phase1-verify.sh

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  local expect="$3"
  local op="${4:-eq}"  # eq, ge, ne

  local ok=false
  case "$op" in
    eq) [[ "$result" == "$expect" ]] && ok=true ;;
    ge) [[ "$result" -ge "$expect" ]] && ok=true ;;
    ne) [[ "$result" != "$expect" ]] && ok=true ;;
  esac

  if $ok; then
    echo "  ✓ $label: $result"
    ((PASS++)) || true
  else
    echo "  ✗ $label: got=$result expected($op)=$expect"
    ((FAIL++)) || true
  fi
}

echo "=== Phase 1 Post-Deploy Verification ==="
echo ""

# ── Per-model tables exist ──────────────────────────────────────────────────
echo "[1] Table existence"
for table in embedding_openai_small embedding_bge_base embedding_minilm embedding_nomic; do
  EXISTS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '$table');")
  check "table $table exists" "$EXISTS" "t"
done
echo ""

# ── Prisma skip row ─────────────────────────────────────────────────────────
echo "[2] Prisma migration skip row"
SKIP_ROW=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20260520_memories_embedding_768';")
check "skip row present" "$SKIP_ROW" "1"
echo ""

# ── Row count parity ─────────────────────────────────────────────────────────
echo "[3] Row count parity"
MEMORIES_WITH_EMBEDDING=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM memories WHERE embedding IS NOT NULL;")
OPENAI_SMALL_COUNT=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM embedding_openai_small;")
MEMORIES_TOTAL=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM memories;")

check "memories total" "$MEMORIES_TOTAL" "0" "ge"
check "memories with embedding" "$MEMORIES_WITH_EMBEDDING" "0" "ge"
check "embedding_openai_small row count" "$OPENAI_SMALL_COUNT" "$MEMORIES_WITH_EMBEDDING"
echo ""

# ── Dimension sanity (5-sample) ──────────────────────────────────────────────
echo "[4] Embedding dimension sanity (5-sample)"
DIMS=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT DISTINCT vector_dims(embedding) FROM embedding_openai_small WHERE embedding IS NOT NULL LIMIT 5;")
for dim in $DIMS; do
  check "embedding dims" "$dim" "1536"
done
echo ""

# ── Legacy column still intact ───────────────────────────────────────────────
echo "[5] Legacy column integrity"
LEGACY_NULL=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM memories WHERE embedding IS NULL;")
LEGACY_NONNULL=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM memories WHERE embedding IS NOT NULL;")
echo "  memories.embedding IS NULL:     $LEGACY_NULL"
echo "  memories.embedding IS NOT NULL: $LEGACY_NONNULL"
check "legacy column still populated" "$LEGACY_NONNULL" "0" "ge"
echo ""

# ── Summary ──────────────────────────────────────────────────────────────────
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  echo "FAIL — investigate before declaring Phase 1 complete"
  exit 1
else
  echo "PASS — Phase 1 deploy verified"
fi
