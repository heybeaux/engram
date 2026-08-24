#!/usr/bin/env bash
# Three-arm retrieval A/B on the noisy mnemon corpus.
#
#   default   — shipped behaviour (banded rescue + raw-score sticky re-add)
#   scalefix  — RECALL_RERANK_SCALE_FIX=true  (rank full pool, no raw re-add)
#   norescue  — RECALL_NO_RESCUE=true         (vector-only control)
#
# Originally five arms: the RECALL_RELATIVE_RESCUE prototype ("relative") and
# its combination with the scale fix ("both") have been removed along with the
# flag. `both` scored identically to `relative` (7/20 gold@5) because relative
# rescue rewrote candidate scores into the rescaled scale upstream, leaving the
# scale fix nothing to correct and dragging 14/20 back down to 7/20. See
# docs/research/memory-formation-query-transform/05-finding-band-inversion.md.
#
# Retrieval-only. No LLM, no generation. Restarts the research Engram instance
# once per arm and resets usage counters (retrieval_count / used_count /
# last_retrieved_at) between arms, because recall increments them and
# usage-weighted reranking feeds them back at weight 0.15 — without the reset
# arm N is measured against a system arm N-1 mutated.
#
# Usage: scripts/research/run-scale-fix-arms.sh <api-key>
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY="${1:-${PROBE_API_KEY:-}}"
DB="${PROBE_DB_URL:-postgresql://engram:engram@localhost:5432/engram_ablation_prefix}"
PORT="${PROBE_PORT:-3007}"

[ -n "$KEY" ] || { echo "usage: $0 <api-key>" >&2; exit 2; }

reset_usage() {
  psql "$DB" -q -c "
    UPDATE memories m
       SET retrieval_count = s.retrieval_count,
           used_count      = s.used_count,
           unused_count    = s.unused_count,
           last_retrieved_at = s.last_retrieved_at,
           last_used_at      = s.last_used_at
      FROM zz_probe_usage_snapshot s
     WHERE m.id = s.id;" >/dev/null
}

start_server() {
  local arm="$1" scalefix="$2" norescue="$3"
  pkill -f "node dist/main.js" 2>/dev/null || true
  sleep 2
  cd "$REPO"
  RECALL_RERANK_SCALE_FIX="$scalefix" \
  RECALL_NO_RESCUE="$norescue" \
    nohup node dist/main.js >"/tmp/engram-arm-${arm}.log" 2>&1 &
  for _ in $(seq 1 60); do
    if curl -sf -m 2 "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "server did not come up (arm=$arm)" >&2; exit 1
}

# arm : scalefix : norescue
ARMS=(
  "default:false:false"
  "scalefix:true:false"
  "norescue:false:true"
)

for SPEC in "${ARMS[@]}"; do
  IFS=: read -r ARM SF NR <<<"$SPEC"
  echo "### arm=$ARM  scalefix=$SF norescue=$NR"
  start_server "$ARM" "$SF" "$NR"
  reset_usage
  PROBE_API_KEY="$KEY" node "$REPO/scripts/research/retrieval-probe.mjs" \
    --limit 10 --label "$ARM" --out "/tmp/arm-${ARM}.json" \
    | tail -12
done

node "$REPO/scripts/research/score-arms.mjs" \
  /tmp/arm-default.json /tmp/arm-scalefix.json /tmp/arm-norescue.json
