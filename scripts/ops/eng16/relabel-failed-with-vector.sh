#!/usr/bin/env bash
# ENG-16 step A — PROPOSED, needs Beaux's approval before running against the
# live `engram` DB. Marks FAILED memories COMPLETE when they already have a
# valid search-model vector in memory_embeddings (pure metadata; no embed calls).
# This takes them out of EmbeddingRetryCron's discovery query, which otherwise
# rewrites ~60k rows every 5 minutes after each API restart.
#
# Default is a dry run (prints counts, writes nothing). Pass --apply to write.
# Batches of 5,000 rows, one transaction each, 1 s pause between batches.
# Does not touch updated_at (raw SQL bypasses Prisma's @updatedAt), so the rows
# remain identifiable afterwards by: embedding_status='COMPLETE' AND updated_at < run start.
#
# usage: DATABASE_URL=... relabel-failed-with-vector.sh [--apply]
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
SEARCH_MODEL="${SEARCH_MODEL:-openai-small}"
SEARCH_DIMS="${SEARCH_DIMS:-1536}"
BATCH="${BATCH:-5000}"
EXPECTED_MAX="${EXPECTED_MAX:-60000}"   # abort if the candidate count is unexpectedly large

CANDIDATES="FROM memories m
  WHERE m.deleted_at IS NULL AND m.embedding_status = 'FAILED'
    AND EXISTS (SELECT 1 FROM memory_embeddings v
                WHERE v.memory_id = m.id AND v.model_id = '$SEARCH_MODEL'
                  AND v.embedding IS NOT NULL AND vector_dims(v.embedding) = $SEARCH_DIMS)
    AND (m.embedding_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM memories x WHERE x.embedding_id = m.id))"

q() { psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }

N=$(PGOPTIONS='-c default_transaction_read_only=on' q "SELECT count(*) $CANDIDATES")
echo "candidates=$N (model=$SEARCH_MODEL dims=$SEARCH_DIMS batch=$BATCH)"
[ "$N" -le "$EXPECTED_MAX" ] || { echo "ABORT: $N > EXPECTED_MAX=$EXPECTED_MAX" >&2; exit 1; }
[ "${1:-}" = "--apply" ] || { echo "dry run only; re-run with --apply to write"; exit 0; }

TOTAL=0
while :; do
  DONE=$(q "WITH b AS (SELECT m.id $CANDIDATES LIMIT $BATCH)
            UPDATE memories m SET embedding_status = 'COMPLETE', embedding_id = COALESCE(m.embedding_id, m.id)
            FROM b WHERE m.id = b.id RETURNING 1" | wc -l | tr -d ' ')
  TOTAL=$((TOTAL + DONE))
  echo "batch updated=$DONE total=$TOTAL"
  [ "$DONE" -gt 0 ] || break
  sleep 1
done
echo "done: relabeled $TOTAL rows"
