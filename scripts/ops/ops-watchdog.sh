#!/usr/bin/env bash
# Alerting wrapper around scripts/scorecard/ops-health.sh (ENG-8).
# Run every 5 minutes by the proposed com.engram.ops-watchdog LaunchAgent.
#
# Notifies (macOS notification, plus ALERT_WEBHOOK_URL if set) when the set
# of ALERT lines changes, and re-notifies every RENOTIFY_S while still failing.
# Also notifies once when everything recovers.
set -uo pipefail

OPS_HEALTH="${OPS_HEALTH:-$(cd "$(dirname "$0")/.." && pwd)/scorecard/ops-health.sh}"
STATE_DIR="${STATE_DIR:-$HOME/.engram-ops/state}"
RENOTIFY_S="${RENOTIFY_S:-21600}"
mkdir -p "$STATE_DIR"
LAST_FILE="$STATE_DIR/last-alerts"
LAST_TS_FILE="$STATE_DIR/last-notified"

OUT=$("$OPS_HEALTH" 2>&1)
# printf | grep rather than here-strings, which hang under bash 5.3 here.
ALERTS=$(printf '%s\n' "$OUT" | grep '^ALERT ' | sort || true)
PREV=$(cat "$LAST_FILE" 2>/dev/null || true)
NOW=$(date +%s)
LAST_TS=$(cat "$LAST_TS_FILE" 2>/dev/null || echo 0)

notify() { # title, body
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] NOTIFY $1: $2"
  if command -v osascript >/dev/null; then
    osascript -e "display notification \"${2//\"/\'}\" with title \"${1//\"/\'}\" sound name \"Basso\"" || true
  fi
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    python3 -I -c 'import json,sys; print(json.dumps({"text": sys.argv[1] + ": " + sys.argv[2]}))' "$1" "$2" \
      | curl -s -m 10 -H 'Content-Type: application/json' -d @- "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
  echo "$NOW" > "$LAST_TS_FILE"
}

if [ -n "$ALERTS" ]; then
  if [ "$ALERTS" != "$PREV" ] || [ $((NOW - LAST_TS)) -ge "$RENOTIFY_S" ]; then
    notify "Engram ops: $(printf '%s\n' "$ALERTS" | wc -l | tr -d ' ') alert(s)" \
      "$(printf '%s\n' "$ALERTS" | sed 's/^ALERT //' | paste -sd ';' -)"
  fi
elif [ -n "$PREV" ]; then
  notify "Engram ops: recovered" "all checks passing"
fi
printf '%s' "$ALERTS" > "$LAST_FILE"
