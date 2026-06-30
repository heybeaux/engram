# Engram Quickstart

Get the self-hosted Engram API running locally with Docker Compose.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose

## Setup

```bash
git clone https://github.com/heybeaux/engram.git && cd engram
cp .env.example .env
docker compose up -d
```

The API listens on `http://localhost:3001`. The dashboard UI is a separate app in [heybeaux/engram-dashboard](https://github.com/heybeaux/engram-dashboard); run it alongside this API if you want the browser setup wizard.

## Verify

```bash
curl http://localhost:3001/v1/health
```

Interactive Swagger/OpenAPI docs are available at `http://localhost:3001/api-docs`.

## Create a Local API Key

Protected endpoints require a DB-backed agent API key. For a fresh self-hosted instance, register the first account and copy the `apiKey` value from the response:

```bash
curl -X POST http://localhost:3001/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"change-me-now","name":"Demo User"}'
```

The response includes a one-time `apiKey` that starts with `eng_...`. Save it locally for the following examples:

```bash
export ENGRAM_API_KEY="<api-key-from-register-response>"
```

If you are using the dashboard setup wizard instead, it creates the same kind of agent API key for your account.

> Local development alternative: set `TRUST_LOCAL_NETWORK=true` in `.env` before `docker compose up -d` to allow local/LAN requests without `X-AM-API-Key`. Only do this on trusted local networks; never behind a public reverse proxy.

## Create a Memory

```bash
curl -X POST http://localhost:3001/v1/memories \
  -H "Content-Type: application/json" \
  -H "X-AM-API-Key: $ENGRAM_API_KEY" \
  -H "X-AM-User-ID: demo" \
  -d '{"raw": "The user prefers dark mode"}'
```

## Search Memories

```bash
curl -X POST http://localhost:3001/v1/memories/search \
  -H "Content-Type: application/json" \
  -H "X-AM-API-Key: $ENGRAM_API_KEY" \
  -H "X-AM-User-ID: demo" \
  -d '{"query": "UI preferences", "limit": 5}'
```

## Embedding Options

The default Compose stack sets `EMBEDDING_PROVIDER=local`. Run the local embedding service separately, or set these in `.env` to use OpenAI embeddings instead:

```env
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=***
```
