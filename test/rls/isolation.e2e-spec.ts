/**
 * RLS Isolation E2E Test Suite (ENG-23)
 *
 * Verifies that no endpoint leaks data across tenant boundaries.
 *
 * Strategy:
 * 1. Seed two users (A and B) with canary-tagged memories
 * 2. For each data-reading endpoint, request as user A
 * 3. Assert the response contains ZERO of user B's canary strings
 * 4. Mirror: request as user B, assert zero of user A's canaries
 *
 * ANY canary violation is a hard CI failure — no thresholds, no warnings.
 *
 * Run: npx jest test/rls/ --runInBand --forceExit
 */

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  seedCanaryPair,
  CANARY_PREFIX_A,
  CANARY_PREFIX_B,
} from './canary-factory';
import type { CanaryPair } from './canary-factory';
import { CRITICAL_ENDPOINTS, discoverRoutes } from './endpoint-discovery';
import type { TestEndpoint } from './endpoint-discovery';
import { asUser } from '../helpers/auth-helpers';

// Increase timeout for E2E tests
jest.setTimeout(120_000);

describe('RLS Isolation Suite', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let canaries: CanaryPair;
  let endpoints: TestEndpoint[];

  beforeAll(async () => {
    // Guard against production DB
    const dbUrl = process.env.DATABASE_URL ?? '';
    if (
      dbUrl.includes('railway.app') ||
      dbUrl.includes('supabase.co') ||
      dbUrl.includes('neon.tech')
    ) {
      throw new Error(
        'REFUSING to run RLS isolation tests against a production database!',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = moduleRef.get(PrismaService);

    // Seed canary users
    canaries = await seedCanaryPair(prisma);

    // Discover endpoints
    endpoints = discoverRoutes(app);
    console.log(
      `RLS Suite: Testing ${endpoints.length} endpoints (${endpoints.filter((e) => e.priority === 'critical').length} critical)`,
    );
  });

  afterAll(async () => {
    if (canaries?.cleanup) {
      await canaries.cleanup();
    }
    if (app) {
      await app.close();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // Direction 1: User A must NOT see User B's data
  // ──────────────────────────────────────────────────────────────
  describe('User A sees no User B data', () => {
    it.each(CRITICAL_ENDPOINTS.map((e) => [e.label, e] as const))(
      '%s',
      async (_label, endpoint) => {
        await assertNoLeakage(
          endpoint,
          canaries.userA.apiKey,
          canaries.userA.userId,
          CANARY_PREFIX_B,
          'B',
        );
      },
    );
  });

  // ──────────────────────────────────────────────────────────────
  // Direction 2: User B must NOT see User A's data
  // ──────────────────────────────────────────────────────────────
  describe('User B sees no User A data', () => {
    it.each(CRITICAL_ENDPOINTS.map((e) => [e.label, e] as const))(
      '%s',
      async (_label, endpoint) => {
        await assertNoLeakage(
          endpoint,
          canaries.userB.apiKey,
          canaries.userB.userId,
          CANARY_PREFIX_A,
          'A',
        );
      },
    );
  });

  // ──────────────────────────────────────────────────────────────
  // Auto-discovered endpoints (if any beyond the critical list)
  // ──────────────────────────────────────────────────────────────
  describe('Auto-discovered endpoints — User A isolation', () => {
    // We use a dynamic test approach since endpoints are discovered at runtime
    it('all discovered endpoints respect tenant boundaries', async () => {
      const discovered = endpoints.filter((e) => e.priority === 'normal');
      const violations: string[] = [];

      for (const endpoint of discovered) {
        try {
          const leaked = await checkForLeakage(
            endpoint,
            canaries.userA.apiKey,
            canaries.userA.userId,
            CANARY_PREFIX_B,
          );
          if (leaked) {
            violations.push(
              `${endpoint.method.toUpperCase()} ${endpoint.path}: Found User B canary in User A response`,
            );
          }
        } catch {
          // Skip endpoints that error out (missing params, etc.)
          continue;
        }
      }

      if (violations.length > 0) {
        throw new Error(`RLS VIOLATIONS DETECTED!\n${violations.join('\n')}`);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Direct string search — most thorough check
  // ──────────────────────────────────────────────────────────────
  describe('Raw response body canary sweep', () => {
    it.each(CRITICAL_ENDPOINTS.map((e) => [e.label, e] as const))(
      '%s — full body sweep for foreign canaries',
      async (_label, endpoint) => {
        // Request as user A
        const resA = await makeRequest(
          endpoint,
          canaries.userA.apiKey,
          canaries.userA.userId,
        );
        if (resA.status === 401 || resA.status === 403 || resA.status === 404) {
          return; // Not a leak
        }

        const bodyStr = JSON.stringify(resA.body);
        expect(bodyStr).not.toContain(CANARY_PREFIX_B);

        // Request as user B
        const resB = await makeRequest(
          endpoint,
          canaries.userB.apiKey,
          canaries.userB.userId,
        );
        if (resB.status === 401 || resB.status === 403 || resB.status === 404) {
          return;
        }

        const bodyStrB = JSON.stringify(resB.body);
        expect(bodyStrB).not.toContain(CANARY_PREFIX_A);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────

  function makeRequest(
    endpoint: TestEndpoint,
    apiKey: string,
    userId: string,
  ): request.Test {
    const headers = asUser(apiKey, userId);
    const server = app.getHttpServer();

    if (endpoint.method === 'post') {
      return request(server)
        .post(endpoint.path)
        .set(headers as Record<string, string>)
        .send(endpoint.body ?? {});
    }

    return request(server)
      .get(endpoint.path)
      .set(headers as Record<string, string>);
  }

  async function assertNoLeakage(
    endpoint: TestEndpoint,
    apiKey: string,
    userId: string,
    foreignCanary: string,
    foreignLabel: string,
  ): Promise<void> {
    const res = await makeRequest(endpoint, apiKey, userId);

    // 401/403/404 are not leaks — the endpoint rejected us or found nothing
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return;
    }

    const bodyStr = JSON.stringify(res.body);
    if (bodyStr.includes(foreignCanary)) {
      // Extract which specific canaries leaked
      const matches = bodyStr.match(new RegExp(`${foreignCanary}\\d+`, 'g'));
      throw new Error(
        `🚨 RLS VIOLATION: ${endpoint.method.toUpperCase()} ${endpoint.path}\n` +
          `User "${userId}" can see User ${foreignLabel}'s data!\n` +
          `Leaked canaries: ${matches?.join(', ') ?? 'unknown'}\n` +
          `Response status: ${res.status}`,
      );
    }
  }

  async function checkForLeakage(
    endpoint: TestEndpoint,
    apiKey: string,
    userId: string,
    foreignCanary: string,
  ): Promise<boolean> {
    const res = await makeRequest(endpoint, apiKey, userId);
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return false;
    }
    return JSON.stringify(res.body).includes(foreignCanary);
  }
});
