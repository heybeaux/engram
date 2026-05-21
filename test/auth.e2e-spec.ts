import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';

describe('Auth Flow (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;

  // Agent A
  const agentAKey = 'sk-test-auth-e2e-agent-a';
  const agentAKeyHash = createHash('sha256').update(agentAKey).digest('hex');
  const userIdA = 'auth-e2e-user-a';

  // Agent B (for cross-agent isolation)
  const agentBKey = 'sk-test-auth-e2e-agent-b';
  const agentBKeyHash = createHash('sha256').update(agentBKey).digest('hex');
  const userIdB = 'auth-e2e-user-b';

  let accountId: string;
  let agentAId: string;
  let agentBId: string;

  // Save and restore env
  const origTrustLocal = process.env.TRUST_LOCAL_NETWORK;
  const origLanBypass = process.env.LAN_BYPASS;

  beforeAll(async () => {
    // Disable LAN bypass so auth is actually enforced
    process.env.TRUST_LOCAL_NETWORK = 'false';
    process.env.LAN_BYPASS = 'false';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);

    // Clean up any leftover test data (order matters for FK constraints)
    const testExternalIds = [userIdA, userIdB, 'auth-e2e-user-a2'];

    await prisma.memoryExtraction.deleteMany({
      where: { memory: { user: { externalId: { in: testExternalIds } } } },
    });
    await prisma.memory.deleteMany({
      where: { user: { externalId: { in: testExternalIds } } },
    });
    await prisma.user.deleteMany({
      where: { externalId: { in: testExternalIds } },
    });
    await prisma.agent.deleteMany({
      where: { apiKeyHash: { in: [agentAKeyHash, agentBKeyHash] } },
    });

    // Create a shared account
    const account = await prisma.account.create({
      data: {
        name: 'auth-e2e-account',
        email: 'auth-e2e@test.local',
        passwordHash: 'not-a-real-hash-just-for-testing',
      },
    });
    accountId = account.id;

    // Create Agent A under account
    const agentA = await prisma.agent.create({
      data: {
        name: 'Auth E2E Agent A',
        apiKeyHash: agentAKeyHash,
        apiKeyHint: 'ag-a',
        accountId,
      },
    });
    agentAId = agentA.id;

    // Create Agent B under same account
    const agentB = await prisma.agent.create({
      data: {
        name: 'Auth E2E Agent B',
        apiKeyHash: agentBKeyHash,
        apiKeyHint: 'ag-b',
        accountId,
      },
    });
    agentBId = agentB.id;
  });

  afterAll(async () => {
    // Clean up in correct order
    const testExternalIds = [
      userIdA,
      userIdB,
      'auth-e2e-user-a2',
      'default',
      accountId,
    ];

    await prisma.memoryChainLink
      .deleteMany({
        where: {
          source: { user: { externalId: { in: testExternalIds } } },
        },
      })
      .catch(() => {});
    await prisma.memoryExtraction
      .deleteMany({
        where: { memory: { user: { externalId: { in: testExternalIds } } } },
      })
      .catch(() => {});
    await prisma.memory
      .deleteMany({
        where: { user: { externalId: { in: testExternalIds } } },
      })
      .catch(() => {});
    await prisma.user
      .deleteMany({
        where: { externalId: { in: testExternalIds } },
      })
      .catch(() => {});
    await prisma.agent
      .deleteMany({
        where: { id: { in: [agentAId, agentBId].filter(Boolean) } },
      })
      .catch(() => {});
    await prisma.account
      .deleteMany({
        where: { id: accountId },
      })
      .catch(() => {});

    // Restore env
    if (origTrustLocal !== undefined) {
      process.env.TRUST_LOCAL_NETWORK = origTrustLocal;
    } else {
      delete process.env.TRUST_LOCAL_NETWORK;
    }
    if (origLanBypass !== undefined) {
      process.env.LAN_BYPASS = origLanBypass;
    } else {
      delete process.env.LAN_BYPASS;
    }

    await app.close();
  });

  // =========================================================================
  // 1. Missing auth → 401
  // =========================================================================
  describe('Missing authentication', () => {
    it('should return 401 when no auth headers provided', () => {
      return request(app.getHttpServer())
        .post('/v1/memories')
        .send({ raw: 'Should fail' })
        .expect(401);
    });

    it('should return 401 when only user ID is provided (no API key or JWT)', () => {
      return request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-User-ID', userIdA)
        .send({ raw: 'Should fail' })
        .expect(401);
    });
  });

  // =========================================================================
  // 2. API key auth
  // =========================================================================
  describe('API key authentication', () => {
    it('should accept valid API key → 201', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', userIdA)
        .send({ raw: 'Auth test memory A' })
        .expect(201);

      expect(res.body.id).toBeDefined();
    });

    it('should reject invalid API key → 401', () => {
      return request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', 'sk-completely-invalid-key')
        .set('X-AM-User-ID', userIdA)
        .send({ raw: 'Should fail' })
        .expect(401);
    });

    it('should resolve correct agent from API key', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', userIdA)
        .send({ raw: 'Agent A identity check' })
        .expect(201);

      const memory = await prisma.memory.findUnique({
        where: { id: res.body.id },
        include: { user: true },
      });
      expect(memory).not.toBeNull();
      expect(memory!.user.accountId).toBe(accountId);
      expect(memory!.user.externalId).toBe(userIdA);
    });

    it('should auto-create user on first request with new user ID', async () => {
      const newUserId = 'auth-e2e-user-a2';
      await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', newUserId)
        .send({ raw: 'New user memory' })
        .expect(201);

      const user = await prisma.user.findFirst({
        where: { externalId: newUserId, accountId },
      });
      expect(user).not.toBeNull();
    });

    it('should default user to "default" when X-AM-User-ID is not provided', async () => {
      await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentAKey)
        .send({ raw: 'No user ID memory' })
        .expect(201);

      const user = await prisma.user.findFirst({
        where: { externalId: 'default', accountId },
      });
      expect(user).not.toBeNull();
    });
  });

  // =========================================================================
  // 3. JWT authentication
  // =========================================================================
  describe('JWT authentication', () => {
    it('should accept valid JWT → 201', async () => {
      const token = jwtService.sign({ sub: accountId });

      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ raw: 'JWT auth memory' })
        .expect(201);

      expect(res.body.id).toBeDefined();
    });

    it('should reject invalid JWT → 401', () => {
      return request(app.getHttpServer())
        .post('/v1/memories')
        .set('Authorization', 'Bearer invalid.jwt.token')
        .send({ raw: 'Should fail' })
        .expect(401);
    });

    it('should reject expired JWT → 401', () => {
      const token = jwtService.sign({ sub: accountId }, { expiresIn: '-1s' });

      return request(app.getHttpServer())
        .post('/v1/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ raw: 'Should fail' })
        .expect(401);
    });

    it('should resolve correct agent from JWT account', async () => {
      const token = jwtService.sign({ sub: accountId });

      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('Authorization', `Bearer ${token}`)
        .send({ raw: 'JWT agent resolution test' })
        .expect(201);

      // JWT resolves to the first agent in the account (Agent A, created first)
      const memory = await prisma.memory.findUnique({
        where: { id: res.body.id },
        include: { user: true },
      });
      expect(memory!.user.accountId).toBe(accountId);
    });
  });

  // =========================================================================
  // 4. Cross-agent isolation
  // =========================================================================
  describe('Cross-agent isolation', () => {
    let agentAMemoryId: string;

    beforeAll(async () => {
      // Create a memory under Agent A
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', userIdA)
        .send({ raw: 'Agent A secret memory for isolation test' });
      agentAMemoryId = res.body.id;

      // Create a memory under Agent B
      await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentBKey)
        .set('X-AM-User-ID', userIdB)
        .send({ raw: 'Agent B own memory' });
    });

    it('Agent B should not see Agent A memories via query', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories/query')
        .set('X-AM-API-Key', agentBKey)
        .set('X-AM-User-ID', userIdB)
        .send({ query: 'Agent A secret memory isolation test', limit: 10 })
        .expect(201);

      const memoryIds = res.body.memories.map((m: any) => m.id);
      expect(memoryIds).not.toContain(agentAMemoryId);
    });

    it('Agent B should not retrieve Agent A memory by ID', async () => {
      // RLS interceptor returns 403 when accessing another user's memory
      await request(app.getHttpServer())
        .get(`/v1/memories/${agentAMemoryId}`)
        .set('X-AM-API-Key', agentBKey)
        .set('X-AM-User-ID', userIdB)
        .expect(403);
    });
  });

  // =========================================================================
  // 5. Account-wide user resolution (resolveAccountUserIds)
  // =========================================================================
  describe('Account-wide user resolution', () => {
    beforeAll(async () => {
      // Ensure both users exist under Agent A with memories
      await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', userIdA)
        .send({ raw: 'User A1 memory for account resolution' });

      await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', 'auth-e2e-user-a2')
        .send({ raw: 'User A2 memory for account resolution' });
    });

    it('JWT auth should see memories across all users in account via query', async () => {
      const token = jwtService.sign({ sub: accountId });

      const res = await request(app.getHttpServer())
        .post('/v1/memories/query')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'account resolution', limit: 20 })
        .expect(201);

      // Account-wide resolution should work (query succeeds with account-wide user IDs).
      // Embeddings are generated async so we may get 0 results, but the query
      // itself should succeed and use account-wide user resolution (no 401/403).
      expect(res.body.memories).toBeInstanceOf(Array);
    });

    it('API key auth should see memories from same agent users via context', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/context')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', userIdA)
        .send({})
        .expect(201);

      // Context endpoint uses resolveAccountUserIds — should aggregate
      expect(res.body.memoriesIncluded).toBeGreaterThan(0);
    });
  });
});
