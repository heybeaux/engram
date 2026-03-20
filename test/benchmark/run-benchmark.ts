#!/usr/bin/env ts-node
/**
 * Standalone Recall Benchmark Runner
 *
 * Run with: npx ts-node test/benchmark/run-benchmark.ts
 *
 * Seeds the full corpus, runs all gold queries through the actual HTTP API,
 * scores results, prints a pretty report, and saves history.
 */

import 'dotenv/config';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { seedCorpus } from '../helpers/seed-corpus';
import type { SeededUser } from '../helpers/seed-corpus';
import { asUser } from '../helpers/auth-helpers';
import { GOLD_QUERIES } from '../fixtures';
import type { GoldQuery } from '../fixtures/types';
import {
  scoreQuery,
  buildReport,
  formatReport,
  checkThresholds,
  type QueryScore,
} from './scoring';
import {
  saveReport,
  loadPreviousReport,
  compareReports,
  getGitInfo,
} from './history';

async function run(): Promise<void> {
  console.log('🚀 Starting Engram Recall Benchmark...');
  console.log('');

  // Bootstrap NestJS test app
  console.log('📦 Bootstrapping test app...');
  const { app, prisma } = await createTestApp();

  // Seed corpus
  console.log('🌱 Seeding corpus...');
  const corpus = await seedCorpus(prisma);
  const userMap = new Map(corpus.seededUsers.map((u) => [u.name, u]));
  console.log(
    `  ✓ ${corpus.seededUsers.length} users, ${corpus.totalMemories} memories`,
  );
  console.log('');

  // Run all queries
  console.log(`🔍 Running ${GOLD_QUERIES.length} gold queries...`);
  const scores: QueryScore[] = [];
  let completed = 0;

  for (const query of GOLD_QUERIES) {
    const resultIds = await executeQuery(app, userMap, query);
    const score = scoreQuery(query, resultIds);
    scores.push(score);
    completed++;

    // Progress indicator
    if (completed % 10 === 0 || completed === GOLD_QUERIES.length) {
      const passedSoFar = scores.filter((s) => s.passed).length;
      process.stdout.write(
        `\r  Progress: ${completed}/${GOLD_QUERIES.length} (${passedSoFar} passed)`,
      );
    }
  }
  console.log('');
  console.log('');

  // Build and print report
  const { sha, branch } = getGitInfo();
  const report = buildReport(scores, sha, branch);
  console.log(formatReport(report));

  // Save report
  const savedPath = saveReport(report);
  console.log(`📁 Report saved: ${savedPath}`);

  // Compare with previous run if available
  const previous = loadPreviousReport();
  if (previous) {
    console.log(compareReports(report, previous));
  }

  // Cleanup
  console.log('🧹 Cleaning up...');
  await corpus.cleanup();
  await app.close();

  // Exit with appropriate code
  if (!report.thresholdsPassed) {
    console.error('❌ Benchmark FAILED — thresholds not met');
    process.exit(1);
  }

  console.log('✅ Benchmark PASSED');
  process.exit(0);
}

async function executeQuery(
  app: any,
  userMap: Map<string, SeededUser>,
  query: GoldQuery,
): Promise<string[]> {
  const user = userMap.get(query.user);
  if (!user) return [];

  if (!query.query || query.query.trim() === '') return [];

  const headers = asUser(user.apiKey, user.userId);

  try {
    const res = await request(app.getHttpServer())
      .post('/v1/memories/query')
      .set(headers)
      .send({ query: query.query, limit: 20 });

    if (res.status !== 200) return [];

    const body = res.body as { memories?: Array<{ id: string }> };
    return (body.memories ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
