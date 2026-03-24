/**
 * Autoresearch Sweep — Durability-Aware Parameter Optimization
 *
 * Extends the standard benchmark sweep with durability multipliers to find
 * optimal scoring parameters that fix the 3 known failing queries (daily_gen
 * noise memories beating durable memories) without regressing overall P@5.
 *
 * The key problem: alice_daily_gen_* noise memories (importanceScore 0.3–0.5)
 * appear in top 5 for queries where durable memories (health, coffee, identity)
 * should win. Durability multipliers boost DURABLE and penalize EPHEMERAL.
 *
 * Run: npm run benchmark:autoresearch
 */

import * as fs from 'fs';
import * as path from 'path';
import { GOLD_QUERIES } from '../../fixtures/queries/gold-queries';
import { scoreQuery } from '../scoring';
import type { QueryScore } from '../scoring';
import type { ScoringConfig } from './simulate';

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

/** Extended config adding durability multipliers to the base ScoringConfig. */
export interface DurabilityAwareScoringConfig extends ScoringConfig {
  durableBoost: number;
  ephemeralPenalty: number;
}

/** Result for a single swept configuration. */
export interface AutoresearchResult {
  config: DurabilityAwareScoringConfig;
  overallPrecisionAt5: number;
  zeroHits: number;
  isolationScore: number;
  passed: boolean;
  /** P@5 specifically on the 3 known failing queries */
  focusPrecisionAt5: number;
  /** How many of the 3 focus queries have their must_top5 in the actual top 5 */
  focusHits: number;
  /** Per-query detail for the focus queries */
  focusDetails: Array<{
    queryId: string;
    hit: boolean;
    top5: string[];
    expected: string[];
  }>;
}

// ── Durability classifier (mirrors DurabilityClassifierService rules) ──

const PREFERENCE_PATTERNS = [
  /\bi prefer\b/i,
  /\bi like\b/i,
  /\bi love\b/i,
  /\bi hate\b/i,
  /\bi always\b/i,
  /\bi never\b/i,
  /\bmy favou?rite\b/i,
  /\bi enjoy\b/i,
];

const FACT_PATTERNS = [
  /\bmy name is\b/i,
  /\bi work at\b/i,
  /\bi live in\b/i,
  /\bmy daughter\b/i,
  /\bmy son\b/i,
  /\bmy wife\b/i,
  /\bmy husband\b/i,
  /\bmy partner\b/i,
  /\bmy dog\b/i,
  /\bi was born\b/i,
  /\bmy job\b/i,
  /\bmy goal is\b/i,
  /\bi decided\b/i,
];

const COMMON_CAPITALIZED = new Set([
  'I',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'The',
  'This',
  'That',
  'These',
  'Those',
  'My',
  'Your',
  'His',
  'Her',
  'Its',
  'Our',
  'Their',
  'But',
  'And',
  'Not',
  'Also',
]);

const CONCRETE_NUMBER_PATTERN =
  /\b\d+\s*(years?\s*old|kg|lbs?|pounds?|feet|ft|cm|meters?|miles?|born\s+in)\b|\bborn\s+in\s+\d{4}\b|\b(age|aged)\s+\d+\b/i;

type DurabilityClass = 'DURABLE' | 'EPHEMERAL' | 'UNCLASSIFIED';

/**
 * Pure function replicating DurabilityClassifierService.classify().
 * No DI, no DB — just lexical rules on the raw content string.
 */
export function classifyDurability(content: string): DurabilityClass {
  if (!content || !content.trim()) return 'EPHEMERAL';

  const trimmed = content.trim();
  if (trimmed.length < 30) return 'EPHEMERAL';

  // Preference signals
  if (PREFERENCE_PATTERNS.some((p) => p.test(trimmed))) return 'DURABLE';
  // Fact signals
  if (FACT_PATTERNS.some((p) => p.test(trimmed))) return 'DURABLE';
  // Named entity detection
  if (hasNamedEntity(trimmed)) return 'DURABLE';
  // Concrete numbers
  if (CONCRETE_NUMBER_PATTERN.test(trimmed)) return 'DURABLE';

  return 'EPHEMERAL';
}

