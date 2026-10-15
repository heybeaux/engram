#!/usr/bin/env bash
# S5 ops-health scorecard (ENG-8). Cheap, read-only: HTTP health endpoints,
# launchd state, file metadata, git refs and a few SELECTs on the local DB.
#
# Prints `key=value` lines (or one JSON object with --json), then one
# `ALERT ...` line per failed check. Exit code: 0 healthy, 1 any alert.
# A metric that cannot be measured prints `not_measured` with a reason; it
# is never filled with a guess.
#
# Env overrides:
#   EMBED_URL (http://127.0.0.1:8080)   API_URL (http://127.0.0.1:47291)
#   PROD_URL (https://api.openengram.ai; set PROD_URL= to skip)
#   ENGRAM_LIVE_DIR (~/projects/engram)  ENGRAM_ENV_FILE ($ENGRAM_LIVE_DIR/.env)
#   BACKUP_ROOT (~/engram-backups)       BACKUP_MAX_AGE_H (36)
#   REPO_DIR (this repo)                 FETCH=1 to `git fetch` refs first
set -uo pipefail

EMBED_URL="${EMBED_URL:-http://127.0.0.1:8080}"
API_URL="${API_URL:-http://127.0.0.1:47291}"
PROD_URL="${PROD_URL-https://api.openengram.ai}"
LIVE_DIR="${ENGRAM_LIVE_DIR:-$HOME/projects/engram}"
ENV_FILE="${ENGRAM_ENV_FILE:-$LIVE_DIR/.env}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/engram-backups}"
BACKUP_MAX_AGE_H="${BACKUP_MAX_AGE_H:-36}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
LIVE_RECALL_DIR="${LIVE_RECALL_DIR:-$HOME/.engram-team/scorecard/live}"
LIVE_SINCE="${LIVE_SINCE:-2026-10-14T03:20:00Z}"
LIVE_DAYS="${LIVE_DAYS:-7}"
JSON=0
[ "${1:-}" = "--json" ] && JSON=1

NOW=$(date +%s)
KEYS=()
VALS=()
ALERTS=()
put() { KEYS+=("$1"); VALS+=("$2"); }
alert() { ALERTS+=("$1"); }
jget() { # jget <json> <python-expr on d>; prints "" on any failure
  python3 -I -c 'import json,sys
try:
  d=json.loads(sys.argv[1]); v=eval(sys.argv[2])
  print("" if v is None else v)
except Exception: print("")' "$1" "$2" 2>/dev/null
}
iso_to_epoch() { python3 -I -c 'import sys,datetime
try: print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).timestamp()))
except Exception: print("")' "$1"; }
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }
fsize() { stat -f %z "$1" 2>/dev/null || stat -c %s "$1" 2>/dev/null || echo 0; }

# ── 1. engram-embed ──
EMBED=$(curl -s -m 5 "$EMBED_URL/health" || true)
if [ "$(jget "$EMBED" 'd["status"]')" = "ok" ]; then
  put embed_up 1
  put embed_uptime_s "$(jget "$EMBED" 'd["uptime_secs"]')"
  put embed_in_flight "$(jget "$EMBED" 'd.get("in_flight_requests")')"
  put embed_models_loaded "$(jget "$EMBED" 'd["loaded_count"]')"
else
  put embed_up 0
  alert "embed down: no ok from $EMBED_URL/health"
fi
if command -v launchctl >/dev/null; then
  LD=$(launchctl print "gui/$(id -u)/com.engram.embed" 2>/dev/null || true)
  put embed_launchd_state "$(echo "$LD" | awk -F' = ' '/^\tstate = /{print $2; exit}')"
  put embed_launchd_last_exit "$(echo "$LD" | awk -F' = ' '/last exit code = /{print $2; exit}')"
fi

