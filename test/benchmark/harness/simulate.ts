/**
 * Benchmark Harness — Offline Simulator
 *
 * Pure TypeScript offline scorer. No DB required.
 * Loads precomputed corpus.json, queries.json, cosine-scores.json
 * and evaluates recall accuracy.
 *
 * Run: pnpm benchmark:sim
 */

import * as fs from 'fs';
import * as path from 'path';
import { GOLD_QUERIES } from '../../fixtures/queries/gold-queries';
import {
  scoreQuery,
  buildReport,
  formatReport,
  checkThresholds,
} from '../scoring';
import type { QueryScore } from '../scoring';

const HARNESS_DIR = __dirname;

// ── Types ────────────────────────────────────────────────────────

interface CorpusMemory {
  id: string;
  userId: string;
  raw: string;
  layer: string;
  importanceScore: number;
  createdAt: string;
  embedding: number[];
}

interface QueryEntry {
  id: string;
  query: string;
  user: string;
  must_top5: string[];
  should_top20: string[];
  must_absent: string[];
  category: string;
  embedding: number[];
}

type CosineScores = { [queryId: string]: { [memoryId: string]: number } };

export interface ScoringConfig {
  /** Number of candidates passed to post-blend (pre-reranker top-K) */
  preRerankK: number;
  /** Weight on cosine score in final blend (when no reranker) */
  cosineWeight: number;
  /** Weight on importance score in final blend */
  importanceFinalWeight: number;
  /** If reranker scores are present, use them with this weight */
  rerankerWeight?: number;
}

// ── Pure functions ───────────────────────────────────────────────

export function cosineSim(a: number[], b: number[]): number {
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

/**
 * Run a scoring config against all gold queries.
 * Returns top-5 memory IDs for each query.
 */
export function runScoringConfig(
  config: ScoringConfig,
  queries: QueryEntry[],
  corpus: CorpusMemory[],
  cosineScores: CosineScores,
  rerankerScores?: { [queryId: string]: { [memoryId: string]: number } },
): Map<string, string[]> {
  const memById = new Map<string, CorpusMemory>(corpus.map((m) => [m.id, m]));

  // Build userId → memories lookup (by canary prefix)
  const userNameToMemories = new Map<string, CorpusMemory[]>();
  for (const mem of corpus) {
    // Detect user name from canary prefix in raw content
    const match = mem.raw.match(/^RLS_CANARY_([A-Z]+)_/i);
    if (match) {
      const userName = match[1].toLowerCase();
      const list = userNameToMemories.get(userName) ?? [];
      list.push(mem);
      userNameToMemories.set(userName, list);
    }
  }

  const results = new Map<string, string[]>();

  for (const q of queries) {
    if (!q.query || q.query.trim() === '') {
      results.set(q.id, []);
      continue;
    }

    const userMems = userNameToMemories.get(q.user) ?? [];
    if (userMems.length === 0) {
      results.set(q.id, []);
      continue;
    }

    const qCosines = cosineScores[q.id] ?? {};
    const qReranker = rerankerScores?.[q.id];

    // Step 1: Pre-filter — pure cosine only (no importance in pre-filter)
    const withCosine = userMems
      .map((mem) => ({
        mem,
        cosine: qCosines[mem.id] ?? 0,
      }))
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, config.preRerankK);

    // Step 2: Final blend
    const finalScored = withCosine.map(({ mem, cosine }) => {
      const importance = mem.importanceScore ?? 0.5;
      let score: number;

      if (qReranker && qReranker[mem.id] != null) {
        // Reranker scores present: rerankerScore * rerankerWeight + importanceScore * importanceFinalWeight
        const rw = config.rerankerWeight ?? 0.85;
        const iw = config.importanceFinalWeight;
        score = qReranker[mem.id] * rw + importance * iw;
      } else {
        // No reranker: cosine * cosineWeight + importanceScore * importanceFinalWeight
        score = cosine * config.cosineWeight + importance * config.importanceFinalWeight;
      }

      return { id: mem.id, score };
    });

    const top5 = finalScored
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((r) => r.id);

    results.set(q.id, top5);
  }

  return results;
}

// ── Main ─────────────────────────────────────────────────────────

function loadJson<T>(filename: string): T {
  const filePath = path.join(HARNESS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing file: ${filePath}\nRun: pnpm benchmark:precompute first`,
    );
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function main() {
  console.log('Loading precomputed data...');
  const corpus = loadJson<CorpusMemory[]>('corpus.json');
  const queries = loadJson<QueryEntry[]>('queries.json');
  const cosineScores = loadJson<CosineScores>('cosine-scores.json');

  console.log(
    `  corpus: ${corpus.length} memories, queries: ${queries.length}, cosine entries: ${Object.keys(cosineScores).length}`,
  );

  // Default config: pure cosine pre-filter top-120, final blend cosine*0.85 + importance*0.15
  const config: ScoringConfig = {
    preRerankK: 120,
    cosineWeight: 0.85,
    importanceFinalWeight: 0.15,
  };

  console.log('\nRunning scoring config:', config);

  const resultMap = runScoringConfig(config, queries, corpus, cosineScores);

  // Score against gold queries
  const allScores: QueryScore[] = [];
  for (const goldQuery of GOLD_QUERIES) {
    const topIds = resultMap.get(goldQuery.id) ?? [];
    // Expand to top-20 for recall@20 (use all candidates sorted)
    const qCosines = cosineScores[goldQuery.id] ?? {};
    const userMems = corpus.filter((m) => {
      const match = m.raw.match(/^RLS_CANARY_([A-Z]+)_/i);
      return match && match[1].toLowerCase() === goldQuery.user;
    });

    // For recall@20 we need full top-20
    const top20 = userMems
      .map((m) => ({ id: m.id, cosine: qCosines[m.id] ?? 0, importance: m.importanceScore }))
      .sort((a, b) => {
        const sa = a.cosine * config.cosineWeight + a.importance * config.importanceFinalWeight;
        const sb = b.cosine * config.cosineWeight + b.importance * config.importanceFinalWeight;
        return sb - sa;
      })
      .slice(0, 20)
      .map((r) => r.id);

    const score = scoreQuery(goldQuery, top20);
    // Override actualIds to use top5 from resultMap for precision@5
    const adjustedScore = {
      ...score,
      precisionAt5: (() => {
        const top5Hits = goldQuery.must_top5.filter((id) => topIds.includes(id));
        return goldQuery.must_top5.length > 0
          ? top5Hits.length / goldQuery.must_top5.length
          : 1.0;
      })(),
      details: {
        ...score.details,
        top5Hits: goldQuery.must_top5.filter((id) => topIds.includes(id)),
        actualIds: [...topIds, ...top20.filter((id) => !topIds.includes(id))].slice(0, 20),
      },
    };

    // Recalculate passed with corrected precisionAt5
    const passed =
      adjustedScore.isolationPassed &&
      (goldQuery.must_top5.length === 0 || adjustedScore.details.top5Hits.length > 0);

    allScores.push({ ...adjustedScore, passed });
  }

  const report = buildReport(allScores, 'offline', 'harness');
  console.log(formatReport(report));

  // Summary
  const passed = checkThresholds(allScores);
  if (passed) {
    console.log('✅ All thresholds passed');
    process.exit(0);
  } else {
    console.log('❌ Thresholds NOT met');
    process.exit(1);
  }
}

main();