function hasNamedEntity(content: string): boolean {
  const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      if (
        word.length >= 2 &&
        /^[A-Z][a-z]/.test(word) &&
        !COMMON_CAPITALIZED.has(word)
      ) {
        return true;
      }
    }
  }
  return false;
}

// ── Scoring engine (extends simulate.ts with durability) ────────

/**
 * Run a durability-aware scoring config against all gold queries.
 * Mirrors runScoringConfig from simulate.ts but applies durability
 * multipliers to the importance component of the final blend.
 */
export function runDurabilityAwareScoring(
  config: DurabilityAwareScoringConfig,
  queries: QueryEntry[],
  corpus: CorpusMemory[],
  cosineScores: CosineScores,
  durabilityMap: Map<string, DurabilityClass>,
): Map<string, string[]> {
  // Build userId → memories lookup (by canary prefix)
  const userNameToMemories = new Map<string, CorpusMemory[]>();
  for (const mem of corpus) {
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

    // Stage 1: Pre-filter by pure cosine (same as simulate.ts)
    const withCosine = userMems
      .map((mem) => ({ mem, cosine: qCosines[mem.id] ?? 0 }))
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, config.preRerankK);

    // Stage 2: Final blend with durability multiplier on importance
    const finalScored = withCosine.map(({ mem, cosine }) => {
      const importance = mem.importanceScore ?? 0.5;
      const durability = durabilityMap.get(mem.id) ?? 'UNCLASSIFIED';

      let durabilityMult = 1.0;
      if (durability === 'DURABLE') durabilityMult = config.durableBoost;
      else if (durability === 'EPHEMERAL')
        durabilityMult = config.ephemeralPenalty;

      // Apply durability multiplier to importance in the blend
      const adjustedImportance = importance * durabilityMult;
      const score =
        cosine * config.cosineWeight +
        adjustedImportance * config.importanceFinalWeight;

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

// ── Evaluation ──────────────────────────────────────────────────

/** The 3 known failing query IDs from post-dream-cycle benchmark. */
const FOCUS_QUERY_IDS = ['cross_001', 'semantic_002', 'cross_006'];

function evaluateConfig(
  config: DurabilityAwareScoringConfig,
  queries: QueryEntry[],
  corpus: CorpusMemory[],
  cosineScores: CosineScores,
  durabilityMap: Map<string, DurabilityClass>,
): AutoresearchResult {
  const resultMap = runDurabilityAwareScoring(
    config,
    queries,
    corpus,
    cosineScores,
    durabilityMap,
  );

  const allScores: QueryScore[] = [];

  for (const goldQuery of GOLD_QUERIES) {
    const topIds = resultMap.get(goldQuery.id) ?? [];

    // Compute top-20 for recall@20 (with durability-aware scoring)
    const qCosines = cosineScores[goldQuery.id] ?? {};
    const userMems = corpus.filter((m) => {
      const match = m.raw.match(/^RLS_CANARY_([A-Z]+)_/i);
      return match && match[1].toLowerCase() === goldQuery.user;
    });

    const top20 = userMems
      .map((m) => {
        const durability = durabilityMap.get(m.id) ?? 'UNCLASSIFIED';
        let durabilityMult = 1.0;
        if (durability === 'DURABLE') durabilityMult = config.durableBoost;
        else if (durability === 'EPHEMERAL')
          durabilityMult = config.ephemeralPenalty;

        const adjustedImportance = m.importanceScore * durabilityMult;
        return {
          id: m.id,
          score:
            (qCosines[m.id] ?? 0) * config.cosineWeight +
            adjustedImportance * config.importanceFinalWeight,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((r) => r.id);

    const top5Hits = goldQuery.must_top5.filter((id) => topIds.includes(id));
    const precisionAt5 =
      goldQuery.must_top5.length > 0
        ? top5Hits.length / goldQuery.must_top5.length
        : 1.0;

    const mustAbsentViolations = goldQuery.must_absent.filter((id) =>
      [...topIds, ...top20].includes(id),
    );
    const isolationPassed = mustAbsentViolations.length === 0;

    const shouldTop20 = goldQuery.should_top20 ?? [];
    const top20Hits = shouldTop20.filter((id) => top20.includes(id));
    const recallAt20 =
      shouldTop20.length > 0 ? top20Hits.length / shouldTop20.length : 1.0;

    let mrr: number;
    if (goldQuery.must_top5.length > 0) {
      const allIds = [...new Set([...topIds, ...top20])];
      const reciprocalRanks = goldQuery.must_top5.map((id) => {
        const rank = allIds.indexOf(id);
        return rank >= 0 ? 1 / (rank + 1) : 0;
      });
      mrr =
        reciprocalRanks.reduce((sum, rr) => sum + rr, 0) /
        goldQuery.must_top5.length;
    } else {
      mrr = 1.0;
    }

    const passed =
      isolationPassed &&
      (goldQuery.must_top5.length === 0 || top5Hits.length > 0);

    allScores.push({
      queryId: goldQuery.id,
      category: goldQuery.category,
      passed,
      precisionAt5,
      recallAt20,
      mrr,
      isolationPassed,
      details: {
        query: goldQuery.query,
        user: goldQuery.user,
        expectedTop5: goldQuery.must_top5,
        expectedTop20: shouldTop20,
        actualIds: [
          ...topIds,
          ...top20.filter((id) => !topIds.includes(id)),
        ].slice(0, 20),
        mustAbsentViolations,
        top5Hits,
        top20Hits,
      },
    });
  }

  const avg = (vals: number[]) =>
    vals.length === 0 ? 0 : vals.reduce((s, v) => s + v, 0) / vals.length;

  const overallPrecisionAt5 = avg(allScores.map((s) => s.precisionAt5));
  const zeroHits = allScores.filter(
    (s) => s.details.expectedTop5.length > 0 && s.details.top5Hits.length === 0,
  ).length;
  const isolationScore =
    allScores.filter((s) => s.isolationPassed).length / allScores.length;

  // Focus scoring: the 3 known failing queries
  const focusScores = allScores.filter((s) =>
    FOCUS_QUERY_IDS.includes(s.queryId),
  );
  const focusPrecisionAt5 = avg(focusScores.map((s) => s.precisionAt5));
  const focusHits = focusScores.filter(
    (s) => s.details.expectedTop5.length > 0 && s.details.top5Hits.length > 0,
  ).length;

  const focusDetails = focusScores.map((s) => ({
    queryId: s.queryId,
    hit: s.details.top5Hits.length > 0,
    top5: s.details.actualIds.slice(0, 5),
    expected: s.details.expectedTop5,
  }));

  const passed =
    overallPrecisionAt5 >= 0.7 && zeroHits === 0 && isolationScore >= 1.0;

  return {
    config,
    overallPrecisionAt5,
    zeroHits,
    isolationScore,
    passed,
    focusPrecisionAt5,
    focusHits,
    focusDetails,
  };
}

// ── File loading ────────────────────────────────────────────────

function loadJson<T>(filename: string): T {
  const filePath = path.join(HARNESS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing file: ${filePath}\nRun: npm run benchmark:precompute first`,
    );
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

// ── Main sweep ──────────────────────────────────────────────────

function main() {
  console.log(
    '=== Autoresearch Sweep: Durability-Aware Parameter Optimization ===\n',
  );
  console.log('Loading precomputed data...');

  const corpus = loadJson<CorpusMemory[]>('corpus.json');
  const queries = loadJson<QueryEntry[]>('queries.json');
  const cosineScores = loadJson<CosineScores>('cosine-scores.json');

  console.log(
    `  corpus: ${corpus.length} memories, queries: ${queries.length}, cosine entries: ${Object.keys(cosineScores).length}`,
  );

  // Pre-classify all corpus memories for durability
  console.log('\nClassifying corpus durability...');
  const durabilityMap = new Map<string, DurabilityClass>();
  let durableCount = 0;
  let ephemeralCount = 0;

  for (const mem of corpus) {
    // Strip the RLS_CANARY prefix to get the actual content for classification
    const content = mem.raw.replace(/^RLS_CANARY_[A-Z]+_\w+:\s*/i, '');
    const durability = classifyDurability(content);
    durabilityMap.set(mem.id, durability);
    if (durability === 'DURABLE') durableCount++;
    else if (durability === 'EPHEMERAL') ephemeralCount++;
  }

  console.log(
    `  DURABLE: ${durableCount}, EPHEMERAL: ${ephemeralCount}, UNCLASSIFIED: ${corpus.length - durableCount - ephemeralCount}`,
  );

  // Show focus queries
  console.log('\nFocus queries (known failures):');
  for (const qid of FOCUS_QUERY_IDS) {
    const gq = GOLD_QUERIES.find((g) => g.id === qid);
    if (gq)
      console.log(
        `  ${qid}: "${gq.query}" → expects [${gq.must_top5.join(', ')}]`,
      );
  }

  // Grid search parameters
  const durableBoosts = [1.3, 1.5, 1.8, 2.0, 2.5];
  const ephemeralPenalties = [0.85, 0.7, 0.6, 0.5, 0.4];
  const cosineWeights = [0.6, 0.7, 0.8];
  const importanceFinalWeights = [0.05, 0.15, 0.25];

  const totalConfigs =
    durableBoosts.length *
    ephemeralPenalties.length *
    cosineWeights.length *
    importanceFinalWeights.length;

  console.log(`\nSweeping ${totalConfigs} configurations...`);
  console.log(`  durableBoost:          [${durableBoosts.join(', ')}]`);
  console.log(`  ephemeralPenalty:       [${ephemeralPenalties.join(', ')}]`);
  console.log(`  cosineWeight:          [${cosineWeights.join(', ')}]`);
  console.log(
    `  importanceFinalWeight: [${importanceFinalWeights.join(', ')}]`,
  );

  const allResults: AutoresearchResult[] = [];
  let count = 0;

  for (const durableBoost of durableBoosts) {
    for (const ephemeralPenalty of ephemeralPenalties) {
      for (const cosineWeight of cosineWeights) {
        for (const importanceFinalWeight of importanceFinalWeights) {
          const config: DurabilityAwareScoringConfig = {
            preRerankK: 120,
            cosineWeight,
            importanceFinalWeight,
            durableBoost,
            ephemeralPenalty,
          };

          const result = evaluateConfig(
            config,
            queries,
            corpus,
            cosineScores,
            durabilityMap,
          );
          allResults.push(result);
          count++;

          if (count % 25 === 0) {
            process.stdout.write(
              `  ${count}/${totalConfigs} configs evaluated\r`,
            );
          }
        }
      }
    }
  }

  console.log(`  ${count}/${totalConfigs} configs evaluated\n`);

  // ── Results analysis ────────────────────────────────────────

  // Primary sort: fixes all 3 focus queries, then by overall P@5
  const fixesAll = allResults
    .filter((r) => r.focusHits === FOCUS_QUERY_IDS.length && r.passed)
    .sort((a, b) => b.overallPrecisionAt5 - a.overallPrecisionAt5);

  // Secondary: fixes at least some focus queries while passing overall
  const fixesSome = allResults
    .filter(
      (r) =>
        r.focusHits > 0 && r.focusHits < FOCUS_QUERY_IDS.length && r.passed,
    )
    .sort(
      (a, b) =>
        b.focusHits - a.focusHits ||
        b.overallPrecisionAt5 - a.overallPrecisionAt5,
    );

  // Fallback: best overall P@5 regardless
  const bestOverall = [...allResults].sort(
    (a, b) => b.overallPrecisionAt5 - a.overallPrecisionAt5,
  );

  // ── Print results ─────────────────────────────────────────

  const sep =
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

  console.log(sep);
  console.log('AUTORESEARCH SWEEP RESULTS');
  console.log(sep);

  if (fixesAll.length > 0) {
    console.log(
      `\n✅ ${fixesAll.length} configs fix ALL ${FOCUS_QUERY_IDS.length} focus queries AND pass overall thresholds:\n`,
    );
    printResultTable(fixesAll.slice(0, 15));
    printBestConfig(fixesAll[0]);
  } else if (fixesSome.length > 0) {
    console.log(
      `\n⚠️  No config fixes all ${FOCUS_QUERY_IDS.length} focus queries, but ${fixesSome.length} fix some:\n`,
    );
    printResultTable(fixesSome.slice(0, 10));
    printBestConfig(fixesSome[0]);
  } else {
    console.log(
      `\n❌ No config fixes any focus query while passing overall thresholds.`,
    );
    console.log('\nTop 10 by overall P@5:\n');
    printResultTable(bestOverall.slice(0, 10));
    if (bestOverall.length > 0) printBestConfig(bestOverall[0]);
  }

  // ── Env var recommendations ───────────────────────────────

  const best = fixesAll[0] ?? fixesSome[0] ?? bestOverall[0];
  if (best) {
    console.log('\n' + sep);
    console.log('RECOMMENDED ENV VARS FOR CI:');
    console.log(sep);
    console.log(`  DURABILITY_BOOST_ENABLED=true`);
    console.log(`  DURABLE_BOOST_MULTIPLIER=${best.config.durableBoost}`);
    console.log(
      `  EPHEMERAL_PENALTY_MULTIPLIER=${best.config.ephemeralPenalty}`,
    );
    console.log(
      `\n  # Also verify these scoring weights work with rerankers enabled:`,
    );
    console.log(`  # cosineWeight=${best.config.cosineWeight}`);
    console.log(
      `  # importanceFinalWeight=${best.config.importanceFinalWeight}`,
    );
  }

  console.log();
}

function printResultTable(results: AutoresearchResult[]) {
  const header = `${'Rank'.padEnd(5)} ${'P@5'.padEnd(7)} ${'Focus'.padEnd(7)} ${'ZH'.padEnd(4)} ${'Iso'.padEnd(5)} ${'dB'.padEnd(5)} ${'eP'.padEnd(6)} ${'cW'.padEnd(5)} ${'iW'.padEnd(5)} Focus Detail`;
  console.log(header);
  console.log('─'.repeat(100));

  results.forEach((r, i) => {
    const focusDetail = r.focusDetails
      .map(
        (d) =>
          `${d.queryId.replace('cross_', 'x').replace('semantic_', 's')}:${d.hit ? 'Y' : 'N'}`,
      )
      .join(' ');

    console.log(
      `${String(i + 1).padEnd(5)} ` +
        `${(r.overallPrecisionAt5 * 100).toFixed(1).padEnd(6)}% ` +
        `${r.focusHits}/${FOCUS_QUERY_IDS.length}`.padEnd(7) +
        ` ${String(r.zeroHits).padEnd(4)}` +
        `${(r.isolationScore * 100).toFixed(0).padEnd(5)}% ` +
        `${r.config.durableBoost.toFixed(1).padEnd(5)} ` +
        `${r.config.ephemeralPenalty.toFixed(2).padEnd(6)} ` +
        `${r.config.cosineWeight.toFixed(1).padEnd(5)} ` +
        `${r.config.importanceFinalWeight.toFixed(2).padEnd(5)} ` +
        focusDetail,
    );
  });
}

function printBestConfig(best: AutoresearchResult) {
  console.log(`\n🏆 Best config:`);
  console.log(`   durableBoost:          ${best.config.durableBoost}`);
  console.log(`   ephemeralPenalty:       ${best.config.ephemeralPenalty}`);
  console.log(`   cosineWeight:          ${best.config.cosineWeight}`);
  console.log(`   importanceFinalWeight: ${best.config.importanceFinalWeight}`);
  console.log(`   preRerankK:            ${best.config.preRerankK}`);
  console.log(
    `   Overall P@5:           ${(best.overallPrecisionAt5 * 100).toFixed(1)}%`,
  );
  console.log(
    `   Focus P@5:             ${(best.focusPrecisionAt5 * 100).toFixed(1)}%`,
  );
  console.log(
    `   Focus hits:            ${best.focusHits}/${FOCUS_QUERY_IDS.length}`,
  );

  if (best.focusDetails.length > 0) {
    console.log(`   Focus query detail:`);
    for (const d of best.focusDetails) {
      const status = d.hit ? '✅' : '❌';
      console.log(
        `     ${status} ${d.queryId}: expected [${d.expected.join(', ')}] → got [${d.top5.join(', ')}]`,
      );
    }
  }
}

// Only run main when executed directly (not when imported for testing)
if (require.main === module) {
  main();
}
