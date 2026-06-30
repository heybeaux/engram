# API Reference

Engram API v1 — Memory infrastructure for AI agents.

**Base URL:** `http://localhost:3001` (self-hosted) or `https://api.openengram.ai` (cloud)

**Interactive Docs:** `{base_url}/api-docs` (Swagger UI)

## Authentication

All endpoints (except `/v1/health`) require authentication via one of these methods:

### API Key (Recommended)

Pass your API key in the `X-AM-API-Key` header:

```
X-AM-API-Key: your-api-key-here
```

Also include a user identifier:

```
X-AM-User-ID: user-123
```

And optionally scope to an agent:

```
X-AM-Agent-ID: my-agent
```

### JWT Bearer Token

For dashboard and OAuth integrations:

```
Authorization: Bearer <jwt-token>
```

### Instance Sync Key

For cloud sync endpoints (`/v1/sync/*`), local instances authenticate with their instance key via the `InstanceSyncKeyGuard`.

## Rate Limits

Rate limits use an in-memory token-bucket algorithm, scoped per API key.

Plan limits:

| Plan | Memories | API Calls/Day | Agents | Users/Agent | Ensemble Models |
|------|----------|---------------|--------|-------------|-----------------|
| Free | 1,000 | 100 | 1 | 1 | 0 |
| Starter | 10,000 | 1,000 | 3 | 10 | 2 |
| Pro | 100,000 | 10,000 | 10 | 100 | 3 |
| Scale | 1,000,000 | 100,000 | Unlimited | Unlimited | 3 |

Rate-limited responses return `429 Too Many Requests`.

## Error Response Format

All errors follow a consistent format:

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request"
}
```

Common status codes:

| Code | Meaning |
|------|---------|
| `400` | Bad Request — invalid input |
| `401` | Unauthorized — missing or invalid API key |
| `403` | Forbidden — insufficient permissions |
| `404` | Not Found |
| `429` | Too Many Requests — rate limit exceeded |
| `500` | Internal Server Error |
| `503` | Service Unavailable — database down |

## Pagination

List endpoints accept `limit` and `offset` query parameters:

```
GET /v1/memories?limit=20&offset=40
```

- `limit` — Maximum items to return (default varies by endpoint, typically 20–100)
- `offset` — Number of items to skip

Responses include the items array directly. Use the array length to determine if more results exist.

## Endpoint Reference

### Memory Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/memories` | Create a memory |
| `POST` | `/v1/memories/batch` | Create memories in batch |
| `GET` | `/v1/memories` | List memories |
| `GET` | `/v1/memories/:id` | Get a memory by ID |
| `PATCH` | `/v1/memories/:id` | Update a memory |
| `DELETE` | `/v1/memories/:id` | Delete a memory |
| `POST` | `/v1/memories/:id/used` | Mark memory as used (boosts ranking) |
| `POST` | `/v1/memories/:id/helpful` | Mark memory as helpful |
| `GET` | `/v1/memories/export` | Export memories |
| `POST` | `/v1/memories/import` | Import memories |
| `GET` | `/v1/memories/graph` | Memory graph visualization |

### Search & Recall

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/memories/query` | Query memories with filters |
| `POST` | `/v1/memories/search` | Semantic search |
| `GET` | `/v1/memories/search` | Semantic search (GET) |
| `POST` | `/v1/recall` | Semantic recall |
| `POST` | `/v1/recall/contextual` | Context-aware recall |
| `POST` | `/v1/context` | Generate context for LLM prompts |
| `POST` | `/v1/multi-query/search` | Multi-query expanded search |

### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/agents/:id/reflect` | Trigger self-reflection |
| `GET` | `/v1/agents/:id/memories` | Get agent self-memories |
| `GET` | `/v1/agents/:id/context` | Get agent context for prompts |

### Identity

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/identity/task-completions` | Record task completion |
| `GET` | `/v1/identity/task-completions` | Query task completions |
| `GET` | `/v1/identity/delegation-templates` | Get delegation suggestions |
| `GET` | `/v1/identity/agents/:id/trust-profile` | Get trust profile |
| `POST` | `/v1/identity/teams` | Create team |
| `GET` | `/v1/identity/teams/:id` | Get team |
| `GET` | `/v1/identity/teams/:id/capabilities` | Get team capabilities |
| `GET` | `/v1/identity/delegation-recall` | Delegation-aware recall |
| `GET` | `/v1/identity/agents/:id/export` | Export agent identity |
| `POST` | `/v1/identity/agents/import` | Import agent identity |

### Awareness

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/awareness/status` | Check awareness configuration |
| `POST` | `/v1/awareness/cycle` | Trigger waking cycle |

### Cloud Sync

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/cloud/sync` | Trigger cloud backup sync |
| `GET` | `/v1/cloud/sync/status` | Get sync status |
| `DELETE` | `/v1/cloud/sync` | Cancel in-progress sync |
| `PUT` | `/v1/cloud/sync/auto-sync` | Toggle auto-sync (admin) |
| `GET` | `/v1/cloud/sync/history` | Sync history |
| `POST` | `/v1/cloud/sync/pull` | Pull from cloud |
| `POST` | `/v1/sync/push` | Push memories (instance key auth) |
| `GET` | `/v1/sync/pull` | Pull memories (instance key auth) |
| `GET` | `/v1/sync/instances` | List connected instances |

### Knowledge Graph

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/graph/extract` | Extract entities from text |
| `GET` | `/v1/graph/entities` | List entities |
| `GET` | `/v1/graph/relationships` | List relationships |

### Deduplication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/dedup/scan` | Scan for duplicates |
| `POST` | `/v1/dedup/merge` | Merge duplicate memories |
| `GET` | `/v1/dedup/review` | Get merge candidates for review |

### Consolidation

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/consolidate` | Trigger dream cycle |
| `GET` | `/v1/consolidate/stats` | Consolidation statistics |

### Memory Pools

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/pools` | Create a memory pool |
| `GET` | `/v1/pools` | List pools |
| `GET` | `/v1/pools/:id` | Get pool details |

### Hierarchy & Segmentation

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/hierarchy/query` | Hierarchical query routing |
| `GET` | `/v1/hierarchy/segments` | List memory segments |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/health` | Health check (no auth required) |
| `GET` | `/v1/users` | List users |
| `POST` | `/v1/summarize` | Summarize text |
| `POST` | `/v1/correction` | Submit a correction |
| `GET` | `/v1/analytics/summary` | Usage analytics (cloud) |
| `GET` | `/v1/analytics/timeline` | Timeline analytics (cloud) |
| `POST` | `/v1/webhooks` | Create webhook subscription (cloud) |
| `GET` | `/v1/webhooks` | List webhooks (cloud) |
| `GET` | `/v1/fog-index/:id` | Get fog index for a memory |
| `GET` | `/v1/clustering` | Get memory clusters |
