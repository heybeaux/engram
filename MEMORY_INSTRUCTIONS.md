# Memory Instructions

Before finishing your task, POST a completion memory to Engram so future agents benefit from your work.

## Real-time memory (default)

For memories about things happening **right now**, omit `observedAt` — the server uses the ingest timestamp (`recordedAt`):

```bash
curl -s -X POST "https://api.openengram.ai/v1/memories" \
  -H "Content-Type: application/json" \
  -H "X-AM-API-Key: eng_kit_local_dev_2026" \
  -H "X-AM-User-ID: beaux" \
  -d '{
    "content": "YOUR SUMMARY HERE",
    "type": "episodic",
    "layer": "SESSION",
    "source": "AGENT_OBSERVATION",
    "agentId": "kit",
    "metadata": { "label": "YOUR_TASK_LABEL" }
  }'
```

## Historical import (pass the original event time)

For memories about **past events** (imported notes, conversation history, log entries), pass `observedAt` so temporal recall anchors to when the event actually occurred rather than when it was ingested. Also set `source` to `HISTORICAL`:

```bash
curl -s -X POST "https://api.openengram.ai/v1/memories" \
  -H "Content-Type: application/json" \
  -H "X-AM-API-Key: eng_kit_local_dev_2026" \
  -H "X-AM-User-ID: beaux" \
  -d '{
    "content": "YOUR SUMMARY HERE",
    "type": "episodic",
    "layer": "SESSION",
    "source": "HISTORICAL",
    "observedAt": "2026-01-15T14:00:00Z",
    "agentId": "kit",
    "metadata": { "label": "YOUR_TASK_LABEL" }
  }'
```

If `source` is `HISTORICAL` but `observedAt` is missing, the response includes a `warnings` array with `code: "HISTORICAL_WITHOUT_ANCHOR"` to alert you that temporal extraction may be inaccurate.

**What to include (under 200 words):**
- What you did and the outcome (success/failure)
- Files changed or created
- Patterns or gotchas discovered
- Test results if applicable
- Anything the next agent working on this should know

**Do this as your final step before completing.**
