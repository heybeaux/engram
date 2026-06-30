import json, os, requests, time, sys

API_URL = os.environ.get("ENGRAM_API_URL", "http://localhost:3001")
API_KEY = os.environ.get("ENGRAM_API_KEY")
USER_ID = os.environ.get("ENGRAM_USER_ID", "user_123")

if not API_KEY:
    raise SystemExit("Set ENGRAM_API_KEY before running this script")

HEADERS = {
    "Content-Type": "application/json",
    "X-AM-API-Key": API_KEY,
    "X-AM-User-ID": USER_ID
}

with open("/Users/clawdbot/projects/agent-memory/engram/scripts/seed-memories.json") as f:
    memories = json.load(f)

print(f"Total memories to ingest: {len(memories)}")

success = 0
failed = 0
errors = []

for i, mem in enumerate(memories):
    try:
        # Build payload from seed data
        payload = {
            "raw": mem["raw"],
            "layer": mem.get("layer", "SESSION"),
        }
        
        # Map importanceScore to importance (numeric 0-1 which gets mapped to importanceHint)
        if "importanceScore" in mem:
            payload["importance"] = mem["importanceScore"]
        
        resp = requests.post(
            f"{API_URL}/v1/memories",
            headers=HEADERS,
            json=payload,
            timeout=30
        )
        if resp.status_code in (200, 201):
            success += 1
        else:
            failed += 1
            errors.append(f"#{i}: {resp.status_code} - {resp.text[:200]}")

        if (i + 1) % 20 == 0:
            print(f"Progress: {i+1}/{len(memories)} (success={success}, failed={failed})")
            sys.stdout.flush()

    except Exception as e:
        failed += 1
        errors.append(f"#{i}: {str(e)[:200]}")

print(f"\nDone! Success: {success}, Failed: {failed}")
if errors:
    print(f"\nFirst {min(10, len(errors))} errors:")
    for e in errors[:10]:
        print(f"  {e}")
