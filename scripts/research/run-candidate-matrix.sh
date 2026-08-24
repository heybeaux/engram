#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${PROBE_DB_URL:-postgresql://engram:engram@localhost:5432/engram_ablation_prefix}"
RUN_PORT="${PROBE_PORT:-3017}"
KEY="${PROBE_API_KEY:-eng_candidate_depth_research_20260823}"
OUT_DIR="${CANDIDATE_OUT_DIR:-$REPO/docs/research/memory-formation-query-transform/artifacts/candidate-matrix/isolated}"
mkdir -p "$OUT_DIR"

reset_usage() {
  psql "$DB" -q -c "
    UPDATE memories m
       SET retrieval_count = s.retrieval_count,
           used_count = s.used_count,
           unused_count = s.unused_count,
           last_retrieved_at = s.last_retrieved_at,
           last_used_at = s.last_used_at
      FROM zz_probe_usage_snapshot s
     WHERE m.id = s.id;" >/dev/null
}

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}
trap stop_server EXIT

start_server() {
  local label="$1" depth="$2" cluster_limit="$3"
  stop_server
  (
    cd "$REPO"
    set -a
    # Provider credentials live in the primary checkout; the research .env
    # loaded second restores the dedicated throwaway DB and port-safe config.
    source /Users/beauxwalton/projects/engram/.env
    source .env
    set +a
    PORT="$RUN_PORT" \
    RECALL_RERANK_SCALE_FIX=true \
    RECALL_LEXICAL_COVERAGE_FLOOR=true \
    RECALL_RESCUE_SQL_TIEBREAK=true \
    RECALL_CANDIDATE_POOL_DEPTH="$depth" \
    RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT="$cluster_limit" \
      exec node dist/main.js
  ) >"$OUT_DIR/${label}.server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    curl -sf -m 2 "http://127.0.0.1:${RUN_PORT}/v1/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "server did not start for $label" >&2
  exit 1
}

# logical arm : candidate depth : max selected per >=0.9 Jaccard cluster
ARMS=(
  "depth10:10:"
  "depth12:12:"
  "depth20:20:"
  "depth50:50:"
  "cluster12:12:2"
  "cluster20:20:2"
  "cluster50:50:2"
  "cluster12c8:12:8"
  "cluster20c4:20:4"
  "cluster20c8:20:8"
  "cluster50c4:50:4"
  "cluster50c8:50:8"
)
if [[ -n "${CANDIDATE_ARMS:-}" ]]; then
  IFS=',' read -r -a ARMS <<<"$CANDIDATE_ARMS"
fi

ARTIFACTS=()
for spec in "${ARMS[@]}"; do
  IFS=: read -r arm depth cluster_limit <<<"$spec"
  for repeat in 1 2; do
    label="${arm}-r${repeat}"
    echo "### $label depth=$depth cluster_limit=${cluster_limit:-off}"
    start_server "$label" "$depth" "$cluster_limit"
    reset_usage
    PROBE_API_KEY="$KEY" \
    PROBE_BASE_URL="http://127.0.0.1:${RUN_PORT}" \
    PROBE_RESET_DB_URL="$DB" \
      node "$REPO/scripts/research/retrieval-probe.mjs" \
        --limit 10 --label "$label" --out "$OUT_DIR/${label}.json" \
        | tail -4
    ARTIFACTS+=("$OUT_DIR/${label}.json")
  done
done

node "$REPO/scripts/research/score-candidate-matrix.mjs" "${ARTIFACTS[@]}" \
  | tee "$OUT_DIR/summary.txt"
