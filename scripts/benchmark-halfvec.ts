/**
 * Halfvec Benchmark — ENG-51
 *
 * Compares recall quality and latency between float32 vector(768) and
 * float16 halfvec(768) using Alice's gold queries.
 *
 * Prerequisites:
 *   1. Migration 20260326_add_halfvec_shadow applied
 *   2. Backfill completed (scripts/backfill-halfvec.ts)
 *   3. Local embed service running on port 8080
 *
 * Usage:
 *   npx ts-node scripts/benchmark-halfvec.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

// ── Configuration ───────────────────────────────────────────────

const EMBED_URL =
  process.env.EMBED_URL || 'http://localhost:8080/v1/embeddings';
const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-base-en-v1.5';
const TOP_K = 5;

// ── Alice's gold queries (semantic, emotional, temporal) ────────

interface BenchQuery {
  id: string;
  query: string;
  user: string;
  category: string;
}

const ALICE_QUERIES: BenchQuery[] = [
  // Semantic
  { id: 'semantic_001', query: 'What kind of coffee do I like?', user: 'alice', category: 'semantic' },
  { id: 'semantic_002', query: 'Tell me about my morning routine', user: 'alice', category: 'semantic' },
  { id: 'semantic_003', query: 'What tech stack am I using?', user: 'alice', category: 'semantic' },
  { id: 'semantic_005', query: 'What books have I been reading?', user: 'alice', category: 'semantic' },
  { id: 'semantic_006', query: 'favorite dinner recipe', user: 'alice', category: 'semantic' },
  { id: 'semantic_007', query: 'house savings goal', user: 'alice', category: 'semantic' },
  { id: 'semantic_009', query: 'flight seat preference', user: 'alice', category: 'semantic' },
  { id: 'semantic_010', query: 'ensemble search architecture decision', user: 'alice', category: 'semantic' },
  { id: 'semantic_011', query: 'What coffee roast do I prefer?', user: 'alice', category: 'semantic' },
  // Emotional
  { id: 'emotional_001', query: 'What makes me happy?', user: 'alice', category: 'emotional' },
  { id: 'emotional_002', query: 'times I felt sad or grieving', user: 'alice', category: 'emotional' },
  { id: 'emotional_003', query: 'when I felt stressed or overwhelmed', user: 'alice', category: 'emotional' },
  { id: 'emotional_004', query: 'What am I worried about?', user: 'alice', category: 'emotional' },
  { id: 'emotional_005', query: 'Times I was frustrated', user: 'alice', category: 'emotional' },
  { id: 'emotional_006', query: 'My proudest moments', user: 'alice', category: 'emotional' },
  // Temporal
  { id: 'temporal_003', query: 'What happened with my daughter recently?', user: 'alice', category: 'temporal' },
  { id: 'temporal_004', query: 'What did I work on last week?', user: 'alice', category: 'temporal' },
  { id: 'temporal_007', query: 'What did I debug yesterday?', user: 'alice', category: 'temporal' },
  { id: 'temporal_008', query: 'What code editor do I use?', user: 'alice', category: 'temporal' },
  { id: 'temporal_011', query: 'How did I start coding?', user: 'alice', category: 'temporal' },
];

// ── Types ───────────────────────────────────────────────────────

interface ResultRow {
  memory_id: string;
  score: number;
}

interface QueryResult {
  queryId: string;
  query: string;
  category: string;
  float32: { ids: string[]; scores: number[]; latencyMs: number };
  halfvec: { ids: string[]; scores: number[]; latencyMs: number };
  topKMatch: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────

async function embedQuery(text: string): Promise<number[]> {
  const resp = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, model: EMBED_MODEL }),
  });
  if (!resp.ok) {
    throw new Error(`Embed failed (${resp.status}): ${await resp.text()}`);
  }
  const json = (await resp.json()) as {
    data: { embedding: number[] }[];
  };
  return json.data[0].embedding;
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

async function queryFloat32(
  prisma: PrismaClient,
  userId: string,
  queryVec: string,
): Promise<{ rows: ResultRow[]; latencyMs: number }> {
  const start = performance.now();
  const rows = await prisma.$queryRawUnsafe<ResultRow[]>(
    `SELECT me.memory_id, 1 - (me.embedding <=> $1::vector) as score
     FROM memory_embeddings me
     JOIN memories m ON me.memory_id = m.id
     WHERE m.user_id = $2 AND m.deleted_at IS NULL AND me.embedding IS NOT NULL
     ORDER BY me.embedding <=> $1::vector
     LIMIT $3`,
    queryVec,
    userId,
    TOP_K,
  );
  return { rows, latencyMs: performance.now() - start };
}

async function queryHalfvec(
  prisma: PrismaClient,
  userId: string,
  queryVec: string,
): Promise<{ rows: ResultRow[]; latencyMs: number }> {
  const start = performance.now();
  const rows = await prisma.$queryRawUnsafe<ResultRow[]>(
    `SELECT me.memory_id, 1 - (me.embedding_halfvec <=> $1::halfvec) as score
     FROM memory_embeddings me
     JOIN memories m ON me.memory_id = m.id
     WHERE m.user_id = $2 AND me.embedding_halfvec IS NOT NULL AND m.deleted_at IS NULL
     ORDER BY me.embedding_halfvec <=> $1::halfvec
     LIMIT $3`,
    queryVec,
    userId,
    TOP_K,
  );
  return { rows, latencyMs: performance.now() - start };
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const prisma = new PrismaClient();

  try {
    // Preflight: check pgvector version
    const [{ extversion }] = await prisma.$queryRaw<
      { extversion: string }[]
    >`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
    console.log(`pgvector version: ${extversion}`);

    const [major, minor] = extversion.split('.').map(Number);
    if (major === 0 && minor < 7) {
      console.error(`pgvector >= 0.7.0 required. Found ${extversion}`);
      writeUnsupportedReport(extversion);
      process.exit(0);
    }

    // Preflight: check halfvec column has data
    const [{ count: hvCount }] = await prisma.$queryRaw<
      { count: bigint }[]
    >`SELECT COUNT(*) as count FROM memory_embeddings WHERE embedding_halfvec IS NOT NULL`;
    const halfvecRows = Number(hvCount);
    console.log(`Rows with halfvec data: ${halfvecRows}`);

    if (halfvecRows === 0) {
      console.error('No halfvec data found. Run backfill-halfvec.ts first.');
      process.exit(1);
    }

    // Preflight: check embed service
    try {
      await embedQuery('test');
      console.log('Embed service: OK');
    } catch {
      console.error(
        `Cannot reach embed service at ${EMBED_URL}. Is it running?`,
      );
      process.exit(1);
    }

    // Resolve alice's user_id
    const aliceUser = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE external_id = 'alice' LIMIT 1
    `;
    if (aliceUser.length === 0) {
      console.error('User "alice" not found in database.');
      process.exit(1);
    }
    const aliceUserId = aliceUser[0].id;
    console.log(`Alice user_id: ${aliceUserId}`);

    // Run benchmark
    console.log(
      `\nBenchmarking ${ALICE_QUERIES.length} queries (top-${TOP_K})...\n`,
    );
    const results: QueryResult[] = [];

    for (const q of ALICE_QUERIES) {
      const embedding = await embedQuery(q.query);
      const vecLit = vectorLiteral(embedding);

      const f32 = await queryFloat32(prisma, aliceUserId, vecLit);
      const hv = await queryHalfvec(prisma, aliceUserId, vecLit);

      const f32Ids = f32.rows.map((r) => r.memory_id);
      const hvIds = hv.rows.map((r) => r.memory_id);
      const topKMatch =
        f32Ids.length === hvIds.length &&
        f32Ids.every((id, i) => id === hvIds[i]);

      results.push({
        queryId: q.id,
        query: q.query,
        category: q.category,
        float32: {
          ids: f32Ids,
          scores: f32.rows.map((r) => Number(r.score)),
          latencyMs: f32.latencyMs,
        },
        halfvec: {
          ids: hvIds,
          scores: hv.rows.map((r) => Number(r.score)),
          latencyMs: hv.latencyMs,
        },
        topKMatch,
      });

      const marker = topKMatch ? '✓' : '✗';
      console.log(
        `  ${marker} ${q.id}: f32=${f32.latencyMs.toFixed(1)}ms hv=${hv.latencyMs.toFixed(1)}ms`,
      );
    }

    // Storage estimate
    const [storageRow] = await prisma.$queryRaw<
      { f32_bytes: bigint; hv_bytes: bigint }[]
    >`
      SELECT
        pg_column_size(embedding) as f32_bytes,
        pg_column_size(embedding_halfvec) as hv_bytes
      FROM memory_embeddings
      WHERE embedding IS NOT NULL AND embedding_halfvec IS NOT NULL
      LIMIT 1
    `;
    const f32Bytes = Number(storageRow?.f32_bytes ?? 0);
    const hvBytes = Number(storageRow?.hv_bytes ?? 0);

    const [totalEmbeddings] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count FROM memory_embeddings WHERE embedding IS NOT NULL
    `;
    const totalRows = Number(totalEmbeddings.count);

    const f32TotalMB = ((f32Bytes * totalRows) / (1024 * 1024)).toFixed(2);
    const hvTotalMB = ((hvBytes * totalRows) / (1024 * 1024)).toFixed(2);
    const reductionPct =
      f32Bytes > 0 ? (((f32Bytes - hvBytes) / f32Bytes) * 100).toFixed(1) : '0';

    // Aggregate
    const matchCount = results.filter((r) => r.topKMatch).length;
    const matchRate = ((matchCount / results.length) * 100).toFixed(1);

    // Also calculate set-based P@5 (same IDs regardless of order)
    const setMatchCount = results.filter((r) => {
      const f32Set = new Set(r.float32.ids);
      return (
        r.halfvec.ids.length === r.float32.ids.length &&
        r.halfvec.ids.every((id) => f32Set.has(id))
      );
    }).length;
    const setMatchRate = ((setMatchCount / results.length) * 100).toFixed(1);

    const avgF32 =
      results.reduce((s, r) => s + r.float32.latencyMs, 0) / results.length;
    const avgHV =
      results.reduce((s, r) => s + r.halfvec.latencyMs, 0) / results.length;
    const latencyImprovement =
      avgHV > 0 ? (avgF32 / avgHV).toFixed(2) : 'N/A';

    const diffResults = results.filter((r) => !r.topKMatch);

    // Build report
    const report = buildReport({
      totalQueries: results.length,
      matchCount,
      matchRate,
      setMatchCount,
      setMatchRate,
      avgF32,
      avgHV,
      latencyImprovement,
      f32Bytes,
      hvBytes,
      f32TotalMB,
      hvTotalMB,
      reductionPct,
      totalRows,
      diffResults,
      pgvectorVersion: extversion,
    });

    // Print to console
    console.log('\n' + report);

    // Write to file
    const date = new Date().toISOString().split('T')[0];
    const reportDir = path.join(__dirname, '..', 'reports', 'halfvec-benchmark');
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `${date}.md`);
    fs.writeFileSync(reportPath, report);
    console.log(`\nReport written to: ${reportPath}`);
  } catch (err) {
    console.error('Benchmark failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// ── Report Builder ──────────────────────────────────────────────

interface ReportData {
  totalQueries: number;
  matchCount: number;
  matchRate: string;
  setMatchCount: number;
  setMatchRate: string;
  avgF32: number;
  avgHV: number;
  latencyImprovement: string;
  f32Bytes: number;
  hvBytes: number;
  f32TotalMB: string;
  hvTotalMB: string;
  reductionPct: string;
  totalRows: number;
  diffResults: QueryResult[];
  pgvectorVersion: string;
}

function buildReport(d: ReportData): string {
  let report = `# halfvec(768) vs vector(768) Benchmark

> Generated: ${new Date().toISOString()}
> pgvector: ${d.pgvectorVersion}

## Summary

| Metric | Value |
|--------|-------|
| Queries tested | ${d.totalQueries} |
| P@5 exact match (same order) | ${d.matchRate}% (${d.matchCount}/${d.totalQueries}) |
| P@5 set match (same IDs, any order) | ${d.setMatchRate}% (${d.setMatchCount}/${d.totalQueries}) |
| Avg latency float32 | ${d.avgF32.toFixed(2)}ms |
| Avg latency halfvec | ${d.avgHV.toFixed(2)}ms |
| Latency ratio (f32/hv) | ${d.latencyImprovement}x |
| Per-row storage float32 | ${d.f32Bytes} bytes |
| Per-row storage halfvec | ${d.hvBytes} bytes |
| Total storage float32 | ${d.f32TotalMB} MB (${d.totalRows} rows) |
| Total storage halfvec | ${d.hvTotalMB} MB (${d.totalRows} rows) |
| Storage reduction | ${d.reductionPct}% |

## Per-query differences

`;

  if (d.diffResults.length === 0) {
    report += '_No differences — all queries returned identical top-5 results._\n';
  } else {
    for (const r of d.diffResults) {
      report += `### ${r.queryId}: "${r.query}" (${r.category})\n\n`;
      report += `| Rank | float32 (score) | halfvec (score) | Match |\n`;
      report += `|------|-----------------|-----------------|-------|\n`;
      for (let i = 0; i < TOP_K; i++) {
        const f32Id = r.float32.ids[i] ?? '-';
        const hvId = r.halfvec.ids[i] ?? '-';
        const f32Score = r.float32.scores[i]?.toFixed(4) ?? '-';
        const hvScore = r.halfvec.scores[i]?.toFixed(4) ?? '-';
        const match = f32Id === hvId ? 'Y' : '**N**';
        report += `| ${i + 1} | ${f32Id} (${f32Score}) | ${hvId} (${hvScore}) | ${match} |\n`;
      }
      report += '\n';
    }
  }

  report += `## Conclusion

${
  Number(d.matchRate) >= 95
    ? 'halfvec(768) shows negligible recall quality loss compared to float32. Migration is recommended for storage savings.'
    : Number(d.matchRate) >= 80
      ? 'halfvec(768) shows minor recall differences. Review the per-query differences above to assess impact.'
      : 'halfvec(768) shows significant recall quality loss. Further investigation recommended before migrating.'
}
`;

  return report;
}

function writeUnsupportedReport(version: string) {
  const date = new Date().toISOString().split('T')[0];
  const reportDir = path.join(__dirname, '..', 'reports', 'halfvec-benchmark');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${date}.md`);
  const content = `# halfvec(768) vs vector(768) Benchmark

> Generated: ${new Date().toISOString()}

## SKIPPED

pgvector version ${version} does not support halfvec (requires >= 0.7.0).
Upgrade pgvector and re-run this benchmark.
`;
  fs.writeFileSync(reportPath, content);
  console.log(`Report written to: ${reportPath}`);
}

main();
