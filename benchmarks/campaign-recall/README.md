# Engram Campaign Data Benchmark

Benchmarks Engram's recall quality for nonprofit email campaign data, testing two storage formats.

## Setup

```bash
cd ~/projects/engram-benchmark
npm install
```

## Usage

### 1. Generate Data (run once)
```bash
npm run generate
```
Generates 100 synthetic campaigns (5 clients × 20 each), stores as Format A + Format B in Engram, saves `benchmark-data.json`.

### 2. Run Benchmark
```bash
npm run benchmark
```
Runs 30 recall queries, scores P@5, P@10, client isolation. Saves `benchmark-results.json`.

### 3. Cleanup (optional)
```bash
npm run cleanup
```
Deletes all 200 benchmark memories from Engram (uses stored IDs from benchmark-data.json).

## What It Tests

**5 Clients, 20 campaigns each (100 total):**
- Powell River Food Bank — food bank, small (~3K donors)
- West Coast Wildlife Trust — environmental, medium (~8K donors)
- Sunrise Youth Foundation — youth services, small (~2K donors)
- Pacific Hope Medical — health, large (~15K donors)
- Arts Council Vancouver — arts/culture, medium (~5K donors)

**Campaign types:** 10 newsletters, 5 appeals, 3 events, 2 re-engagements per client

**Two storage formats:**
- **Format A** — Raw prose (metrics only, no analysis)
- **Format B** — Pre-computed insights with client averages, comparisons, recommendations

**30 queries in 3 categories:**
1. Semantic Basic (Q01-Q10) — Find by type, performance metric, send day
2. Semantic Cross-Client (Q11-Q20) — Find by sector, compare across clients
3. Client-Specific (Q21-Q30) — Isolated client queries, tests client isolation

**Scoring:**
- P@5: Precision at 5 (fraction of top 5 results that are relevant)
- P@10: Precision at 10 (fraction of top 10)
- Client Isolation: For client-specific queries, fraction of top 10 from correct client
- Grade: A (≥80% P@5), B (≥60%), C (≥40%), D (<40%)

## Files

```
engram-benchmark/
├── src/
│   ├── data-generator.ts   # Generate + store 100 campaigns
│   ├── benchmark-runner.ts # Run 30 queries + score
│   └── cleanup.ts          # Delete all benchmark memories
├── benchmark-data.json     # Generated campaign data + Engram IDs
├── benchmark-results.json  # Query results + scores
├── package.json
└── README.md
```

## Engram Config
- Base URL: `http://localhost:3001`
- User: `Beaux`
- All benchmark memories tagged `benchmark:true` for safe cleanup
