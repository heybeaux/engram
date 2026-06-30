#!/bin/bash
set -euo pipefail

# Transcript-to-Memory Pipeline for Engram
# Ingests OpenClaw conversation transcripts as Engram memories
# Usage: transcript-to-memory.sh [--full]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TRANSCRIPT_DIR="$HOME/.openclaw/agents/main/sessions"
STATE_FILE="$BASE_DIR/reports/transcript-state.json"
REPORT_DIR="$BASE_DIR/reports/transcript-ingest"
TODAY=$(date +%Y-%m-%d)
REPORT_FILE="$REPORT_DIR/$TODAY.md"

ENGRAM_URL="http://localhost:3001/v1/memories"
API_KEY="${ENGRAM_API_KEY:?Set ENGRAM_API_KEY before running this script}"
USER_ID="${ENGRAM_USER_ID:-user_123}"

FULL_MODE="${1:-}"

mkdir -p "$REPORT_DIR"

# Init state file if missing
if [[ ! -f "$STATE_FILE" ]]; then
  echo '{"processed":{}}' > "$STATE_FILE"
fi

# Do everything in Python for safe JSON handling
export STATE_FILE REPORT_FILE TODAY ENGRAM_URL API_KEY USER_ID
export FULL_MODE="$FULL_MODE"
python3 -u << 'PYEOF'
import json, os, sys, time, subprocess, glob

TRANSCRIPT_DIR = os.path.expanduser("~/.openclaw/agents/main/sessions")
STATE_FILE = os.environ.get("STATE_FILE", "STATE_FILE_PLACEHOLDER")
REPORT_FILE = os.environ.get("REPORT_FILE", "REPORT_FILE_PLACEHOLDER")
TODAY = os.environ.get("TODAY", "TODAY_PLACEHOLDER")
FULL_MODE = os.environ.get("FULL_MODE", "")
ENGRAM_URL = os.environ.get("ENGRAM_URL", "ENGRAM_URL_PLACEHOLDER")
API_KEY = os.environ.get("API_KEY", "API_KEY_PLACEHOLDER")
USER_ID = os.environ.get("USER_ID", "USER_ID_PLACEHOLDER")

CHUNK_SIZE = 2000
MIN_CONVERSATION_LEN = 200

# Load state
try:
    with open(STATE_FILE) as f:
        state = json.load(f)
except:
    state = {"processed": {}}

if "processed" not in state:
    state["processed"] = {}

# Find files
all_files = sorted(glob.glob(os.path.join(TRANSCRIPT_DIR, "*.jsonl")))

if FULL_MODE == "--full":
    files = all_files
    print(f"=== Full backfill mode ===")
else:
    # Last 24 hours
    cutoff = time.time() - 86400
    files = [f for f in all_files if os.path.getmtime(f) > cutoff]
    print(f"=== Incremental mode (last 24h) ===")

print(f"Found {len(files)} transcript files")

total_files = 0
total_chunks = 0
skipped_short = 0
skipped_processed = 0
errors = 0

def extract_conversation(filepath):
    lines = []
    with open(filepath) as f:
        for line in f:
            try:
                entry = json.loads(line.strip())
                # OpenClaw format: {"type":"message","message":{"role":...,"content":...}}
                msg = entry.get("message", entry)
                role = msg.get("role", "")
                if role in ("user", "assistant"):
                    content = msg.get("content", "")
                    if isinstance(content, list):
                        texts = [c.get("text", "") for c in content if c.get("type") == "text"]
                        content = " ".join(texts)
                    if isinstance(content, str) and len(content) > 20:
                        lines.append(f"{role}: {content[:500]}")
            except:
                pass
    return "\n".join(lines)

def chunk_text(text, size=CHUNK_SIZE):
    chunks = []
    while text:
        if len(text) <= size:
            chunks.append(text)
            break
        idx = text.rfind("\n", 0, size)
        if idx == -1:
            idx = size
        chunks.append(text[:idx])
        text = text[idx:].lstrip("\n")
    return chunks

def post_memory(raw, session_file):
    payload = json.dumps({
        "raw": raw,
        "source": "AGENT_OBSERVATION",
        "layer": "SESSION",
        "tags": ["conversation", "transcript", "daily"],
        "metadata": {
            "source": "openclaw-transcript",
            "sessionFile": session_file,
            "date": TODAY
        }
    })
    try:
        result = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
             "-X", "POST", ENGRAM_URL,
             "-H", f"X-AM-API-Key: {API_KEY}",
             "-H", f"X-AM-User-ID: {USER_ID}",
             "-H", "Content-Type: application/json",
             "-d", payload,
             "--connect-timeout", "5",
             "--max-time", "15"],
            capture_output=True, text=True, timeout=20
        )
        return int(result.stdout.strip() or "0")
    except Exception as e:
        print(f"  WARN: API error: {e}")
        return 0

for filepath in files:
    fname = os.path.basename(filepath)

    if fname in state["processed"]:
        skipped_processed += 1
        continue

    conversation = extract_conversation(filepath)
    if len(conversation) < MIN_CONVERSATION_LEN:
        skipped_short += 1
        continue

    chunks = chunk_text(conversation)
    if not chunks:
        skipped_short += 1
        continue

    print(f"Processing {fname} ({len(chunks)} chunks)...")
    file_errors = 0

    for i, chunk in enumerate(chunks):
        status = post_memory(chunk, fname)
        if 200 <= status < 300:
            total_chunks += 1
        else:
            print(f"  WARN: chunk {i} returned HTTP {status}")
            file_errors += 1
            errors += 1
        time.sleep(0.1)

    if file_errors == 0:
        state["processed"][fname] = {"date": TODAY, "chunks": len(chunks)}
        total_files += 1

# Save state
with open(STATE_FILE, "w") as f:
    json.dump(state, f, indent=2)

# Summary
mode = "Full backfill" if FULL_MODE == "--full" else "Incremental"
summary = f"""# Transcript Ingest Report — {TODAY}

- Mode: {mode}
- Files found: {len(files)}
- Files ingested: {total_files}
- Chunks created: {total_chunks}
- Skipped (already processed): {skipped_processed}
- Skipped (too short): {skipped_short}
- Errors: {errors}
"""

print()
print(summary)
with open(REPORT_FILE, "w") as f:
    f.write(summary)
print(f"Report written to {REPORT_FILE}")
PYEOF
