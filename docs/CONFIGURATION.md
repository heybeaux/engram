# Configuration

All configuration is done via environment variables. Copy `.env.example` to `.env` and customize.

---

## Quick Reference

```bash
# Required
DATABASE_URL="postgresql://user:password@localhost:5432/engram"

# LLM (pick one)
LLM_PROVIDER="openai"
OPENAI_API_KEY="sk-..."

# Vector Store (optional, defaults to pgvector)
VECTOR_PROVIDER="pgvector"

# Deployment Mode (optional, defaults to self-hosted)
DEPLOYMENT_MODE="self-hosted"  # or "cloud"
```

---

## Deployment Mode

### DEPLOYMENT_MODE

Controls whether this instance runs as cloud SaaS or self-hosted. **Default: `self-hosted`** (auto-detected if not set).

| Value | Description |
|-------|-------------|
| `self-hosted` | Local deployment. All local features unlocked. No plan limits. |
| `cloud` | Managed SaaS at app.openengram.ai. Plan-gated features, billing enabled. |

```bash
DEPLOYMENT_MODE="self-hosted"
```

The API exposes the current mode via `GET /v1/instance/info`. The dashboard adapts its UI automatically based on this.

### ENCRYPTION_KEY

Encryption key for securing cloud link credentials and sensitive config stored in the database.

```bash
ENCRYPTION_KEY="your-32-char-secret-key-here"
```

Generate one: `openssl rand -hex 16`

### ENSEMBLE_ENABLED

Enable multi-model ensemble search. Default: `true` for self-hosted (local models), plan-gated for cloud.

```bash
ENSEMBLE_ENABLED=true
```

### CLOUD_API_URL

URL of the OpenEngram Cloud API. Used by self-hosted instances when linked to cloud.

```bash
CLOUD_API_URL="https://api.openengram.ai"
```

### AUTO_SYNC_ENABLED

Enable automatic background sync of memories to cloud (requires cloud link). Default: `false`.

```bash
AUTO_SYNC_ENABLED=false
```

See the [Deployment Architecture doc](./architecture-deployment.md) for details on how mode detection, feature gating, and cloud linking work.

---

## Database

### DATABASE_URL

**Required.** PostgreSQL connection string.

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/engram?schema=public"
```

**Format:** `postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=SCHEMA`

For production, use connection pooling:

```bash
DATABASE_URL="postgresql://user:password@localhost:6543/engram?pgbouncer=true"
```

---

## Server

### PORT

Server port. Default: `3000`

```bash
PORT=3000
```

### NODE_ENV

Environment mode. Values: `development`, `production`, `test`

```bash
NODE_ENV=production
```

In production mode:
- Logging is JSON formatted
- Error stack traces are hidden
- Request validation is stricter

---

## LLM Providers

Engram needs an LLM for two tasks:
1. **Chat/extraction** — Analyzing memories for 5W1H structure
2. **Embeddings** — Generating vectors for semantic search

### LLM_PROVIDER

The LLM provider for chat and extraction.

| Value | Description | API Key Required |
|-------|-------------|------------------|
| `openai` | OpenAI GPT models | Yes |
| `anthropic` | Anthropic Claude models | Yes |
| `ollama` | Local Ollama models | No |
| `lmstudio` | Local LM Studio models | No |

```bash
LLM_PROVIDER="openai"
```

### LLM_MODEL

Model to use for extraction. Provider-specific.

```bash
# OpenAI
LLM_MODEL="gpt-4o-mini"       # Fast, cheap, good
LLM_MODEL="gpt-4o"            # Best quality

# Anthropic
LLM_MODEL="claude-3-5-sonnet-20241022"  # Best balance
LLM_MODEL="claude-3-haiku-20240307"     # Fastest

# Ollama
LLM_MODEL="llama3.2"          # Good general model
LLM_MODEL="mistral"           # Fast alternative

# LM Studio
LLM_MODEL="local-model"       # Whatever is loaded
```

### EMBEDDING_PROVIDER

Provider for generating embeddings. Not all LLM providers support embeddings.

| Provider | Supports Embeddings |
|----------|---------------------|
| `openai` | ✓ Yes |
| `anthropic` | ✗ No |
| `ollama` | ✓ Yes |
| `lmstudio` | ✓ Yes (if embedding model loaded) |

```bash
EMBEDDING_PROVIDER="openai"
```

**Common pattern:** Use Anthropic for extraction, OpenAI for embeddings:

```bash
LLM_PROVIDER="anthropic"
ANTHROPIC_API_KEY="sk-ant-..."
EMBEDDING_PROVIDER="openai"
OPENAI_API_KEY="sk-..."
```

### Embedding retry cron

Every 5 minutes, each Engram process re-embeds memories whose embedding is
PENDING or FAILED. A run is single-flight: a tick that fires while the previous
run is still going does nothing. Each run is also bounded by the settings below.

| Variable | Default | Effect |
|---|---|---|
| `EMBEDDING_RETRY_CRON_ENABLED` | `true` | Set to `false` to turn the cron off in this process, e.g. on extra BullMQ workers when the API process owns retries. Leave it on in at least one process, or FAILED embeddings are never retried. |
| `EMBEDDING_RETRY_BATCH_SIZE` | `100` | Maximum memories discovered and attempted per run. |
| `EMBEDDING_RETRY_TIME_BUDGET_MS` | `240000` | A run stops starting new embeddings after this many ms (keep it below the 5-minute interval). |

`POST /v1/memories/embedding-retry` uses the same guard and returns `skipped: true` when a run is already in flight.

---

## Provider API Keys

### OPENAI_API_KEY

Required if using OpenAI for LLM or embeddings.

```bash
OPENAI_API_KEY="sk-proj-..."
```

Get your key: https://platform.openai.com/api-keys

### ANTHROPIC_API_KEY

Required if using Anthropic for LLM.

```bash
ANTHROPIC_API_KEY="sk-ant-api03-..."
```

Get your key: https://console.anthropic.com/

### OLLAMA_URL

URL for Ollama server. Default: `http://localhost:11434`

