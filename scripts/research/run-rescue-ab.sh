#!/usr/bin/env bash
# A/B the RECALL_RELATIVE_RESCUE prototype flag on the noisy mnemon corpus.
#
# Retrieval-only. No LLM, no generation. Restarts the research Engram instance
# once per arm and resets the usage counters (retrieval_count / used_count /
# last_retrieved_at) between arms, because recall increments them and
# usage-weighted reranking then feeds them back into the score — without the
# reset the second arm is measured against a different system than the first.
#
# Usage: scripts/research/run-rescue-ab.sh <api-key>
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
  local mode="$1"
  pkill -f "node dist/main.js" 2>/dev/null || true
  sleep 2
  cd "$REPO"
  RECALL_RELATIVE_RESCUE="$mode" nohup node dist/main.js \
    >"/tmp/engram-research-server-${mode}.log" 2>&1 &
  for _ in $(seq 1 60); do
    if curl -sf -m 2 "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "server did not come up (mode=$mode)" >&2; exit 1
}

for MODE in false true; do
  LABEL=$([ "$MODE" = "false" ] && echo BEFORE-band || echo AFTER-relative)
  echo "### $LABEL (RECALL_RELATIVE_RESCUE=$MODE)"
  start_server "$MODE"
  reset_usage
  PROBE_API_KEY="$KEY" node "$REPO/scripts/research/retrieval-probe.mjs" \
    --limit 10 --label "$LABEL" --out "/tmp/probe-${MODE}.json" \
    | tail -20
done