# ── 2. local API ──
API=$(curl -s -m 10 "$API_URL/v1/health" || true)
API_STATUS=$(jget "$API" 'd["status"]')
put api_status "${API_STATUS:-down}"
[ "$API_STATUS" = "healthy" ] || alert "local api not healthy: ${API_STATUS:-no response}"
put api_db_status "$(jget "$API" 'd["dependencies"]["database"]["status"]')"
# pg_class.reltuples estimate since ENG-48 (memoryCount on older builds was exact)
put api_db_memory_count "$(jget "$API" 'd["dependencies"]["database"].get("memoryCountEstimate", d["dependencies"]["database"].get("memoryCount"))')"
put api_git_sha "$(jget "$API" 'd.get("gitSha")')"   # null until ENG-16 build ships
put dream_local_last_run "$(jget "$API" 'd["dreamCycle"]["lastRun"]')"
put dream_local_status "$(jget "$API" 'd["dreamCycle"]["status"]')"
DL=$(iso_to_epoch "$(jget "$API" 'd["dreamCycle"]["lastRun"]')")
if [ -n "$DL" ]; then
  put dream_local_age_h $(( (NOW - DL) / 3600 ))
  [ $(( (NOW - DL) / 3600 )) -le 26 ] || alert "local dream cycle last completed $(( (NOW - DL) / 3600 ))h ago"
fi
if [ -f "$LIVE_DIR/dist/main.js" ]; then
  put api_dist_age_d $(( (NOW - $(mtime "$LIVE_DIR/dist/main.js")) / 86400 ))
fi

# ── 3. production (health endpoint only) ──
if [ -n "$PROD_URL" ]; then
  PROD=$(curl -s -m 15 "$PROD_URL/v1/health" || true)
  put prod_status "$(jget "$PROD" 'd["status"]')"
  PROD_SHA=$(jget "$PROD" 'd.get("gitSha")')
  put prod_git_sha "$PROD_SHA"
  put prod_embed_status "$(jget "$PROD" 'd["dependencies"]["engramEmbed"]["status"]')"
  put prod_db_latency_ms "$(jget "$PROD" 'd["dependencies"]["database"]["latencyMs"]')"
  put prod_embed_latency_ms "$(jget "$PROD" 'd["dependencies"]["engramEmbed"]["latencyMs"]')"
  put dream_prod_last_run "$(jget "$PROD" 'd["dreamCycle"]["lastRun"]')"
  put dream_prod_status "$(jget "$PROD" 'd["dreamCycle"]["status"]')"
  if [ -z "$(jget "$PROD" 'd["dreamCycle"]["lastRun"]')" ]; then
    alert "prod dreamCycle has no lastRun (status=$(jget "$PROD" 'd["dreamCycle"]["status"]'))"
  fi
fi

# ── 4. backups ──
STATUS_FILE="$BACKUP_ROOT/local/last-status.json"
if [ -f "$STATUS_FILE" ]; then
  S=$(cat "$STATUS_FILE")
  put backup_last_status "$(jget "$S" 'd["status"]')"
  [ "$(jget "$S" 'd["status"]')" = "ok" ] || alert "last backup run failed: $(jget "$S" 'd["message"]')"
fi
NEWEST=""; NEWEST_M=0; ZERO=0
while IFS= read -r f; do
  if [ "$(fsize "$f")" -eq 0 ]; then ZERO=$((ZERO + 1)); continue; fi
  m=$(mtime "$f"); [ "$m" -gt "$NEWEST_M" ] && { NEWEST_M=$m; NEWEST=$f; }
done < <(find "$BACKUP_ROOT" -type f \( -name '*.dump' -o -name '*.sql.gz' \) 2>/dev/null)
put backup_zero_byte_files "$ZERO"
if [ -n "$NEWEST" ]; then
  AGE_H=$(( (NOW - NEWEST_M) / 3600 ))
  put backup_newest_age_h "$AGE_H"
  put backup_newest_bytes "$(fsize "$NEWEST")"
  [ "$AGE_H" -le "$BACKUP_MAX_AGE_H" ] || alert "newest non-empty backup is ${AGE_H}h old (max ${BACKUP_MAX_AGE_H}h)"
