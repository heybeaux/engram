#!/usr/bin/env bash
set -euo pipefail

ENGRAM_DIR="$HOME/projects/agent-memory/engram"
DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')
START_TIME=$(date +%s)
REPORT_DIR="$ENGRAM_DIR/reports/engram-health"
REPORT="$REPORT_DIR/$DATE.md"
API_KEY="${ENGRAM_API_KEY:?Set ENGRAM_API_KEY before running this script}"
USER_ID="${ENGRAM_USER_ID:-user_123}"
HEADERS=(-H "X-AM-API-Key: $API_KEY" -H "X-AM-User-ID: $USER_ID")

mkdir -p "$REPORT_DIR"

cat > "$REPORT" <<EOF
# Engram Self-Analysis — $DATE

Generated: $TIMESTAMP

EOF

# --- Health ---
echo "## Service Health" >> "$REPORT"
HEALTH=$(curl -s --max-time 10 http://localhost:3001/v1/health 2>&1) || HEALTH="UNREACHABLE"
echo '```json' >> "$REPORT"
echo "$HEALTH" >> "$REPORT"
echo '```' >> "$REPORT"
echo "" >> "$REPORT"

# --- Memory Stats ---
echo "## Memory Stats" >> "$REPORT"
STATS=$(curl -s --max-time 10 "${HEADERS[@]}" http://localhost:3001/v1/memories/stats 2>&1) || STATS="UNREACHABLE"
echo '```json' >> "$REPORT"
echo "$STATS" >> "$REPORT"
echo '```' >> "$REPORT"
echo "" >> "$REPORT"

# --- Dedup Stats ---
echo "## Deduplication Stats" >> "$REPORT"
DEDUP=$(curl -s --max-time 10 "${HEADERS[@]}" http://localhost:3001/v1/dedup/stats 2>&1) || DEDUP="UNREACHABLE"
echo '```json' >> "$REPORT"
echo "$DEDUP" >> "$REPORT"
echo '```' >> "$REPORT"
echo "" >> "$REPORT"

# --- Health Metrics ---
echo "## Health Metrics" >> "$REPORT"
METRICS=$(curl -s --max-time 10 "${HEADERS[@]}" http://localhost:3001/v1/health/metrics 2>&1) || METRICS="UNREACHABLE"

if [ "$METRICS" != "UNREACHABLE" ] && echo "$METRICS" | jq -e '.metrics' > /dev/null 2>&1; then
  METRICS_COUNT=$(echo "$METRICS" | jq '.metrics | length')
  for i in $(seq 0 $((METRICS_COUNT - 1))); do
    LABEL=$(echo "$METRICS" | jq -r ".metrics[$i].label")
    VALUE=$(echo "$METRICS" | jq -r ".metrics[$i].value")
    UNIT=$(echo "$METRICS" | jq -r ".metrics[$i].unit // empty")
    STATUS=$(echo "$METRICS" | jq -r ".metrics[$i].status")
    DESC=$(echo "$METRICS" | jq -r ".metrics[$i].description")
    echo "### $LABEL" >> "$REPORT"
    echo "- **Value:** $VALUE${UNIT:+ $UNIT}" >> "$REPORT"
    echo "- **Status:** $STATUS" >> "$REPORT"
    echo "- **Description:** $DESC" >> "$REPORT"
    echo "" >> "$REPORT"
  done
else
  echo '```' >> "$REPORT"
  echo "$METRICS" >> "$REPORT"
  echo '```' >> "$REPORT"
  echo "" >> "$REPORT"
fi

# --- Growth Rate ---
echo "## Growth Rate" >> "$REPORT"
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d "yesterday" +%Y-%m-%d 2>/dev/null || echo "")
PREV_REPORT="$REPORT_DIR/$YESTERDAY.md"

if [ -n "$YESTERDAY" ] && [ -f "$PREV_REPORT" ]; then
  # Extract total memory count from both reports (first number after totalCount or total)
  TODAY_COUNT=$(echo "$STATS" | grep -oE '"total[Cc]ount"\s*:\s*[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "")
  PREV_STATS=$(sed -n '/Memory Stats/,/```$/p' "$PREV_REPORT" | head -20)
  PREV_COUNT=$(echo "$PREV_STATS" | grep -oE '"total[Cc]ount"\s*:\s*[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "")

  if [ -n "$TODAY_COUNT" ] && [ -n "$PREV_COUNT" ]; then
    DIFF=$((TODAY_COUNT - PREV_COUNT))
    echo "- Yesterday: $PREV_COUNT memories" >> "$REPORT"
    echo "- Today: $TODAY_COUNT memories" >> "$REPORT"
    echo "- Change: **${DIFF:+$DIFF}** memories" >> "$REPORT"
  else
    echo "Could not parse memory counts for comparison." >> "$REPORT"
  fi
else
  echo "No previous report found for comparison." >> "$REPORT"
fi
echo "" >> "$REPORT"

# --- Runtime ---
END_TIME=$(date +%s)
RUNTIME=$((END_TIME - START_TIME))
echo "---" >> "$REPORT"
echo "Runtime: ${RUNTIME}s" >> "$REPORT"

echo "Engram self-analysis written to $REPORT"
