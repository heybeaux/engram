#!/usr/bin/env ts-node
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import request from 'supertest';
import { createTestApp } from '../../test/helpers/create-test-app.js';
import { seedCorpus, type SeededUser } from '../../test/helpers/seed-corpus.js';
import { generateCorpusEmbeddings } from '../../test/helpers/generate-embeddings.js';
import { asUser } from '../../test/helpers/auth-helpers.js';
import { ALL_USERS, GOLD_QUERIES } from '../../test/fixtures/index.js';
import type { GoldQuery } from '../../test/fixtures/types.js';
import { EmbeddingService as EmbeddingGeneratorService } from '../../src/embedding/embedding.service.js';

const OUT = process.env.DIVERSITY_GATE_OUT;
if (!OUT) throw new Error('DIVERSITY_GATE_OUT is required');
const OUTPUT_PATH: string = OUT;

const FINAL_LIMIT = 10;
const SNAPSHOT = 'zz_diversity_gate_usage_snapshot_20260823';

type AppContext = Awaited<ReturnType<typeof createTestApp>>;

interface QueryRun {
  queryId: string;
  category: string;
  expected: string[];
  forbidden: string[];
  resultIds: string[];
  latencyMs: number;
  pageSize: number;
  top5Hits: string[];
  relevantAt10: string[];
  forbiddenHits: string[];
  mrr: number;
}

interface ArmResult {
  label: string;
  summary: ReturnType<typeof summarize>;
  stabilityChangedQueries: string[];
  queries: QueryRun[];
  repeatedResultIds: Record<string, string[]>;
}

function configureArm(diversity: boolean): void {
  process.env.RECALL_RERANK_SCALE_FIX = 'true';
  process.env.RECALL_LEXICAL_COVERAGE_FLOOR = 'true';
  process.env.RECALL_RESCUE_SQL_TIEBREAK = 'true';
  if (diversity) {
    process.env.RECALL_CANDIDATE_POOL_DEPTH = '12';
    process.env.RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT = '2';
  } else {
    delete process.env.RECALL_CANDIDATE_POOL_DEPTH;
    delete process.env.RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT;
  }
}

async function resetUsage(ctx: AppContext): Promise<void> {
  await ctx.prisma.$executeRawUnsafe(`
    UPDATE memories m
       SET retrieval_count = s.retrieval_count,
           used_count = s.used_count,
           unused_count = s.unused_count,
           last_retrieved_at = s.last_retrieved_at,
           last_used_at = s.last_used_at
      FROM ${SNAPSHOT} s
     WHERE m.id = s.id
  `);
}

async function restoreDeclaredFixtureFields(
  ctx: AppContext,
  corpus: Awaited<ReturnType<typeof seedCorpus>>,
): Promise<{ memoriesChecked: number; taggedMemories: number }> {
  const expected = new Map(
    ALL_USERS.flatMap((user) =>
      user.memories.map((memory) => [memory.fixture_id, memory] as const),
    ),
  );

  // Issue #326: seedCorpus currently omits tags, metadata, and memoryType.
  // Restore every declared retrieval field before this gate so the benchmark
  // measures production behavior rather than a silently degraded fixture.
  for (const memory of expected.values()) {
    await ctx.prisma.$executeRawUnsafe(
      `UPDATE memories
          SET tags = $1::text[],
              metadata = $2::jsonb,
              memory_type = $3::"MemoryType"
        WHERE id = $4`,
      memory.tags,
      JSON.stringify(memory.metadata ?? null),
      memory.memoryType ?? null,
      memory.fixture_id,
    );
  }

  const rows = await ctx.prisma.memory.findMany({
    where: { userId: { in: corpus.seededUsers.map((user) => user.userId) } },
    select: { id: true, tags: true, metadata: true, memoryType: true },
  });
  if (rows.length !== expected.size) {
    throw new Error(
      `fixture integrity: expected ${expected.size} memories, found ${rows.length}`,
    );
  }
  for (const row of rows) {
    const fixture = expected.get(row.id);
    if (!fixture) throw new Error(`unexpected fixture memory ${row.id}`);
    if (JSON.stringify(row.tags) !== JSON.stringify(fixture.tags)) {
      throw new Error(`fixture tag mismatch for ${row.id}`);
    }
    if ((row.memoryType ?? null) !== (fixture.memoryType ?? null)) {
      throw new Error(`fixture memoryType mismatch for ${row.id}`);
    }
    if (
      JSON.stringify(row.metadata ?? null) !==
      JSON.stringify(fixture.metadata ?? null)
    ) {
      throw new Error(`fixture metadata mismatch for ${row.id}`);
    }
  }
  return {
    memoriesChecked: rows.length,
    taggedMemories: rows.filter((row) => row.tags.length > 0).length,
  };
}

