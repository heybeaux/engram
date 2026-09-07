/**
 * Benchmark Harness — Parameter Sweep
 *
 * Grid searches over scoring config parameters and prints all passing configs.
 * Thresholds: Required coverage@5 >= 0.95; shared benchmark gates
 *
 * Run: pnpm benchmark:sweep
 */

import * as fs from 'fs';
import * as path from 'path';
import { GOLD_QUERIES } from '../../fixtures/queries/gold-queries';
import { scoreQuery, buildReport, checkThresholds } from '../scoring';
import type { QueryScore } from '../scoring';
import { runScoringConfig, cosineSim } from './simulate';
import type { ScoringConfig } from './simulate';

const HARNESS_DIR = __dirname;

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

function loadJson<T>(filename: string): T {
  const filePath = path.join(HARNESS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing file: ${filePath}\nRun: pnpm benchmark:precompute first`,
    );
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

interface SweepResult {
  config: ScoringConfig;
  requiredCoverageAt5: number;
  zeroHits: number;
  isolationScore: number;
  passed: boolean;
}

function evaluateConfig(
  config: ScoringConfig,
  queries: QueryEntry[],
  corpus: CorpusMemory[],
  cosineScores: CosineScores,
): SweepResult {
  const resultMap = runScoringConfig(config, queries, corpus, cosineScores);

  const allScores: QueryScore[] = [];

  for (const goldQuery of GOLD_QUERIES) {
    const topIds = resultMap.get(goldQuery.id) ?? [];

    // Compute top-20 for recall@20
    const qCosines = cosineScores[goldQuery.id] ?? {};
    const userMems = corpus.filter((m) => {
      const match = m.raw.match(/^RLS_CANARY_([A-Z]+)_/i);
      return match && match[1].toLowerCase() === goldQuery.user;
    });

    const top20 = userMems
      .map((m) => ({
        id: m.id,
        score:
          (qCosines[m.id] ?? 0) * config.cosineWeight +
          m.importanceScore * config.importanceFinalWeight,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((r) => r.id);

    allScores.push(
      scoreQuery(
        goldQuery,
        [...topIds, ...top20.filter((id) => !topIds.includes(id))].slice(0, 20),
      ),
    );
  }

  const avg = (vals: (number | null)[]) => {
    const labelled = vals.filter((v): v is number => v !== null);
    return labelled.length
      ? labelled.reduce((s, v) => s + v, 0) / labelled.length
      : 0;
  };

  const requiredCoverageAt5 = avg(allScores.map((s) => s.requiredCoverageAt5));
  const zeroHits = allScores.filter(
    (s) => s.details.expectedTop5.length > 0 && s.details.top5Hits.length === 0,
  ).length;
  const isolationScore =
    allScores.filter((s) => s.isolationPassed).length / allScores.length;

  const passed = checkThresholds(allScores);

  return { config, requiredCoverageAt5, zeroHits, isolationScore, passed };
}

function main() {
  console.log('Loading precomputed data...');
  const corpus = loadJson<CorpusMemory[]>('corpus.json');
  const queries = loadJson<QueryEntry[]>('queries.json');
  const cosineScores = loadJson<CosineScores>('cosine-scores.json');

  console.log(
    `  corpus: ${corpus.length} memories, queries: ${queries.length}`,
  );

  // Grid search parameters
  const cosineWeights = [0.7, 0.8, 0.9, 1.0];
  const preRerankKs = [40, 80, 120, 160];
  const importanceFinalWeights = [0.0, 0.1, 0.15, 0.2];

  const totalConfigs =
    cosineWeights.length * preRerankKs.length * importanceFinalWeights.length;
  console.log(`\nSweeping ${totalConfigs} configurations...`);

  const allResults: SweepResult[] = [];
  let count = 0;

  for (const cosineWeight of cosineWeights) {
    for (const preRerankK of preRerankKs) {
      for (const importanceFinalWeight of importanceFinalWeights) {
        const config: ScoringConfig = {
          cosineWeight,
          preRerankK,
          importanceFinalWeight,
        };

        const result = evaluateConfig(config, queries, corpus, cosineScores);
        allResults.push(result);
        count++;

        if (count % 10 === 0) {
          process.stdout.write(
            `  ${count}/${totalConfigs} configs evaluated\r`,
          );
        }
      }
    }
  }

  console.log(`\n  ${count}/${totalConfigs} configs evaluated`);

  // Filter passing configs
  const passing = allResults
    .filter((r) => r.passed)
    .sort((a, b) => b.requiredCoverageAt5 - a.requiredCoverageAt5);

  console.log(
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  );
  console.log(
    `SWEEP RESULTS — ${passing.length}/${totalConfigs} configs pass all thresholds`,
  );
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (passing.length === 0) {
    console.log('\nNo configs passed all thresholds.');
    console.log('\nTop 5 by Coverage@5:');
    allResults
      .sort((a, b) => b.requiredCoverageAt5 - a.requiredCoverageAt5)
      .slice(0, 5)
      .forEach((r, i) => {
        console.log(
          `  ${i + 1}. Coverage@5=${(r.requiredCoverageAt5 * 100).toFixed(1)}%  zero-hits=${r.zeroHits}  isolation=${(r.isolationScore * 100).toFixed(0)}%  config=${JSON.stringify(r.config)}`,
        );
      });
  } else {
    console.log(
      `\n${'Rank'.padEnd(5)} ${'Coverage@5'.padEnd(8)} ${'Zero-hits'.padEnd(10)} ${'Isolation'.padEnd(10)} Config`,
    );
    console.log('─'.repeat(80));
    passing.forEach((r, i) => {
      console.log(
        `  ${String(i + 1).padEnd(4)} ${(r.requiredCoverageAt5 * 100).toFixed(1).padEnd(8)}% ${String(r.zeroHits).padEnd(10)} ${(r.isolationScore * 100).toFixed(0).padEnd(10)}%  cW=${r.config.cosineWeight} K=${r.config.preRerankK} iW=${r.config.importanceFinalWeight}`,
      );
    });

    console.log(`\n🏆 Best config:`);
    const best = passing[0];
    console.log(`   cosineWeight:         ${best.config.cosineWeight}`);
    console.log(`   preRerankK:           ${best.config.preRerankK}`);
    console.log(
      `   importanceFinalWeight: ${best.config.importanceFinalWeight}`,
    );
    console.log(
      `   Coverage@5:                  ${(best.requiredCoverageAt5 * 100).toFixed(1)}%`,
    );
  }

  console.log();
}

main();
