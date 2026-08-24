#!/usr/bin/env bash
# Multi-arm retrieval A/B on the noisy mnemon corpus.
#
#   default    — shipped behaviour (banded rescue + raw-score sticky re-add)
#   scalefix   — RECALL_RERANK_SCALE_FIX=true  (rank full pool, no raw re-add)
#   norescue   — RECALL_NO_RESCUE=true         (vector-only control)
#   covfloor   — scalefix + RECALL_LEXICAL_COVERAGE_FLOOR   (defect A)
#   tiebreak   — scalefix + RECALL_RESCUE_SQL_TIEBREAK      (defect B)
#   all        — scalefix + defects A and B
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
# The API key must belong to an `agents` row in the probe DB: the LAN-trust
# branch of ApiKeyGuard resolves X-AM-User-ID only when the key hashes to a
# known agent, and silently falls back to the account's *default* user (which
# owns no memories, so every query returns an empty page) when it does not.
#
# Usage: scripts/research/run-scale-fix-arms.sh <api-key> [arm ...]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY="${1:-${PROBE_API_KEY:-}}"
shift || true
DB="${PROBE_DB_URL:-postgresql://engram:engram@localhost:5432/engram_ablation_prefix}"
PORT="${PROBE_PORT:-3007}"
# Artifact filenames are "${ARM_OUT_PREFIX}<arm>.json". Override the prefix to
# keep a previous run's artifacts around for comparison instead of clobbering
# them — re-running a set over the top of an older one destroys the only
# evidence that the older set was measured against different code.
OUT_PREFIX="${ARM_OUT_PREFIX:-/tmp/arm-}"

[ -n "$KEY" ] || { echo "usage: $0 <api-key> [arm ...]" >&2; exit 2; }

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

# arm : SCALE_FIX : NO_RESCUE : LEXICAL_COVERAGE_FLOOR : RESCUE_SQL_TIEBREAK
ALL_ARMS=(
  "default:false:false:false:false"
  "scalefix:true:false:false:false"
  "norescue:false:true:false:false"
  "covfloor:true:false:true:false"
  "tiebreak:true:false:false:true"
  "all:true:false:true:true"
)

ARMS=()
if [ $# -eq 0 ]; then
  ARMS=("${ALL_ARMS[@]}")
else
  for want in "$@"; do
    for spec in "${ALL_ARMS[@]}"; do
      [ "${spec%%:*}" = "$want" ] && ARMS+=("$spec")
    done
  done
fi

start_server() {
  local arm="$1" scalefix="$2" norescue="$3" covfloor="$4" tiebreak="$5"
  pkill -f "node dist/main.js" 2>/dev/null || true
  sleep 2
  cd "$REPO"
  RECALL_RERANK_SCALE_FIX="$scalefix" \
  RECALL_NO_RESCUE="$norescue" \
  RECALL_LEXICAL_COVERAGE_FLOOR="$covfloor" \
  RECALL_RESCUE_SQL_TIEBREAK="$tiebreak" \
    nohup node dist/main.js >"/tmp/engram-arm-${arm}.log" 2>&1 &
  for _ in $(seq 1 60); do
    if curl -sf -m 2 "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "server did not come up (arm=$arm)" >&2; exit 1
}

OUTS=()
for SPEC in "${ARMS[@]}"; do
  IFS=: read -r ARM SF NR CF TB <<<"$SPEC"
  echo "### arm=$ARM  scalefix=$SF norescue=$NR covfloor=$CF tiebreak=$TB"
  start_server "$ARM" "$SF" "$NR" "$CF" "$TB"
  reset_usage
  PROBE_API_KEY="$KEY" node "$REPO/scripts/research/retrieval-probe.mjs" \
    --limit 10 --label "$ARM" --out "${OUT_PREFIX}${ARM}.json" \
    | tail -4
  OUTS+=("${OUT_PREFIX}${ARM}.json")
done

node "$REPO/scripts/research/score-arms.mjs" "${OUTS[@]}"
