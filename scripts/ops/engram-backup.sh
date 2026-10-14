#!/usr/bin/env bash
# Engram local backup with integrity verification (ENG-8).
#
# Why the old backups failed: the pg_dump on PATH is 14.x while the local
# server is 18.x, so pg_dump aborts with "server version mismatch" and the
# shell redirect leaves a 0-byte .dump behind. This script resolves a pg_dump
# whose major version matches the server and only publishes a dump after it
# has been verified.
#
# Verification (all must pass, otherwise the partial file is deleted and the
# script exits non-zero):
#   1. pg_dump exit code 0
#   2. file size >= ENGRAM_BACKUP_MIN_BYTES
#   3. pg_restore --list reads the archive and it contains memories data
#   4. memories rows in the archive >= live count minus tolerance
#
# Usage:
#   ENGRAM_ENV_FILE=~/projects/engram/.env scripts/ops/engram-backup.sh
#   DATABASE_URL=postgres://... scripts/ops/engram-backup.sh --dest /tmp/x
#
# Writes <dest>/last-status.json, which scripts/scorecard/ops-health.sh reads.
set -euo pipefail

DEST="${ENGRAM_BACKUP_DIR:-$HOME/engram-backups/local}"
KEEP="${ENGRAM_BACKUP_KEEP:-7}"
MIN_BYTES="${ENGRAM_BACKUP_MIN_BYTES:-100000000}" # 100 MB; local dump is ~2 GB
ROW_TOLERANCE="${ENGRAM_BACKUP_ROW_TOLERANCE:-50}" # writes during the dump
NOTIFY="${ENGRAM_BACKUP_NOTIFY:-1}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --no-notify) NOTIFY=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

mkdir -p "$DEST"
STATUS_FILE="$DEST/last-status.json"
TS=$(date -u '+%Y%m%dT%H%M%SZ')
FINAL="$DEST/engram-local-$TS.dump"
PARTIAL="$FINAL.partial"
TOC_FILE="$DEST/.toc-$TS"
# Remove the partial dump on any exit path, including SIGTERM/SIGINT.
trap 'rm -f "$PARTIAL" "$TOC_FILE"' EXIT
trap 'exit 130' INT TERM

write_status() { # ok|failed, message, bytes, rows
  printf '{"status":"%s","message":"%s","file":"%s","bytes":%s,"memoryRows":%s,"finishedAt":"%s"}\n' \
    "$1" "$2" "$( [ "$1" = ok ] && echo "$FINAL" )" "${3:-0}" "${4:-0}" \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$STATUS_FILE"
}

fail() {
  log "FAILED: $*"
  rm -f "$PARTIAL"
  write_status failed "$*"
  if [ "$NOTIFY" = 1 ] && command -v osascript >/dev/null; then
    osascript -e "display notification \"$*\" with title \"Engram backup FAILED\"" || true
  fi
  exit 1
}

# ── Connection string (never printed) ──
if [ -z "${DATABASE_URL:-}" ] && [ -n "${ENGRAM_ENV_FILE:-}" ]; then
  DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENGRAM_ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"'")
fi
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL not set (set it or ENGRAM_ENV_FILE)"

PSQL=$(command -v psql || echo /opt/homebrew/bin/psql)
q() { "$PSQL" "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "$1"; }

# ── Resolve a pg_dump matching the server major version ──
SERVER_NUM=$(q "SHOW server_version_num") || fail "cannot connect to database"
MAJOR=$((SERVER_NUM / 10000))
PG_BIN=""
for d in "${ENGRAM_PG_BIN:-}" "/opt/homebrew/opt/postgresql@$MAJOR/bin" "/usr/local/opt/postgresql@$MAJOR/bin" \
         "/Applications/Postgres.app/Contents/Versions/$MAJOR/bin"; do
  if [ -n "$d" ] && [ -x "$d/pg_dump" ] && "$d/pg_dump" --version | grep -qE " $MAJOR\."; then
    PG_BIN="$d"; break
  fi
done
[ -n "$PG_BIN" ] || fail "no pg_dump $MAJOR.x found (brew install postgresql@$MAJOR)"
log "server major=$MAJOR pg_dump=$PG_BIN/pg_dump"

LIVE_ROWS=$(q "SELECT count(*) FROM memories") || fail "cannot count memories"
log "live memories rows: $LIVE_ROWS"

# ── Dump (custom format, compressed) ──
START=$(date +%s)
"$PG_BIN/pg_dump" -Fc -Z 6 --no-owner -f "$PARTIAL" "$DATABASE_URL" || fail "pg_dump exited non-zero"
BYTES=$(stat -f%z "$PARTIAL" 2>/dev/null || stat -c%s "$PARTIAL")
log "dump bytes=$BYTES seconds=$(( $(date +%s) - START ))"
[ "$BYTES" -ge "$MIN_BYTES" ] || fail "dump too small: $BYTES bytes < $MIN_BYTES"

# ── Verify archive ──
# TOC goes to a file: `echo "$TOC" | grep -q` fails under pipefail (SIGPIPE),
# and bash 5.3 here-strings of a few hundred bytes hang on this macOS host.
"$PG_BIN/pg_restore" --list "$PARTIAL" > "$TOC_FILE" || fail "pg_restore --list cannot read archive"
grep -qE 'TABLE DATA public memories ' "$TOC_FILE" || fail "archive has no memories table data"
TABLES=$(grep -cE 'TABLE DATA public ' "$TOC_FILE" || true)

# Count COPY rows for memories by streaming just that table's data.
DUMP_ROWS=$("$PG_BIN/pg_restore" -a -t memories -f - "$PARTIAL" \
  | awk '/^COPY public\.memories /{on=1;next} on&&/^\\\.$/{on=0} on{n++} END{print n+0}') \
  || fail "cannot stream memories data from archive"
log "archive tables_with_data=$TABLES memories_rows=$DUMP_ROWS"
[ "$DUMP_ROWS" -ge $((LIVE_ROWS - ROW_TOLERANCE)) ] || fail "archive has $DUMP_ROWS memories rows, live has $LIVE_ROWS"

mv "$PARTIAL" "$FINAL"
write_status ok "verified" "$BYTES" "$DUMP_ROWS"
log "OK $FINAL"

# ── Retention: keep the newest $KEEP verified dumps ──
ls -1t "$DEST"/engram-local-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  log "retention: removing $old"; rm -f "$old"
done
