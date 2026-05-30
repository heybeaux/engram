#!/usr/bin/env bash
# phase2-verify.sh — Phase 2 post-deploy verification
#
# Run immediately after production `prisma migrate deploy` to confirm:
#   1. Each new migration appears in _prisma_migrations
#   2. New tables / columns / indexes exist
#   3. Row counts on touched tables are sane
#   4. No orphaned FKs
#   5. Legacy memories.embedding column is still 1536-d (768 migration was skipped)
#
# Required env vars:
#   DATABASE_URL — Production database URL
#
# Usage:
#   export DATABASE_URL="postgresql://..."
#   bash scripts/phase2-verify.sh

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

PASS=0
FAIL=0

check() {
  local label="$1"; local result="$2"; local expect="$3"; local op="${4:-eq}"
  local ok=false
  case "$op" in
    eq) [[ "$result" == "$expect" ]] && ok=true ;;
    ge) [[ "$result" -ge "$expect" ]] && ok=true ;;
    ne) [[ "$result" != "$expect" ]] && ok=true ;;
  esac
  if $ok; then echo "  ✓ $label: $result"; ((PASS++)) || true
  else echo "  ✗ $label: got=$result expected($op)=$expect"; ((FAIL++)) || true
  fi
}

echo "=== Phase 2 Post-Deploy Verification ==="
echo ""

# ── [1] Migration rows ──────────────────────────────────────────────────────
echo "[1] _prisma_migrations rows"
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
  COUNT=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '$m' AND finished_at IS NOT NULL;")
  check "migration $m applied" "$COUNT" "1"
done
echo ""

# ── [2] New tables ──────────────────────────────────────────────────────────
echo "[2] New tables"
for t in memory_edges memory_event_times; do
  EXISTS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='$t');")
  check "table $t" "$EXISTS" "t"
done
echo ""

# ── [3] New columns ─────────────────────────────────────────────────────────
echo "[3] New columns"
declare -a COLS=(
  "memories observed_at"
  "memories temporal_anchor_source"
  "memories version"
  "memories parent_memory_id"
  "memory_extractions fact_keys"
  "memory_extractions fact_key_vectors"
  "pool_grants agent_id"
)
for pair in "${COLS[@]}"; do
  table="${pair%% *}"; col="${pair##* }"
  EXISTS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='$table' AND column_name='$col');")
  check "$table.$col" "$EXISTS" "t"
done

# pool_grants.agent_session_id should now be nullable
NULLABLE=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT is_nullable FROM information_schema.columns WHERE table_name='pool_grants' AND column_name='agent_session_id';")
check "pool_grants.agent_session_id nullable" "$NULLABLE" "YES"
echo ""

# ── [4] New indexes ─────────────────────────────────────────────────────────
echo "[4] New indexes"
declare -a IDX=(
  "memory_edges_source_id_idx"
  "memory_edges_target_id_idx"
  "memory_edges_edge_type_idx"
  "memory_edges_agent_id_idx"
  "memory_event_times_memory_id_idx"
  "memory_event_times_resolved_instant_idx"
  "memory_event_times_resolved_range_start_resolved_range_end_idx"
  "memories_user_id_observed_at_idx"
  "memories_observed_at_idx"
  "pool_grants_pool_id_agent_id_key"
  "pool_grants_agent_id_idx"
)
for i in "${IDX[@]}"; do
  EXISTS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='$i');")
  check "index $i" "$EXISTS" "t"
done
echo ""

# ── [5] Enum values ─────────────────────────────────────────────────────────
echo "[5] Enum values"
for v in DECISION OUTCOME GOAL TEMPORAL_GAP FACT_KEY; do
  HAS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'MemoryType' AND e.enumlabel = '$v');")
  check "MemoryType=$v" "$HAS" "t"
done
HAS_HIST=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'MemorySource' AND e.enumlabel = 'HISTORICAL');")
check "MemorySource=HISTORICAL" "$HAS_HIST" "t"
for nt in TemporalAnchorSource EventTimeConfidence EventTimeExtractor; do
  HAS=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = '$nt');")
  check "enum type $nt" "$HAS" "t"
done
echo ""

# ── [6] Row counts ──────────────────────────────────────────────────────────
echo "[6] Row counts on touched tables"
MEMORIES=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM memories;")
EMBEDDING_OPENAI_SMALL=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM embedding_openai_small;")
MEMORY_EDGES_COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM memory_edges;")
EVENT_TIMES_COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM memory_event_times;")
POOL_GRANTS=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM pool_grants;")
echo "  memories:                $MEMORIES"
echo "  embedding_openai_small:  $EMBEDDING_OPENAI_SMALL"
echo "  memory_edges:            $MEMORY_EDGES_COUNT"
echo "  memory_event_times:      $EVENT_TIMES_COUNT"
echo "  pool_grants:             $POOL_GRANTS"
check "memories total > 0" "$MEMORIES" "0" "ge"
check "embedding_openai_small ~ Phase 1 backfill (>= 30926)" "$EMBEDDING_OPENAI_SMALL" "30926" "ge"
echo ""

# ── [7] Legacy embedding column dimension (must still be 1536) ──────────────
echo "[7] Legacy memories.embedding dimension (must NOT have been shrunk to 768)"
EMBED_DIM=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT vector_dims(embedding) FROM memories WHERE embedding IS NOT NULL LIMIT 1;" || echo "")
if [[ -z "$EMBED_DIM" ]]; then
  echo "  ! no non-null embeddings sampled — cannot confirm dimension"
else
  check "memories.embedding sample dims" "$EMBED_DIM" "1536"
fi
echo ""

# ── [8] Orphan FKs ──────────────────────────────────────────────────────────
echo "[8] Orphan FK check"
ORPHAN_EDGES=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM memory_edges e WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.source_id) OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.target_id);")
ORPHAN_TIMES=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM memory_event_times t WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = t.memory_id);")
ORPHAN_PG_AGENT=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT COUNT(*) FROM pool_grants g WHERE g.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = g.agent_id);")
check "orphan memory_edges rows" "$ORPHAN_EDGES" "0"
check "orphan memory_event_times rows" "$ORPHAN_TIMES" "0"
check "orphan pool_grants.agent_id rows" "$ORPHAN_PG_AGENT" "0"
echo ""

# ── Summary ──────────────────────────────────────────────────────────────────
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  echo "FAIL — investigate before declaring Phase 2 complete"
  exit 1
else
  echo "PASS — Phase 2 deploy verified"
fi
