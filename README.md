<p align="center">
  <img src="docs/assets/engram-logo.png" alt="Engram" width="120" />
  <h1 align="center">Engram</h1>
  <p align="center"><strong>Persistent memory for AI agents</strong></p>
  <p align="center">
    <a href="https://github.com/heybeaux/engram/actions"><img src="https://img.shields.io/github/actions/workflow/status/heybeaux/engram/ci.yml?label=build&style=flat-square" alt="Build"></a>
    <a href="https://github.com/heybeaux/engram/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License"></a>
    <a href="https://www.npmjs.com/package/@engram/api"><img src="https://img.shields.io/npm/v/@engram/api?style=flat-square&label=npm" alt="npm"></a>
    <a href="https://github.com/heybeaux/engram"><img src="https://img.shields.io/github/stars/heybeaux/engram?style=flat-square" alt="Stars"></a>
  </p>
  <p align="center">
    <a href="https://openengram.ai">Hosted Version</a> •
    <a href="https://github.com/heybeaux/engram-mcp">MCP Server</a> •
    <a href="https://github.com/heybeaux/engram-dashboard">Dashboard</a> •
    <a href="https://github.com/heybeaux/engram-embed">Local Embeddings</a> •
    <a href="https://github.com/heybeaux/engram-client">TypeScript SDK</a> •
    <a href="https://github.com/heybeaux/engram/blob/main/docs/API.md">API Docs</a>
  </p>
</p>

---

## What is Engram?

Engram is a memory layer for AI agents — store, recall, and evolve memories with semantic search, knowledge graphs, and autonomous consolidation. It gives your agents persistent, structured memory so they never wake up blank again.

> An **engram** is a hypothetical permanent change in the brain accounting for the existence of memory — a memory trace.

## Key Features

- 🧠 **Semantic memory storage** with vector embeddings — find memories by meaning, not keywords
- 🔍 **Ensemble search** (4 models) — Reciprocal Rank Fusion eliminates single-model blind spots
- 🌙 **Dream Cycle** — autonomous memory consolidation inspired by sleep neuroscience
- 🕸️ **Knowledge graph extraction** — entities and relationships visualized with D3
- 🔒 **Multi-tenant with API key auth** — cryptographic user isolation
- 💳 **SaaS-ready** — usage tracking and cloud features built in
- 🐳 **Docker Compose** for easy self-hosting — up and running in 3 commands
- 🔗 **Hybrid mode** — self-hosted + cloud link for backup, sync, and cloud ensemble models
- 🏠 **Self-hosted setup wizard** — first-run detection, guided setup, zero config
- 📡 **Webhooks with HMAC signing** — real-time event notifications
- 🛡️ **Safety-critical detection** — 16 patterns for allergies, medications, legal directives
- ⏰ **Temporal reasoning** — understands "yesterday," "last week," natural language time
- 📊 **Fog Index** — cognitive health scoring to monitor memory drift

## Quick Start

### Self-Hosted

```bash
git clone https://github.com/heybeaux/engram && cd engram
cp .env.example .env
docker compose up -d
```

API at `localhost:3001` · Dashboard at `localhost:3000`

On first run, the **setup wizard** walks you through creating an admin account and choosing your mode (local-only or linked to OpenEngram Cloud). No manual config needed — just open the dashboard.

### Cloud

