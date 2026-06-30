#!/bin/bash
# Sequential re-embed: run one model at a time to avoid Metal GPU memory pressure
# Usage: ./scripts/sequential-reembed.sh

API_URL="http://127.0.0.1:3001"
API_KEY="${ENGRAM_API_KEY:?Set ENGRAM_API_KEY before running this script}"
MODELS=("minilm" "gte-base" "nomic" "kalm-v2" "bge-base")

for model in "${MODELS[@]}"; do
  echo ""
  echo "========================================="
  echo "Starting reembed for: $model"
  echo "Time: $(date)"
  echo "========================================="
  
  # Kick off reembed for single model
  RESPONSE=$(curl -s -X POST "$API_URL/v1/ensemble/reembed" \
    -H "Content-Type: application/json" \
    -H "X-AM-API-Key: $API_KEY" \
    -d "{\"models\": [\"$model\"], \"mode\": \"incremental\"}")
  
  JOB_ID=$(echo "$RESPONSE" | jq -r '.jobId // empty')
  
  if [ -z "$JOB_ID" ]; then
    echo "ERROR: Failed to start reembed for $model"
    echo "Response: $RESPONSE"
    continue
  fi
  
  echo "Job started: $JOB_ID"
  
  # Poll until complete
  while true; do
    sleep 15
    STATUS=$(curl -s "$API_URL/v1/ensemble/reembed/status" \
      -H "X-AM-API-Key: $API_KEY")
    
    JOB_STATUS=$(echo "$STATUS" | jq -r '.status // "unknown"')
    BATCH=$(echo "$STATUS" | jq -r '.progress.currentBatch // 0')
    TOTAL=$(echo "$STATUS" | jq -r '.progress.totalBatches // 0')
    PROCESSED=$(echo "$STATUS" | jq -r '.progress.processedMemories // 0')
    ERRORS=$(echo "$STATUS" | jq -r ".metrics.perModel.\"$model\".errors // 0")
    
    if [ "$JOB_STATUS" = "completed" ] || [ "$JOB_STATUS" = "failed" ] || [ "$JOB_STATUS" = "cancelled" ]; then
      echo "$model finished with status: $JOB_STATUS (processed: $PROCESSED, errors: $ERRORS)"
      break
    fi
    
    if [ -z "$JOB_STATUS" ] || [ "$JOB_STATUS" = "unknown" ] || [ "$JOB_STATUS" = "null" ]; then
      echo "$model: no active job found — may have completed"
      break
    fi
    
    echo "$model: batch $BATCH/$TOTAL ($PROCESSED processed, $ERRORS errors)"
  done
  
  echo "$model complete at $(date)"
  
  # Brief pause between models to let Metal GPU memory settle
  sleep 5
done

echo ""
echo "========================================="
echo "All models complete at $(date)"
echo "========================================="

# Final count
echo ""
echo "Final embedding counts:"
cd /Users/clawdbot/projects/agent-memory/engram && node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
Promise.all([
  p.\$queryRaw\`SELECT COUNT(*)::int as total FROM memories WHERE deleted_at IS NULL\`,
  p.\$queryRaw\`SELECT model_id, COUNT(*)::int as count FROM memory_embeddings GROUP BY model_id ORDER BY count DESC\`,
]).then(([total, models]) => {
  console.log('Total memories:', total[0].total);
  models.forEach(m => console.log('  ' + m.model_id + ': ' + m.count + '/' + total[0].total + ' (' + Math.round(m.count/total[0].total*100) + '%)'));
}).catch(e => console.error(e.message)).finally(() => p.\$disconnect());
"
