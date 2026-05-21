import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, CallHandler, HttpException } from '@nestjs/common';
import { of } from 'rxjs';
import { UsageTrackingInterceptor } from './usage-tracking.interceptor';
import { PrismaService } from '../../prisma/prisma.service';

const mockPrisma = {
  account: { findUnique: jest.fn() },
  $queryRaw: jest.fn(),
};

// Helper: create a mock ExecutionContext
function makeContext(overrides: {
  method?: string;
  path?: string;
  agent?: { accountId?: string } | null;
}): ExecutionContext {
  const request = {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/api/memories',
    agent:
      overrides.agent !== undefined
        ? overrides.agent
        : { accountId: 'acc-001' },
  } as any;

  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

// Helper: create a pass-through CallHandler
function makeHandler(): CallHandler {
  return { handle: () => of({ ok: true }) };
}

const freeAccount = {
  id: 'acc-001',
  plan: 'FREE',
  memoriesUsed: 500,
  apiCallsToday: 0,
};

const proAccount = {
  id: 'acc-002',
  plan: 'PRO',
  memoriesUsed: 50000,
  apiCallsToday: 0,
};

describe('UsageTrackingInterceptor', () => {
  let interceptor: UsageTrackingInterceptor;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsageTrackingInterceptor,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    interceptor = module.get<UsageTrackingInterceptor>(
      UsageTrackingInterceptor,
    );
  });

  // ─── Happy paths ────────────────────────────────────────────────────────────

  describe('happy paths', () => {
    it('should pass through when agent has no accountId (self-hosted)', async () => {
      const ctx = makeContext({ agent: { accountId: undefined } });
      const handler = makeHandler();

      const result = await interceptor.intercept(ctx, handler);
      expect(result).toBeDefined();
      expect(mockPrisma.account.findUnique).not.toHaveBeenCalled();
    });

    it('should pass through when agent is null (no auth)', async () => {
      const ctx = makeContext({ agent: null });
      const handler = makeHandler();

      const result = await interceptor.intercept(ctx, handler);
      expect(result).toBeDefined();
      expect(mockPrisma.account.findUnique).not.toHaveBeenCalled();
    });

    it('should pass through when account is not found', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce(null);
      const ctx = makeContext({});
      const handler = makeHandler();

      const result = await interceptor.intercept(ctx, handler);
      expect(result).toBeDefined();
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('should allow request within FREE plan API limit', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce(freeAccount);
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 50, memories_used: 500 },
      ]);
      const ctx = makeContext({ method: 'GET', path: '/api/data' });
      const handler = makeHandler();

      const result = await interceptor.intercept(ctx, handler);
      expect(result).toBeDefined();
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('should allow memory creation within FREE plan memory limit', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce({
        ...freeAccount,
        memoriesUsed: 999,
      });
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 1, memories_used: 999 },
      ]);
      const ctx = makeContext({ method: 'POST', path: '/v1/memories' });
      const handler = makeHandler();

      await expect(interceptor.intercept(ctx, handler)).resolves.toBeDefined();
    });

    it('should allow PRO plan with very high usage within limits', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce(proAccount);
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 9999, memories_used: 99999 },
      ]);
      const ctx = makeContext({ method: 'POST', path: '/v1/memories' });
      const handler = makeHandler();

      await expect(interceptor.intercept(ctx, handler)).resolves.toBeDefined();
    });

    it('should attach account to request for downstream use', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce(freeAccount);
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 1, memories_used: 500 },
      ]);
      const request: any = {
        method: 'GET',
        path: '/api/data',
        agent: { accountId: 'acc-001' },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as ExecutionContext;

      await interceptor.intercept(ctx, makeHandler());

      expect(request.account).toEqual(freeAccount);
    });
  });

  // ─── API call limit enforcement ─────────────────────────────────────────────

  describe('API call limit enforcement', () => {
    it('should throw 429 when FREE plan API limit exceeded', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce(freeAccount);
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 101, memories_used: 500 }, // > 100 limit
      ]);
      const ctx = makeContext({});
      const handler = makeHandler();

      await expect(interceptor.intercept(ctx, handler)).rejects.toThrow(
        HttpException,
      );
    });

    it('should include plan name and limit in 429 error message', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce(freeAccount);
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 101, memories_used: 500 },
      ]);
      const ctx = makeContext({});

      try {
        await interceptor.intercept(ctx, makeHandler());
        fail('Should have thrown');
      } catch (e: any) {
        expect(e.getStatus()).toBe(429);
        const body = e.getResponse();
        expect(body.message).toContain('100');
        expect(body.message).toContain('FREE');
      }
    });

    it('should allow exactly at the limit (not over)', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce(freeAccount);
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 100, memories_used: 500 }, // exactly at limit
      ]);
      const ctx = makeContext({});

      await expect(
        interceptor.intercept(ctx, makeHandler()),
      ).resolves.toBeDefined();
    });

    it('should enforce SCALE plan API limit (100000/day)', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce({
        ...freeAccount,
        plan: 'SCALE',
      });
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 99999, memories_used: 500 }, // under 100000 limit
      ]);
      const ctx = makeContext({});

      // Within SCALE limit — should pass
      await expect(
        interceptor.intercept(ctx, makeHandler()),
      ).resolves.toBeDefined();
    });
  });

  // ─── Memory limit enforcement ────────────────────────────────────────────────

  describe('memory limit enforcement', () => {
    it('should throw 429 on POST /memories when FREE memory limit reached', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce({
        ...freeAccount,
        memoriesUsed: 1000,
      });
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 1, memories_used: 1000 }, // exactly at limit
      ]);
      const ctx = makeContext({ method: 'POST', path: '/v1/memories' });

      await expect(interceptor.intercept(ctx, makeHandler())).rejects.toThrow(
        HttpException,
      );
    });

    it('should include memory limit in 429 error for memory creation', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce({
        ...freeAccount,
        memoriesUsed: 1000,
      });
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 1, memories_used: 1000 },
      ]);
      const ctx = makeContext({ method: 'POST', path: '/v1/memories' });

      try {
        await interceptor.intercept(ctx, makeHandler());
        fail('Should have thrown');
      } catch (e: any) {
        expect(e.getStatus()).toBe(429);
        const body = e.getResponse();
        expect(body.message).toContain('1000');
        expect(body.message).toContain('FREE');
      }
    });

    it('should NOT check memory limit on GET /memories', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce({
        ...freeAccount,
        memoriesUsed: 1500, // Way over limit but it's a GET
      });
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 1, memories_used: 1500 },
      ]);
      const ctx = makeContext({ method: 'GET', path: '/v1/memories' });

      await expect(
        interceptor.intercept(ctx, makeHandler()),
      ).resolves.toBeDefined();
    });

    it('should NOT check memory limit on POST to non-memory endpoints', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce({
        ...freeAccount,
        memoriesUsed: 1500,
      });
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 1, memories_used: 1500 },
      ]);
      const ctx = makeContext({ method: 'POST', path: '/v1/agents' });

      await expect(
        interceptor.intercept(ctx, makeHandler()),
      ).resolves.toBeDefined();
    });

    it('should use memories_used from query result if available', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce({
        ...freeAccount,
        memoriesUsed: 500, // account object says 500
      });
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 1, memories_used: 1000 }, // query says 1000 (at limit)
      ]);
      const ctx = makeContext({ method: 'POST', path: '/v1/memories' });

      // Should use query result (1000 >= 1000 limit) → should throw
      await expect(interceptor.intercept(ctx, makeHandler())).rejects.toThrow(
        HttpException,
      );
    });

    it('should fallback to account.memoriesUsed when query returns no memories_used', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce({
        ...freeAccount,
        memoriesUsed: 1000, // at limit
      });
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { api_calls_today: 1, memories_used: undefined },
      ]);
      const ctx = makeContext({ method: 'POST', path: '/v1/memories' });

      await expect(interceptor.intercept(ctx, makeHandler())).rejects.toThrow(
        HttpException,
      );
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle empty $queryRaw result gracefully', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce(freeAccount);
      mockPrisma.$queryRaw.mockResolvedValueOnce([]); // empty result
      const ctx = makeContext({});

      // Should not throw — uses defaults (0 api calls)
      await expect(
        interceptor.intercept(ctx, makeHandler()),
      ).resolves.toBeDefined();
    });

    it('should throw when $queryRaw returns null (DB error)', async () => {
      mockPrisma.account.findUnique.mockResolvedValueOnce(freeAccount);
      mockPrisma.$queryRaw.mockResolvedValueOnce(null);
      const ctx = makeContext({});

      // Current implementation does result[0]?.api_calls_today which throws on null
      await expect(interceptor.intercept(ctx, makeHandler())).rejects.toThrow(
        TypeError,
      );
    });

    it('should handle agent object missing entirely (no request.agent)', async () => {
      // Build a request where agent is undefined (middleware never set it)
      const request: any = {
        method: 'GET',
        path: '/api/data',
        // agent not set at all
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as ExecutionContext;
      const handler = makeHandler();

      // agent?.accountId is undefined → should pass through without DB call
      const result = await interceptor.intercept(ctx, handler);
      expect(result).toBeDefined();
      expect(mockPrisma.account.findUnique).not.toHaveBeenCalled();
    });
  });
});
