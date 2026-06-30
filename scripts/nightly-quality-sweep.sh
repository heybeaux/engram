#!/usr/bin/env bash
set -euo pipefail

ENGRAM_DIR="$HOME/projects/agent-memory/engram"
DATE=$(date +%Y-%m-%d)
REPORT_DIR="$ENGRAM_DIR/reports/nightly"
REPORT="$REPORT_DIR/$DATE.md"
ALERT_FILE="/tmp/engram-quality-alert.txt"
API_KEY="${ENGRAM_API_KEY:?Set ENGRAM_API_KEY before running this script}"
USER_ID="${ENGRAM_USER_ID:-user_123}"
HAS_ISSUES=false

mkdir -p "$REPORT_DIR"
rm -f "$ALERT_FILE"

cat > "$REPORT" <<EOF
# Engram Nightly Quality Sweep — $DATE

Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')

EOF

# --- 1. Test Suite ---
echo "## Test Suite" >> "$REPORT"
echo '```' >> "$REPORT"

TEST_OUTPUT=$(cd "$ENGRAM_DIR" && npm test 2>&1) || true
echo "$TEST_OUTPUT" >> "$REPORT"
echo '```' >> "$REPORT"
echo "" >> "$REPORT"

# Parse results
PASS_COUNT=$(echo "$TEST_OUTPUT" | grep -oE '[0-9]+ passing' | head -1 || echo "0 passing")
FAIL_COUNT=$(echo "$TEST_OUTPUT" | grep -oE '[0-9]+ failing' | head -1 || echo "")

echo "- **Passing**: $PASS_COUNT" >> "$REPORT"
if [ -n "$FAIL_COUNT" ]; then
  echo "- **Failing**: $FAIL_COUNT" >> "$REPORT"
  HAS_ISSUES=true
else
  echo "- **Failing**: 0 failing" >> "$REPORT"
fi
echo "" >> "$REPORT"

# --- 2. Health Checks ---
echo "## Health Checks" >> "$REPORT"
echo "" >> "$REPORT"

# Engram API health
echo "### Engram API (:3001)" >> "$REPORT"
HEALTH=$(curl -s --max-time 10 http://localhost:3001/v1/health 2>&1) || HEALTH="UNREACHABLE"
echo '```json' >> "$REPORT"
echo "$HEALTH" >> "$REPORT"
echo '```' >> "$REPORT"
if echo "$HEALTH" | grep -qi "error\|UNREACHABLE\|unhealthy"; then
  HAS_ISSUES=true
  echo "⚠️ **API health issue detected**" >> "$REPORT"
fi
echo "" >> "$REPORT"

# Fog Index
echo "### Fog Index" >> "$REPORT"
FOG=$(curl -s --max-time 10 -H "X-AM-API-Key: $API_KEY" http://localhost:3001/v1/fog-index 2>&1) || FOG="UNREACHABLE"
echo '```json' >> "$REPORT"
echo "$FOG" >> "$REPORT"
echo '```' >> "$REPORT"
echo "" >> "$REPORT"

# Monitoring Status
echo "### Monitoring Status" >> "$REPORT"
MON=$(curl -s --max-time 10 -H "X-AM-API-Key: $API_KEY" http://localhost:3001/v1/monitoring/status 2>&1) || MON="UNREACHABLE"
echo '```json' >> "$REPORT"
echo "$MON" >> "$REPORT"
echo '```' >> "$REPORT"
if echo "$MON" | grep -qi "UNREACHABLE"; then
  HAS_ISSUES=true
fi
echo "" >> "$REPORT"

# Embedding Service
echo "### Embedding Service (:8080)" >> "$REPORT"
EMBED=$(curl -s --max-time 10 http://127.0.0.1:8080/health 2>&1) || EMBED="UNREACHABLE"
echo '```json' >> "$REPORT"
echo "$EMBED" >> "$REPORT"
echo '```' >> "$REPORT"
if echo "$EMBED" | grep -qi "error\|UNREACHABLE\|unhealthy"; then
  HAS_ISSUES=true
  echo "⚠️ **Embedding service issue detected**" >> "$REPORT"
fi
echo "" >> "$REPORT"

# --- 3. Summary ---
echo "## Summary" >> "$REPORT"
if [ "$HAS_ISSUES" = true ]; then
  echo "🔴 **Issues detected** — review above sections." >> "$REPORT"
  cat > "$ALERT_FILE" <<ALERT
Engram Quality Sweep $DATE — ISSUES DETECTED
Report: $REPORT
Tests: $PASS_COUNT ${FAIL_COUNT:+/ $FAIL_COUNT}
Review the full report for details.
ALERT
  echo "Alert written to $ALERT_FILE"
else
  echo "🟢 **All clear** — tests passing, services healthy." >> "$REPORT"
fi

echo ""
echo "Report written to $REPORT"