Hosted cloud coming soon — join the waitlist at [openengram.ai](https://openengram.ai).

### Hybrid Mode

Run self-hosted with full local features, then **link to OpenEngram Cloud** from Settings to unlock cloud ensemble models, backup, and cross-device sync. Best of both worlds — your data stays local, premium features from the cloud.

See the [Getting Started Guide](./docs/getting-started.md) for detailed walkthroughs.

## API Example

**Store a memory:**

```bash
curl -X POST https://api.openengram.ai/v1/memories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"content": "The user prefers dark mode and is allergic to peanuts", "metadata": {}}'
```

**Search memories:**

```bash
curl -X POST https://api.openengram.ai/v1/memories/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"query": "What are the user preferences?", "limit": 5}'
```

## Cloud

Hosted cloud coming soon — join the waitlist at [openengram.ai](https://openengram.ai).

Self-hosting is fully supported today with no feature limits.

## Documentation

- [Getting Started](./docs/getting-started.md) — Self-hosted, cloud, and hybrid setup
- [API Reference](./docs/API.md) — Full endpoint documentation
- [Deployment Architecture](./docs/architecture-deployment.md) — Mode detection, feature gating, cloud link, sync
- [Configuration](./docs/CONFIGURATION.md) — All environment variables and deployment modes
- [Swagger UI](http://localhost:3001/v1/docs) — Interactive API explorer (when running locally)
- [Online Docs](https://openengram.ai/docs) — Hosted documentation

## Self-Hosting

See [QUICKSTART.md](./QUICKSTART.md) for detailed self-hosting instructions including:

- Docker Compose setup
- Building from source
- Fully local mode (Ollama + engram-embed, zero cloud dependency)
- Environment configuration

## Architecture

<p align="center">
  <img src="docs/assets/engram-banner.png" alt="Engram Architecture" width="700" />
</p>

Engram is built on NestJS with PostgreSQL + pgvector for storage. The system includes:

- **Core API** — CRUD, search, context generation, 120+ endpoints
- **Ensemble Search** — 4 embedding models fused via Reciprocal Rank Fusion
- **Dream Cycle** — 4-stage consolidation: dedup → staleness → patterns → report
- **engram-embed** — Local Rust embedding server with Metal GPU acceleration (~10ms per vector)
- **Dashboard** — Next.js app for memory browsing, knowledge graph visualization, and system monitoring

See the [Architecture Documentation](./docs/ARCHITECTURE.md) for the full technical breakdown.

## Integration

### MCP (Claude Desktop, Cursor, etc.)

```bash
npm install -g @engram/mcp-server
```

6 tools: `engram_remember`, `engram_recall`, `engram_search`, `engram_context`, `engram_observe`, `engram_forget`

### REST API

Point any AI agent at the API. Works with OpenAI, Anthropic, Ollama, LM Studio — swap LLM providers with one env var.

### TypeScript SDK

```bash
npm install @engram/client
```

## Comparison

| Feature | Engram | Mem0 | Zep | LangMem |
|---------|--------|------|-----|---------|
| Self-hosted | ✅ | ✅ | ✅ | ✅ |
| Local embeddings (zero cost) | ✅ Metal GPU | ❌ | ❌ | ❌ |
| Multi-model ensemble search | ✅ 4 models | ❌ | ❌ | ❌ |
| Dream Cycle (consolidation) | ✅ 4-stage | ❌ | ❌ | ❌ |
| Safety-critical detection | ✅ 16 patterns | ❌ | ❌ | ❌ |
| Knowledge graph | ✅ | ❌ | ✅ | ❌ |
| Temporal reasoning | ✅ | ❌ | ❌ | ❌ |
| SaaS-ready (billing, limits) | ✅ | ❌ | ❌ | ❌ |
| License | Apache 2.0 | Apache 2.0 | Apache 2.0 | MIT |

## Screenshots

<p align="center">
  <img src="docs/screenshots/dashboard-overview.jpg" alt="Dashboard Overview" width="700" /><br />
  <em>Dashboard — Memory stats, Fog Index, API volume</em>
</p>

<p align="center">
  <img src="docs/screenshots/knowledge-graph.jpg" alt="Knowledge Graph" width="700" /><br />
  <em>Knowledge Graph — Entities and relationships visualized with D3</em>
</p>

<p align="center">
  <img src="docs/screenshots/memories.jpg" alt="Memory Browser" width="700" /><br />
  <em>Memory Browser — Semantic search, layer filtering, importance scores</em>
</p>

## Recall Benchmark

Engram includes a comprehensive recall benchmark suite that tests semantic retrieval quality across 81 queries in 7 categories. Every PR runs the benchmark in CI with real embeddings (bge-base-en-v1.5) and ensemble reranking.

### Latest Results (March 2026)

| Metric | Pre-Dream Cycle | Post-Dream Cycle |
|--------|:-:|:-:|
| **Precision@5** | 95.1% ✅ | 96.9% ✅ |
| **Recall@20** | 95.7% | 96.9% |
| **MRR** | 0.836 | 0.874 |
| **Isolation** | 100% ✅ | 100% ✅ |
| **Queries Passed** | 78/81 | 79/81 |

<details>
<summary>Category Breakdown (Post-Dream Cycle)</summary>

| Category | Queries | Passed | P@5 | R@20 | MRR | Isolation |
|----------|:-------:|:------:|:---:|:----:|:---:|:---------:|
| Adversarial | 10 | 10 | 100% | 100% | 1.00 | 100% |
| Cross-feature | 10 | 10 | 100% | 100% | 0.88 | 100% |
| Edge case | 16 | 16 | 100% | 100% | 0.95 | 100% |
| Emotional | 10 | 9 | 85% | 95% | 0.73 | 100% |
| RLS isolation | 10 | 10 | 100% | 100% | 0.88 | 100% |
| Semantic | 14 | 13 | 93% | 100% | 0.79 | 100% |
| Temporal | 11 | 11 | 100% | 82% | 0.87 | 100% |

</details>

### Benchmark Progression

The recall pipeline evolved through several iterations:

| Phase | P@5 | Notes |
|-------|:---:|-------|
| Baseline (cosine only) | ~45% | Single-model vector search, no reranking |
| + BM25 hybrid | ~65% | Full-text search fusion for keyword recall |
| + Sentiment polarity | ~75% | Penalizes opposite-emotion memories |
| + Ensemble reranking | ~85% | 2 cross-encoder models via RRF |
| + Fixture enrichment | ~90% | Realistic gold memories, noise calibration |
| + Temporal patterns | 95.1% | Month/year/week recognition, expanded BM25 pool |
| + Dream Cycle | **96.9%** | Post-consolidation: cleaner corpus, higher signal |

### Running the Benchmark

```bash
# Requires: PostgreSQL (pgvector), embedding server, reranker servers
pnpm benchmark                              # Pre-dream-cycle
pnpm test:e2e -- --testPathPatterns=recall-benchmark-dream  # Post-dream-cycle
pnpm benchmark:compare                      # Compare latest vs previous run
```

## Contributing

We'd love your help! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

**High-impact areas:**
- Python SDK
- Integration adapters (LangChain, CrewAI, AutoGen)
- New embedding/LLM providers
- Documentation and examples

## License

[Apache License 2.0](./LICENSE)

---

<p align="center">
  <em>Every agent deserves to remember.</em>
</p>