else
  put backup_newest_age_h not_measured_no_backups
  alert "no non-empty backups under $BACKUP_ROOT"
fi

# ── 5. release lag (git refs; FETCH=1 refreshes them) ──
if git -C "$REPO_DIR" rev-parse --verify -q origin/staging >/dev/null; then
  [ "${FETCH:-0}" = 1 ] && git -C "$REPO_DIR" fetch -q origin staging production 2>/dev/null
  put staging_sha "$(git -C "$REPO_DIR" rev-parse --short origin/staging)"
  if git -C "$REPO_DIR" rev-parse --verify -q origin/production >/dev/null; then
    put prod_lag_commits "$(git -C "$REPO_DIR" rev-list --count origin/production..origin/staging)"
    # Deployed (not just merged) lag, once /v1/health reports gitSha (ENG-16).
    if [ -n "${PROD_SHA:-}" ] && git -C "$REPO_DIR" cat-file -e "$PROD_SHA" 2>/dev/null; then
      put prod_deployed_behind_staging "$(git -C "$REPO_DIR" rev-list --count "$PROD_SHA"..origin/staging)"
    fi
    OLDEST=$(git -C "$REPO_DIR" log --reverse --format=%ct origin/production..origin/staging | head -1)
    put prod_lag_days $([ -n "$OLDEST" ] && echo $(( (NOW - OLDEST) / 86400 )) || echo 0)
  fi
  LIVE_SHA=$(git -C "$LIVE_DIR" rev-parse HEAD 2>/dev/null || true)
  if [ -n "$LIVE_SHA" ] && git -C "$REPO_DIR" cat-file -e "$LIVE_SHA" 2>/dev/null; then
    put local_api_checkout_behind_staging "$(git -C "$REPO_DIR" rev-list --count "$LIVE_SHA"..origin/staging)"
  fi
fi