async function execute(
  ctx: AppContext,
  users: Map<string, SeededUser>,
  query: GoldQuery,
): Promise<QueryRun> {
  if (!query.query.trim()) {
    return score(query, [], 0);
  }
  const user = users.get(query.user);
  if (!user) throw new Error(`unknown fixture user: ${query.user}`);
  await resetUsage(ctx);
  const response = await request(ctx.app.getHttpServer())
    .post('/v1/memories/query')
    .set(asUser(user.apiKey, user.userId))
    .send({ query: query.query, limit: FINAL_LIMIT });
  if (![200, 201, 400].includes(response.status)) {
    throw new Error(
      `${query.id}: status=${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  const memories =
    response.status === 400 ? [] : (response.body.memories ?? []);
  return score(
    query,
    memories.map((memory: { id: string }) => memory.id),
    Number(response.body.latencyMs ?? 0),
  );
}

function score(query: GoldQuery, ids: string[], latencyMs: number): QueryRun {
  const expected = [...query.must_top5, ...(query.should_top20 ?? [])];
  const top5Hits = query.must_top5.filter((id) => ids.slice(0, 5).includes(id));
  const relevantAt10 = expected.filter((id) => ids.includes(id));
  const forbiddenHits = query.must_absent.filter((id) => ids.includes(id));
  const reciprocalRanks = query.must_top5.map((id) => {
    const index = ids.indexOf(id);
    return index >= 0 ? 1 / (index + 1) : 0;
  });
  return {
    queryId: query.id,
    category: query.category,
    expected,
    forbidden: query.must_absent,
    resultIds: ids,
    latencyMs,
    pageSize: ids.length,
    top5Hits,
    relevantAt10,
    forbiddenHits,
    mrr:
      reciprocalRanks.length > 0
        ? reciprocalRanks.reduce((sum, value) => sum + value, 0) /
          reciprocalRanks.length
        : 1,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function summarize(queries: QueryRun[]) {
  const mustTop5Count = GOLD_QUERIES.reduce(
    (sum, query) => sum + query.must_top5.length,
    0,
  );
  const top5HitCount = queries.reduce(
    (sum, query) => sum + query.top5Hits.length,
    0,
  );
  const expectedCount = queries.reduce(
    (sum, query) => sum + query.expected.length,
    0,
  );
  const relevantAt10Count = queries.reduce(
    (sum, query) => sum + query.relevantAt10.length,
    0,
  );
  const forbiddenCount = queries.reduce(
    (sum, query) => sum + query.forbidden.length,
    0,
  );
  const forbiddenHitCount = queries.reduce(
    (sum, query) => sum + query.forbiddenHits.length,
    0,
  );
  const latencies = queries
    .filter((query) => query.latencyMs > 0)
    .map((query) => query.latencyMs);
  const nonEmpty = queries.filter((query) => query.queryId !== 'edge_006');
  return {
    queryCount: queries.length,
    precisionAt5: mustTop5Count > 0 ? top5HitCount / mustTop5Count : 1,
    recallAt10: expectedCount > 0 ? relevantAt10Count / expectedCount : 1,
    mrrAt10:
      queries.reduce((sum, query) => sum + query.mrr, 0) / queries.length,
    falsePositiveInjectionRate:
      forbiddenCount > 0 ? forbiddenHitCount / forbiddenCount : 0,
    queriesWithFalsePositiveInjection: queries.filter(
      (query) => query.forbiddenHits.length > 0,
    ).length,
    fullPageRate:
      nonEmpty.filter((query) => query.pageSize === FINAL_LIMIT).length /
      nonEmpty.length,
    minPageSize: Math.min(...nonEmpty.map((query) => query.pageSize)),
    meanPageSize:
      nonEmpty.reduce((sum, query) => sum + query.pageSize, 0) /
      nonEmpty.length,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    latencyMeanMs:
      latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    _counts: {
      mustTop5Count,
      top5HitCount,
      expectedCount,
      relevantAt10Count,
      forbiddenCount,
      forbiddenHitCount,
    },
  };
}

async function runArm(
  label: string,
  ctx: AppContext,
  users: Map<string, SeededUser>,
): Promise<ArmResult> {
  const first: QueryRun[] = [];
  const repeatedResultIds: Record<string, string[]> = {};
  const stabilityChangedQueries: string[] = [];
  for (const query of GOLD_QUERIES) {
    const primary = await execute(ctx, users, query);
    const repeat = await execute(ctx, users, query);
    first.push(primary);
    repeatedResultIds[query.id] = repeat.resultIds;
    if (primary.resultIds.join(',') !== repeat.resultIds.join(',')) {
      stabilityChangedQueries.push(query.id);
    }
    process.stdout.write('.');
  }
  process.stdout.write(` ${label}\n`);
  return {
    label,
    summary: summarize(first),
    stabilityChangedQueries,
    queries: first,
    repeatedResultIds,
  };
}

function compare(off: ArmResult, on: ArmResult) {
  const offById = new Map(off.queries.map((query) => [query.queryId, query]));
  const gains: string[] = [];
  const losses: string[] = [];
  const rankingChanges: string[] = [];
  for (const query of on.queries) {
    const before = offById.get(query.queryId)!;
    if (query.top5Hits.length > before.top5Hits.length)
      gains.push(query.queryId);
    if (query.top5Hits.length < before.top5Hits.length)
      losses.push(query.queryId);
    if (query.resultIds.join(',') !== before.resultIds.join(',')) {
      rankingChanges.push(query.queryId);
    }
  }
  return { top5Gains: gains, top5Losses: losses, rankingChanges };
}

async function main(): Promise<void> {
  configureArm(false);
  const offContext = await createTestApp(false);
  const corpus = await seedCorpus(offContext.prisma);
  const fixtureIntegrity = await restoreDeclaredFixtureFields(
    offContext,
    corpus,
  );
  await offContext.prisma.account.updateMany({
    where: { id: { in: corpus.seededUsers.map((user) => user.accountId) } },
    data: { plan: 'SCALE' },
  });
  const users = new Map(corpus.seededUsers.map((user) => [user.name, user]));
  const generator = offContext.app.get(EmbeddingGeneratorService);
  await generateCorpusEmbeddings(offContext.prisma, generator, corpus);
  await offContext.prisma.$executeRawUnsafe(
    `
    CREATE TABLE ${SNAPSHOT} AS
    SELECT id, retrieval_count, used_count, unused_count,
           last_retrieved_at, last_used_at
      FROM memories
     WHERE user_id IN (${corpus.seededUsers.map((_, i) => `$${i + 1}`).join(',')})
  `,
    ...corpus.seededUsers.map((user) => user.userId),
  );
  const off = await runArm('diversity-off', offContext, users);
  await offContext.app.close();

  configureArm(true);
  const onContext = await createTestApp(false);
  const on = await runArm('diversity-on', onContext, users);
  const comparison = compare(off, on);
  const artifact = {
    generatedAt: new Date().toISOString(),
    config: {
      finalLimit: FINAL_LIMIT,
      baseFlags: {
        RECALL_RERANK_SCALE_FIX: true,
        RECALL_LEXICAL_COVERAGE_FLOOR: true,
        RECALL_RESCUE_SQL_TIEBREAK: true,
      },
      diversityOff: {},
      diversityOn: {
        RECALL_CANDIDATE_POOL_DEPTH: 12,
        RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT: 2,
        jaccardThreshold: 0.9,
      },
      snapshotIsolation: 'usage restored before every query and repeat',
      fixtureIntegrity,
      embeddingModel: generator.getModelName(),
      embeddingDimensions: generator.getDimensions(),
    },
    off,
    on,
    comparison,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(artifact, null, 2));
  await onContext.prisma.$executeRawUnsafe(`DROP TABLE ${SNAPSHOT}`);
  await corpus.cleanup();
  await onContext.app.close();
  console.log(
    JSON.stringify({ off: off.summary, on: on.summary, comparison }, null, 2),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
