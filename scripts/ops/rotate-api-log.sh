#!/usr/bin/env bash
# Size-based copy-truncate rotation for the com.engram.api launchd logs (ENG-16).
# Run hourly by the proposed com.engram.logrotate LaunchAgent.
#
# Why not newsyslog: launchd owns StandardOutPath and node never reopens it, so
# newsyslog's rename+signal leaves the API writing into the renamed file.
# launchd opens the log O_APPEND (lsof +fg shows "AP"), so truncating in place
# is safe: the next write lands at offset 0, no sparse hole. Lines written
# between the copy and the truncate (milliseconds) are lost; accepted.
#
# usage: rotate-api-log.sh [--dry-run] LOG [LOG...]
#   ROTATE_MAX_BYTES (default 268435456 = 256 MiB)  rotate only above this size
#   ROTATE_KEEP      (default 7)                    rotated .gz files kept per log
set -uo pipefail

MAX_BYTES="${ROTATE_MAX_BYTES:-268435456}"
KEEP="${ROTATE_KEEP:-7}"
DRY=0
[ "${1:-}" = "--dry-run" ] && { DRY=1; shift; }
[ $# -gt 0 ] || { echo "usage: $0 [--dry-run] LOG [LOG...]" >&2; exit 2; }

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
rc=0
for LOG in "$@"; do
  [ -f "$LOG" ] || { echo "[$(ts)] skip $LOG (missing)"; continue; }
  SIZE=$(stat -f %z "$LOG")
  if [ "$SIZE" -le "$MAX_BYTES" ]; then
    echo "[$(ts)] ok $LOG size=$SIZE <= $MAX_BYTES"
    continue
  fi
  DEST="$LOG.$(date -u +%Y%m%dT%H%M%SZ)"
  FREE=$(( $(df -k "$(dirname "$LOG")" | awk 'NR==2{print $4}') * 1024 ))
  if [ "$FREE" -lt $(( SIZE + SIZE / 4 )) ]; then
    echo "[$(ts)] ERROR $LOG size=$SIZE needs ~$(( SIZE + SIZE / 4 )) free, have $FREE; not rotating" >&2
    rc=1; continue
  fi
  if [ "$DRY" = 1 ]; then
    echo "[$(ts)] dry-run: would copy $LOG ($SIZE bytes) -> $DEST.gz, truncate, keep $KEEP"
    continue
  fi
  if cp "$LOG" "$DEST" && : > "$LOG"; then
    nice -n 10 gzip -6 "$DEST" || { echo "[$(ts)] ERROR gzip $DEST" >&2; rc=1; }
    echo "[$(ts)] rotated $LOG size=$SIZE -> $DEST.gz"
  else
    rm -f "$DEST"; echo "[$(ts)] ERROR copy/truncate $LOG" >&2; rc=1; continue
  fi
  # Prune: keep the newest $KEEP rotated archives for this log.
  ls -1t "$LOG".*.gz 2>/dev/null | tail -n +$(( KEEP + 1 )) | while read -r OLD; do
    rm -f "$OLD" && echo "[$(ts)] pruned $OLD"
  done
done
exit $rc
