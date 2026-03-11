/**
 * Benchmark Harness — Precompute
 *
 * Standalone script that:
 * 1. Connects to the local DB (DATABASE_URL from .env or environment)
 * 2. Fetches all benchmark corpus memories for users alice, bob, carol, dave, eve
 *    (identified by RLS_CANARY_* prefix in content)
 * 3. Fetches their embeddings from memory_embeddings table (model_id = bge-base-en-v1.5)
 * 4. Embeds all 81 gold query strings by calling the local TEI embed server
 * 5. Serializes to corpus.json, queries.json, and cosine-scores.json
 *
 * Run: pnpm benchmark:precompute
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Client } from 'pg';
import { GOLD_QUERIES } from '../../fixtures/queries/gold-queries';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const HARNESS_DIR = __dirname;
const EMBED_URL = process.env.TEI_EMBED_URL ?? 'http://localhost:8080';
const MODEL_ID = process.env.EMBED_MODEL_ID ?? 'bge-base-en-v1.5';

// Canary prefixes that identify benchmark corpus memories
const CANARY_PREFIXES = [
  'RLS_CANARY_ALICE_',
  'RLS_CANARY_BOB_',
  'RLS_CANARY_CAROL_',
  'RLS_CANARY_DAVE_',
  'RLS_CANARY_EVE_',
];

export interface CorpusMemory {
  id: string;
  userId: string;
  raw: string;
  layer: string;
  importanceScore: number;
  createdAt: string;
  embedding: number[];
}

export interface QueryEntry {
  id: string;
  query: string;
  user: string;
  must_top5: string[];
  should_top20: string[];
  must_absent: string[];
  category: string;
  embedding: number[];
}

export interface CosineScores {
  /** queryId → { memoryId → cosineScore } */
  [queryId: string]: { [memoryId: string]: number };
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const BATCH = 64;
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await fetch(`${EMBED_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: batch }),
    });
    if (!res.ok) {
      throw new Error(`TEI embed failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as number[][];
    all.push(...data);
    process.stdout.write(`  Embedded ${Math.min(i + BATCH, texts.length)}/${texts.length}\r`);
  }
  console.log();
  return all;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  console.log('Connecting to DB...');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // Build WHERE clause for canary prefixes
    const likeConditions = CANARY_PREFIXES.map(
      (_, i) => `m.raw LIKE $${i + 1}`,
    ).join(' OR ');
    const likeParams = CANARY_PREFIXES.map((p) => `${p}%`);

    console.log('Fetching corpus memories...');
    const memoryResult = await client.query<{
      id: string;
      user_id: string;
      raw: string;
      layer: string;
      importance_score: number;
      created_at: Date;
    }>(
      `SELECT m.id, m.user_id, m.raw, m.layer, m.importance_score, m.created_at
       FROM memories m
       WHERE (${likeConditions})
         AND m.deleted_at IS NULL
       ORDER BY m.user_id, m.id`,
      likeParams,
    );

    console.log(`Found ${memoryResult.rows.length} corpus memories`);

    // Fetch embeddings
    const memoryIds = memoryResult.rows.map((r) => r.id);
    if (memoryIds.length === 0) {
      throw new Error(
        'No corpus memories found. Have you run the benchmark seed first?',
      );
    }

    console.log(`Fetching embeddings (model: ${MODEL_ID})...`);
    const placeholders = memoryIds.map((_, i) => `$${i + 2}`).join(', ');
    const embResult = await client.query<{
      memory_id: string;
      embedding: string;
    }>(
      `SELECT me.memory_id, me.embedding::text
       FROM memory_embeddings me
       WHERE me.model_id = $1
         AND me.memory_id IN (${placeholders})`,
      [MODEL_ID, ...memoryIds],
    );

    console.log(`Found ${embResult.rows.length} embeddings`);

    const embMap = new Map<string, number[]>();
    for (const row of embResult.rows) {
      // Parse pgvector format: [0.1,0.2,...] or {0.1,0.2,...}
      const str = row.embedding.replace(/[{}[\]]/g, '');
      embMap.set(row.memory_id, str.split(',').map(Number));
    }

    // Build corpus entries (only memories with embeddings)
    const corpus: CorpusMemory[] = [];
    for (const row of memoryResult.rows) {
      const embedding = embMap.get(row.id);
      if (!embedding) {
        console.warn(`  Skipping ${row.id} — no embedding found`);
        continue;
      }
      corpus.push({
        id: row.id,
        userId: row.user_id,
        raw: row.raw,
        layer: row.layer,
        importanceScore: row.importance_score,
        createdAt: row.created_at.toISOString(),
        embedding,
      });
    }

    console.log(`Corpus: ${corpus.length} memories with embeddings`);

    // Embed all gold queries
    console.log(`Embedding ${GOLD_QUERIES.length} gold queries...`);
    const queryTexts = GOLD_QUERIES.map((q) => q.query || ' ');
    const queryEmbeddings = await embedTexts(queryTexts);

    const queries: QueryEntry[] = GOLD_QUERIES.map((q, i) => ({
      id: q.id,
      query: q.query,
      user: q.user,
      must_top5: q.must_top5,
      should_top20: q.should_top20 ?? [],
      must_absent: q.must_absent,
      category: q.category,
      embedding: queryEmbeddings[i],
    }));

    // Precompute cosine similarities (query × user's memories)
    console.log('Precomputing cosine similarities...');
    const cosineScores: CosineScores = {};

    // Build user → memories map
    const userMemories = new Map<string, CorpusMemory[]>();
    for (const mem of corpus) {
      const list = userMemories.get(mem.userId) ?? [];
      list.push(mem);
      userMemories.set(mem.userId, list);
    }

    // Build a mapping: fixture canary user name → internal userId
    // We detect user by canary prefix in the raw content
    const canaryToUser = new Map<string, string>();
    for (const [userId, mems] of userMemories) {
      for (const mem of mems) {
        for (const prefix of CANARY_PREFIXES) {
          if (mem.raw.startsWith(prefix)) {
            const userName = prefix.replace('RLS_CANARY_', '').replace('_', '').toLowerCase();
            canaryToUser.set(userName, userId);
            break;
          }
        }
      }
    }

    // Also build a direct fixture_id → memory map for verification
    // fixture_id is the memory's actual DB id
    const memById = new Map<string, CorpusMemory>(corpus.map((m) => [m.id, m]));

    // For each query, compute cosine scores against the matching user's memories
    for (const q of queries) {
      const userId = canaryToUser.get(q.user);
      if (!userId) {
        console.warn(`  No userId found for user '${q.user}' — skipping query ${q.id}`);
        cosineScores[q.id] = {};
        continue;
      }

      const userMems = userMemories.get(userId) ?? [];
      const scores: { [memoryId: string]: number } = {};

      if (q.embedding.length > 0 && q.query.trim() !== '') {
        for (const mem of userMems) {
          scores[mem.id] = cosineSim(q.embedding, mem.embedding);
        }
      }

      cosineScores[q.id] = scores;
    }

    // Write output files
    const corpusPath = path.join(HARNESS_DIR, 'corpus.json');
    const queriesPath = path.join(HARNESS_DIR, 'queries.json');
    const cosinesPath = path.join(HARNESS_DIR, 'cosine-scores.json');

    fs.writeFileSync(corpusPath, JSON.stringify(corpus, null, 2));
    fs.writeFileSync(queriesPath, JSON.stringify(queries, null, 2));
    fs.writeFileSync(cosinesPath, JSON.stringify(cosineScores, null, 2));

    console.log(`\nWrote:`);
    console.log(`  ${corpusPath} (${corpus.length} memories)`);
    console.log(`  ${queriesPath} (${queries.length} queries)`);
    console.log(`  ${cosinesPath} (${Object.keys(cosineScores).length} query entries)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Precompute failed:', err);
  process.exit(1);
});