# ── 6. recall latency / tokens (passive: query_logs on the local DB) ──
DBURL=""
[ -f "$ENV_FILE" ] && DBURL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"'")
if [ -n "$DBURL" ] && command -v psql >/dev/null; then
  R=$(psql "$DBURL" -X -A -t -F'|' -c "SELECT count(*), coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::text,''), (SELECT coalesce(to_char(max(created_at),'YYYY-MM-DD\"T\"HH24:MI:SS'),'') FROM query_logs) FROM query_logs WHERE created_at > now() - interval '7 days'" 2>/dev/null || true)
  # No here-strings: bash 5.3 here-strings hang on this macOS host.
  N=${R%%|*}; REST=${R#*|}; P95=${REST%%|*}; LAST=${REST#*|}
  put recall_queries_7d "${N:-not_measured}"
  if [ -n "${P95:-}" ]; then put recall_p95_ms "$P95"; else put recall_p95_ms "not_measured_no_queries_7d"; fi
  put recall_last_logged_at "${LAST:-none}"
else
  put recall_p95_ms not_measured_no_db_access
fi
# Engram does not record tokens injected per recall anywhere today.
put tokens_per_recall not_measured_no_instrumentation

# ── 6b. live recall latency (passive: S6 hook JSONL, ENG-27) ──
# Server = response `latencyMs`; client = hook fetch incl. TLS + body; hook =
# whole hook process. pct() matches s6-report.mjs so both tools agree.
# LIVE_SINCE excludes the install-verification calls; window is also capped
# at LIVE_DAYS. Target (ENG-27): hook p95 <= 1500 ms.
if [ -d "$LIVE_RECALL_DIR" ] && command -v node >/dev/null; then
  LR=$(node -e '
const fs = require("fs"), path = require("path");
const [dir, since, days] = process.argv.slice(1);
// Same interpolation as s6-report.mjs pct().
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * p, f = Math.floor(k), c = Math.min(f + 1, s.length - 1);
  return Math.round(s[f] + (s[c] - s[f]) * (k - f)); };
const from = Math.max(Date.now() - Number(days) * 86400000, Date.parse(since) || 0);
const a = [];
for (const fn of fs.readdirSync(dir).filter((x) => /^recalls-.*\.jsonl$/.test(x)).sort())
  for (const l of fs.readFileSync(path.join(dir, fn), "utf8").split("\n")) {
    try { const r = JSON.parse(l); if (Date.parse(r.ts) >= from && r.status !== "skipped") a.push(r); } catch {}
  }
const num = (k) => a.map((r) => r[k]).filter((v) => typeof v === "number");
const srv = num("server_latency_ms"), cli = num("latency_ms"), tot = num("total_ms");
const out = [a.length, pct(srv, 0.5), pct(srv, 0.95), pct(cli, 0.5), pct(cli, 0.95), pct(tot, 0.95),
  a.length ? (a.filter((r) => r.status === "timeout").length / a.length).toFixed(3) : null];
console.log(out.map((v) => v ?? "").join("|"));' "$LIVE_RECALL_DIR" "$LIVE_SINCE" "$LIVE_DAYS" 2>/dev/null || true)
  f() { printf '%s\n' "$LR" | cut -d'|' -f"$1"; }
  LN=$(f 1); LS50=$(f 2); LS95=$(f 3); LC50=$(f 4); LC95=$(f 5); LH95=$(f 6); LTO=$(f 7)
  put live_recall_attempted "${LN:-not_measured}"
  if [ -n "${LN:-}" ] && [ "$LN" -gt 0 ] 2>/dev/null; then
    put live_recall_server_p50_ms "${LS50:-not_measured_no_server_latency}"
    put live_recall_server_p95_ms "${LS95:-not_measured_no_server_latency}"
    put live_recall_client_p50_ms "$LC50"
    put live_recall_client_p95_ms "$LC95"
    put live_recall_hook_p95_ms "$LH95"
    put live_recall_timeout_rate "$LTO"
    [ -n "$LH95" ] && [ "$LH95" -gt 1500 ] && alert "live recall hook p95 ${LH95} ms > 1500 ms target (n=$LN)"
  else
    put live_recall_hook_p95_ms "not_measured_no_live_recalls_since_${LIVE_SINCE}"
  fi
else
  put live_recall_hook_p95_ms not_measured_no_s6_dir
fi

# ── 7. host ──
put disk_used_pct "$(df -P "$HOME" | awk 'NR==2{gsub("%","",$5); print $5}')"
[ "$(df -P "$HOME" | awk 'NR==2{gsub("%","",$5); print $5}')" -lt 95 ] || alert "disk usage >= 95%"
[ -f "$LIVE_DIR/logs/engram-api.stdout.log" ] && put api_stdout_log_mb $(( $(fsize "$LIVE_DIR/logs/engram-api.stdout.log") / 1048576 ))

# ── output ──
put checked_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
put alerts "${#ALERTS[@]}"
if [ "$JSON" = 1 ]; then
  args=()
  for i in "${!KEYS[@]}"; do args+=("${KEYS[$i]}" "${VALS[$i]}"); done
  for a in ${ALERTS[@]+"${ALERTS[@]}"}; do args+=("ALERT" "$a"); done
  python3 -I -c 'import json,sys
a=sys.argv[1:]; out={}; alerts=[]
for k,v in zip(a[::2],a[1::2]):
  if k=="ALERT": alerts.append(v); continue
  out[k]=int(v) if v.lstrip("-").isdigit() else v
out["alert_messages"]=alerts
print(json.dumps(out))' ${args[@]+"${args[@]}"}
else
  for i in "${!KEYS[@]}"; do echo "${KEYS[$i]}=${VALS[$i]}"; done
  for a in ${ALERTS[@]+"${ALERTS[@]}"}; do echo "ALERT $a"; done
fi
[ "${#ALERTS[@]}" -eq 0 ]