```bash
OLLAMA_URL="http://localhost:11434"
```

Make sure required models are pulled:

```bash
ollama pull llama3.2
ollama pull nomic-embed-text  # For embeddings
```

### LMSTUDIO_URL

URL for LM Studio server. Default: `http://localhost:1234/v1`

```bash
LMSTUDIO_URL="http://localhost:1234/v1"
```

Load a model in LM Studio GUI before starting Engram.

---

## Vector Storage

### VECTOR_PROVIDER

Where to store embedding vectors.

| Value | Description | Use Case |
|-------|-------------|----------|
| `pgvector` | PostgreSQL extension | Local, < 1M vectors |
| `pinecone` | Cloud vector DB | Scale, > 1M vectors |

```bash
VECTOR_PROVIDER="pgvector"
```

**pgvector** is the default and requires no additional setup beyond PostgreSQL.

### PINECONE_API_KEY

Required if using Pinecone.

```bash
PINECONE_API_KEY="pcsk_..."
```

Get your key: https://app.pinecone.io/

### PINECONE_INDEX

Pinecone index name. Default: `engram`

```bash
PINECONE_INDEX="engram"
```

Create an index in Pinecone console with:
- **Dimensions:** 1536 (for OpenAI embeddings)
- **Metric:** Cosine

---

## Example Configurations

### Cloud (OpenAI Everything)

Simplest setup. Uses OpenAI for both extraction and embeddings.

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/engram"
LLM_PROVIDER="openai"
LLM_MODEL="gpt-4o-mini"
EMBEDDING_PROVIDER="openai"
OPENAI_API_KEY="sk-..."
VECTOR_PROVIDER="pgvector"
```

### Hybrid (Claude + OpenAI)

Best extraction quality with Anthropic, embeddings with OpenAI.

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/engram"
LLM_PROVIDER="anthropic"
LLM_MODEL="claude-3-5-sonnet-20241022"
ANTHROPIC_API_KEY="sk-ant-..."
EMBEDDING_PROVIDER="openai"
OPENAI_API_KEY="sk-..."
VECTOR_PROVIDER="pgvector"
```

### Fully Local (Ollama)

No cloud dependencies. All processing local.

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/engram"
LLM_PROVIDER="ollama"
LLM_MODEL="llama3.2"
EMBEDDING_PROVIDER="ollama"
OLLAMA_URL="http://localhost:11434"
VECTOR_PROVIDER="pgvector"
```

First, pull required models:

```bash
ollama pull llama3.2
ollama pull nomic-embed-text
```

### Production Scale (Pinecone)

For large-scale deployments with millions of memories.

```bash
DATABASE_URL="postgresql://user:password@db.example.com:5432/engram"
NODE_ENV="production"
LLM_PROVIDER="openai"
LLM_MODEL="gpt-4o-mini"
EMBEDDING_PROVIDER="openai"
OPENAI_API_KEY="sk-..."
VECTOR_PROVIDER="pinecone"
PINECONE_API_KEY="pcsk_..."
PINECONE_INDEX="engram-prod"
```

---

## Embedding Dimensions

Different embedding models produce different dimension vectors:

| Model | Dimensions |
|-------|------------|
| OpenAI `text-embedding-3-small` | 1536 |
| OpenAI `text-embedding-3-large` | 3072 |
| Ollama `nomic-embed-text` | 768 |

If using Pinecone, ensure your index dimensions match your embedding model.

---

## Troubleshooting

### "No LLM provider configured"

Set at least one of:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- Or configure Ollama/LM Studio

### "Provider does not support embeddings"

Anthropic doesn't provide embeddings. Set `EMBEDDING_PROVIDER` to `openai` or `ollama`.

### "Ollama embedding failed"

Pull the embedding model:

```bash
ollama pull nomic-embed-text
```

### "Pinecone index not found"

Create an index in Pinecone console with matching name and dimensions.
