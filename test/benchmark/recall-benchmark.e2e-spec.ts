/**
 * Recall Benchmark — e2e test suite.
 *
 * Seeds the full corpus, runs all gold queries through the actual HTTP API
 * (POST /v1/memories/query), and scores each result against gold expectations.
 *
 * Thresholds:
 *  - Isolation score = 100% (zero tolerance for cross-tenant leaks)
 *  - Required coverage@5 >= 95%
 *  - Explicit no-answer judgments must return no records
 */

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createTestApp } from '../helpers/create-test-app';
import { seedCorpus } from '../helpers/seed-corpus';
import type { SeedCorpusResult, SeededUser } from '../helpers/seed-corpus';
import { asUser } from '../helpers/auth-helpers';
import { GOLD_QUERIES, QUERIES_BY_CATEGORY } from '../fixtures';
import type { GoldQuery } from '../fixtures/types';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EmbeddingService as EmbeddingGeneratorService } from '../../src/embedding/embedding.service';
import {
  REQUIRED_COVERAGE_AT_5_THRESHOLD,
  scoreQuery,
  buildReport,
  formatReport,
  checkThresholds,
  type QueryScore,
} from './scoring';
import { saveReport, getGitInfo } from './history';
import { generateCorpusEmbeddings } from '../helpers/generate-embeddings';

// Generous timeout — corpus seeding + 80+ queries through full stack
jest.setTimeout(300_000);

describe('Recall Benchmark', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let corpus: SeedCorpusResult;
  let userMap: Map<string, SeededUser>;

  beforeAll(async () => {
    // Use real embedding service (no CachedEmbeddingService override)
    const testApp = await createTestApp(false);
    app = testApp.app;
    prisma = testApp.prisma;

    // Seed full corpus (accounts, users, memories via SQL — no embeddings yet)
    corpus = await seedCorpus(prisma);
    userMap = new Map(corpus.seededUsers.map((u) => [u.name, u]));

    // Generate real embedding vectors for all seeded memories
    const embeddingGenerator = app.get(EmbeddingGeneratorService);
    await generateCorpusEmbeddings(prisma, embeddingGenerator, corpus);
  });

  afterAll(async () => {
    if (corpus?.cleanup) {
      await corpus.cleanup();
    }
    if (app) {
      await app.close();
    }
  });

  // Run all gold queries and collect scores
  const allScores: QueryScore[] = [];

  /**
   * Execute a single recall query through the HTTP API.
   */
  async function executeQuery(query: GoldQuery): Promise<string[]> {
    const user = userMap.get(query.user);
    if (!user) {
      throw new Error(`Unknown fixture user: ${query.user}`);
    }

    // Skip empty queries — API may reject them
    if (!query.query || query.query.trim() === '') {
      return [];
    }

    const headers = asUser(user.apiKey, user.userId);

    try {
      const res = await request(app.getHttpServer())
        .post('/v1/memories/query')
        .set(headers)
        .send({ query: query.query, limit: 20 })
        .expect((r) => {
          // Empty input is handled above; other API failures must fail the run.
          if (r.status !== 200 && r.status !== 201) {
            throw new Error(
              `Unexpected status ${r.status} for query "${query.query}": ${JSON.stringify(r.body)}`,
            );
          }
        });

      const body = res.body as { memories?: Array<{ id: string }> };
      return (body.memories ?? []).map((m) => m.id);
    } catch (error) {
      console.error(
        `Query execution failed for [${query.id}]: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  // Group tests by category for readability
  for (const [category, queries] of Object.entries(QUERIES_BY_CATEGORY)) {
    describe(`Category: ${category}`, () => {
      for (const query of queries) {
        it(`[${query.id}] ${query.query.slice(0, 60)}${query.query.length > 60 ? '...' : ''}`, async () => {
          const resultIds = await executeQuery(query);
          const score = scoreQuery(query, resultIds);
          allScores.push(score);

          // Isolation is always a hard fail
          if (!score.isolationPassed) {
            throw new Error(
              `ISOLATION FAILURE: must_absent items found in results: ${score.details.mustAbsentViolations.join(', ')}`,
            );
          }
        });
      }
    });
  }

  // Summary test that runs after all queries
  describe('Summary', () => {
    it('should generate and save benchmark report', () => {
      if (allScores.length === 0) {
        console.warn('No scores collected — skipping report');
        return;
      }

      const { sha, branch } = getGitInfo();
      const report = buildReport(allScores, sha, branch);

      // Print report
      console.log(formatReport(report));

      // Save to history
      const savedPath = saveReport(report);
      console.log(`📁 Report saved: ${savedPath}`);
    });

    it('should have zero isolation failures', () => {
      if (allScores.length === 0) {
        console.warn('No scores to check thresholds against');
        return;
      }

      // Isolation is always enforced — zero tolerance for cross-tenant leaks
      const isolationFailures = allScores.filter((s) => !s.isolationPassed);
      expect(isolationFailures).toHaveLength(0);
    });

    it('should meet coverage thresholds (with real embeddings)', () => {
      if (allScores.length === 0) {
        console.warn('No scores to check thresholds against');
        return;
      }

      const { sha, branch } = getGitInfo();
      const report = buildReport(allScores, sha, branch);

      // This suite always generates real embeddings. The gate cannot be disabled
      // by omitting an unrelated environment flag.
      expect(allScores).toHaveLength(GOLD_QUERIES.length);
      expect(report.overallRequiredCoverageAt5).not.toBeNull();
      expect(report.overallRequiredCoverageAt5).toBeGreaterThanOrEqual(
        REQUIRED_COVERAGE_AT_5_THRESHOLD,
      );
      expect(checkThresholds(allScores)).toBe(true);
    });
  });
});
