# Getting Started

Three ways to use Engram: **self-hosted**, **cloud**, or **hybrid** (both).

---

## Self-Hosted

Run Engram on your own machine. All local features are unlocked with no plan limits.

### Prerequisites

- **Docker** and **Docker Compose** (recommended), OR:
- **Node.js** 18+, **PostgreSQL** 14+ with pgvector, **pnpm**

### Installation

```bash
git clone https://github.com/heybeaux/engram.git && cd engram
cp .env.example .env
docker compose up -d
```

### First Run: Setup Wizard

The Compose stack starts the API on `http://localhost:3001`. The dashboard UI lives in [heybeaux/engram-dashboard](https://github.com/heybeaux/engram-dashboard); if you run it separately at `http://localhost:3000`, the setup wizard appears on first run (no accounts in the database):

1. **Create admin account** — enter your email, password, and name
2. **Choose mode:**
   - **Local only** — everything runs on your machine, zero cloud dependencies
   - **Connect to OpenEngram Cloud** — enter an API key to unlock cloud ensemble models, backup, and cross-device sync
3. **Done** — you're redirected to the dashboard

After setup, subsequent visits show the normal login screen. You can change your cloud connection later in **Settings → Cloud Connection**.

### What You Get

- All 4 local embedding models (bge-base, minilm, gte-base, nomic) via [engram-embed](https://github.com/heybeaux/engram-embed)
- Code Search
- Dream Cycle, deduplication, consolidation
- Ensemble search with Reciprocal Rank Fusion
- No usage limits or plan restrictions

---

## Cloud

Use the managed version — no infrastructure to maintain.

### Setup

Hosted cloud coming soon — join the waitlist at [openengram.ai](https://openengram.ai).

In the meantime, self-host with full features (see above). When cloud launches, you can link your instance.

<!--
1. Go to [app.openengram.ai](https://app.openengram.ai)
2. Get your API key from the dashboard
3. Start making API calls:
-->

```bash
curl -X POST https://api.openengram.ai/v1/memories \
  -H "Content-Type: application/json" \
  -H "X-AM-API-Key: eg_sk_your_key" \
  -H "X-AM-User-ID: user_123" \
  -d '{"raw": "User prefers dark mode"}'
```

### What You Get

- Cloud ensemble models (OpenAI, Cohere)
- Automatic backups
- Cross-device access
- Managed infrastructure, no maintenance

---

## Hybrid (Self-Hosted + Cloud Link)

Start self-hosted, then link to OpenEngram Cloud for premium features. Your data stays local; cloud adds sync and ensemble models.

### Setup

1. Install and run Engram self-hosted (see above)
2. Sign up at [openengram.ai](https://openengram.ai) and get a cloud API key (coming soon — join the waitlist)
3. In the Engram dashboard, go to **Settings → Cloud Connection**
4. Enter your cloud API key and save

### What You Get

Everything from self-hosted, **plus:**

- **Cloud backup** — back up local memories to OpenEngram Cloud
- **Cross-device sync** — access memories from any device via the cloud dashboard
- **Cloud ensemble** — use cloud models (OpenAI, Cohere) alongside your local models

This is the recommended path: start free and local, add cloud features when you need them.

---

## Verifying Your Installation

Check that the API is running:

```bash
curl http://localhost:3001/v1/instance/info
```

Expected response:

```json
{
  "mode": "self-hosted",
  "features": {
    "localEmbeddings": true,
    "cloudEnsemble": false,
    "codeSearch": true,
    "cloudBackup": false,
    "crossDeviceSync": false,
    "billing": false
  },
  "cloudLinked": false
}
```

Check setup status (first-run detection):

```bash
curl http://localhost:3001/v1/auth/setup-status
```

---

## Next Steps

- [API Reference](./API.md) — Full endpoint documentation
- [Configuration](./CONFIGURATION.md) — Environment variables and deployment modes
- [Deployment Architecture](./architecture-deployment.md) — Mode detection, feature gating, cloud link, and sync
