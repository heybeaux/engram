#!/bin/bash
# Core functions for git intelligence pipeline
# Sourced by git-intelligence.sh and git-intelligence-incremental.sh

set -euo pipefail

ENGRAM_URL="http://localhost:3001/v1/memories"
API_KEY="${ENGRAM_API_KEY:?Set ENGRAM_API_KEY before running this script}"
USER_ID="${ENGRAM_USER_ID:-user_123}"
REPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/reports/git-intelligence"
REPORT_FILE="$REPORT_DIR/$(date +%Y-%m-%d).md"

REPO_NAMES=("engram" "dashboard" "sf-microservice" "GC" "UltraEdge" "OpenClaw-fork")
REPO_PATHS=(
  "$HOME/projects/agent-memory/engram"
  "$HOME/projects/agent-memory/engram-dashboard"
  "$HOME/projects/salesforce-microservice"
  "$HOME/clawd/projects/generosity-catalyst"
  "$HOME/clawd/projects/ultraedge/app"
  "$HOME/projects/openclaw-fork"
)

TOTAL_INGESTED=0
TOTAL_SKIPPED=0
TOTAL_ERRORS=0

ingest_repo() {
  local name="$1" path="$2" since="$3"
  local repo_ingested=0 repo_skipped=0

  if [[ ! -d "$path/.git" ]]; then
    echo "⚠️  $name: not a git repo or doesn't exist at $path — skipping"
    echo "| $name | — | skipped (not found) |" >> "$REPORT_FILE"
    return 0
  fi

  echo "📂 Processing $name ($path)..."
  cd "$path"

  while IFS='|' read -r hash date author subject; do
    [[ -z "$hash" ]] && continue
    local short_hash="${hash:0:8}"

    # Dedup check
    local search_result
    search_result=$(curl -s --max-time 10 "${ENGRAM_URL}?search=${short_hash}&limit=1" \
      -H "X-AM-API-Key: $API_KEY" -H "X-AM-User-ID: $USER_ID" 2>/dev/null || echo '{"memories":[]}')

    if echo "$search_result" | grep -q "$short_hash"; then
      ((repo_skipped++)) || true
      continue
    fi
    sleep 0.1

    # Get changed files
    local files_raw
    files_raw=$(git diff-tree --no-commit-id --name-only -r "$hash" 2>/dev/null || echo "")
    local files_list="${files_raw//$'\n'/, }"
    local files_json
    if [[ -z "$files_raw" ]]; then
      files_json='[]'
    else
      files_json=$(echo "$files_raw" | grep -v '^$' | jq -R . | jq -s . 2>/dev/null || echo '[]')
    fi

    # Build payload
    local raw="Commit to ${name}: ${subject}\n\nFiles changed: ${files_list}\nDate: ${date}\nAuthor: ${author}\nHash: ${short_hash}"
    local payload
    payload=$(jq -n \
      --arg raw "$raw" \
      --arg repo "$name" \
      --arg author "$author" \
      --arg hash "$hash" \
      --arg date "$date" \
      --argjson files "$files_json" \
      '{
        raw: $raw,
        source: "AGENT_OBSERVATION",
        layer: "SESSION",
        tags: ["git", $repo, "commit"],
        metadata: {
          commitHash: $hash,
          repo: $repo,
          author: $author,
          filesChanged: $files,
          date: $date
        }
      }')

    local response
    response=$(curl -s --max-time 30 -w "\n%{http_code}" -X POST "$ENGRAM_URL" \
      -H "X-AM-API-Key: $API_KEY" \
      -H "X-AM-User-ID: $USER_ID" \
      -H "Content-Type: application/json" \
      -d "$payload" 2>/dev/null || echo -e "\n500")

    local http_code="${response##*$'\n'}"
    if [[ "$http_code" =~ ^2 ]]; then
      ((repo_ingested++)) || true
      echo "  ✅ $short_hash $subject"
    else
      ((TOTAL_ERRORS++)) || true
      echo "  ❌ $short_hash failed ($http_code)"
    fi
    sleep 0.1

  done < <(git log --since="$since" --format='%H|%ai|%an|%s' --no-merges 2>/dev/null || echo "")

  echo "| $name | $repo_ingested | $repo_skipped skipped |" >> "$REPORT_FILE"
  echo "  → $name: $repo_ingested ingested, $repo_skipped skipped"
  TOTAL_INGESTED=$((TOTAL_INGESTED + repo_ingested))
  TOTAL_SKIPPED=$((TOTAL_SKIPPED + repo_skipped))
}

run_pipeline() {
  local since="$1" label="$2"

  mkdir -p "$REPORT_DIR"
  cat > "$REPORT_FILE" <<EOF
# Git Intelligence Report — $(date +%Y-%m-%d)
**Mode:** $label
**Run at:** $(date)

| Repo | Ingested | Notes |
|------|----------|-------|
EOF

  for i in "${!REPO_NAMES[@]}"; do
    ingest_repo "${REPO_NAMES[$i]}" "${REPO_PATHS[$i]}" "$since"
  done

  cat >> "$REPORT_FILE" <<EOF

**Total ingested:** $TOTAL_INGESTED
**Total skipped (dupes):** $TOTAL_SKIPPED
**Errors:** $TOTAL_ERRORS
EOF

  echo ""
  echo "📊 Done! Ingested: $TOTAL_INGESTED | Skipped: $TOTAL_SKIPPED | Errors: $TOTAL_ERRORS"
  echo "📄 Report: $REPORT_FILE"
}
