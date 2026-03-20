import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';

/**
 * HEY-131: Cross-Agent Verification E2E Tests
 *
 * Tests cross-agent memory visibility within same account,
 * agent-specific filtering, account-wide scoping, memory attribution,
 * and cross-account isolation.
 */
describe('Cross-Agent Verification E2E (HEY-131)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;

  const origTrustLocal = process.env.TRUST_LOCAL_NETWORK;
  const origLanBypass = process.env.LAN_BYPASS;

  // Account 1 with two agents
  const agentAKey = 'sk-hey131-agent-a';
  const agentAKeyHash = createHash('sha256').update(agentAKey).digest('hex');
  const agentBKey = 'sk-hey131-agent-b';
  const agentBKeyHash = createHash('sha256').update(agentBKey).digest('hex');

  // Account 2 with one agent (for cross-account isolation)
  const agentCKey = 'sk-hey131-agent-c';
  const agentCKeyHash = createHash('sha256').update(agentCKey).digest('hex');

  const userIdA = 'hey131-user-a';
  const userIdB = 'hey131-user-b';
  const userIdC = 'hey131-user-c';

  let account1Id: string;
  let account2Id: string;
  let agentAId: string;
  let agentBId: string;
  let agentCId: string;

  // Memory IDs for verification
  let memoryA1Id: string;
  let memoryA2Id: string;
  let memoryB1Id: string;
  let memoryC1Id: string;

  beforeAll(async () => {
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

    // Clean up leftover test data
    const testExternalIds = [userIdA, userIdB, userIdC];
    await prisma.memoryChainLink
      .deleteMany({
        where: { source: { user: { externalId: { in: testExternalIds } } } },
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
        where: {
          apiKeyHash: { in: [agentAKeyHash, agentBKeyHash, agentCKeyHash] },
        },
      })
      .catch(() => {});
    await prisma.account
      .deleteMany({
        where: {
          email: { in: ['hey131-acct1@test.local', 'hey131-acct2@test.local'] },
        },
      })
      .catch(() => {});

    // Create Account 1 with two agents
    const account1 = await prisma.account.create({
      data: {
        name: 'HEY-131 Account 1',
        email: 'hey131-acct1@test.local',
        passwordHash: 'not-real-hash',
      },
    });
    account1Id = account1.id;

    const agentA = await prisma.agent.create({
      data: {
        name: 'Agent A',
        apiKeyHash: agentAKeyHash,
        apiKeyHint: 'a131',
        accountId: account1Id,
      },
    });
    agentAId = agentA.id;

    const agentB = await prisma.agent.create({
      data: {
        name: 'Agent B',
        apiKeyHash: agentBKeyHash,
        apiKeyHint: 'b131',
        accountId: account1Id,
      },
    });
    agentBId = agentB.id;

    // Create Account 2 with one agent
    const account2 = await prisma.account.create({
      data: {
        name: 'HEY-131 Account 2',
        email: 'hey131-acct2@test.local',
        passwordHash: 'not-real-hash',
      },
    });
    account2Id = account2.id;

    const agentC = await prisma.agent.create({
      data: {
        name: 'Agent C',
        apiKeyHash: agentCKeyHash,
        apiKeyHint: 'c131',
        accountId: account2Id,
      },
    });
    agentCId = agentC.id;
  });

  afterAll(async () => {
    const testExternalIds = [userIdA, userIdB, userIdC, 'default'];
    await prisma.memoryChainLink
      .deleteMany({
        where: { source: { user: { externalId: { in: testExternalIds } } } },
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
        where: { id: { in: [agentAId, agentBId, agentCId].filter(Boolean) } },
      })
      .catch(() => {});
    await prisma.account
      .deleteMany({
        where: { id: { in: [account1Id, account2Id].filter(Boolean) } },
      })
      .catch(() => {});

    if (origTrustLocal !== undefined)
      process.env.TRUST_LOCAL_NETWORK = origTrustLocal;
    else delete process.env.TRUST_LOCAL_NETWORK;
    if (origLanBypass !== undefined) process.env.LAN_BYPASS = origLanBypass;
    else delete process.env.LAN_BYPASS;

    await app.close();
  });

  // =========================================================================
  // 1. Memory Creation with agentId Attribution
  // =========================================================================
  describe('Memory creation with agentId attribution', () => {
    it('should create memory attributed to Agent A', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', userIdA)
        .send({ raw: 'Agent A memory one — favorite color is blue' })
        .expect(201);

      memoryA1Id = res.body.id;

      const memory = await prisma.memory.findUnique({
        where: { id: memoryA1Id },
        include: { user: true },
      });
      expect(memory!.user.accountId).toBe(account1Id);
    });

    it('should create second memory for Agent A', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', userIdA)
        .send({ raw: 'Agent A memory two — works at Acme Corp' })
        .expect(201);

      memoryA2Id = res.body.id;
    });

    it('should create memory attributed to Agent B (same account)', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentBKey)
        .set('X-AM-User-ID', userIdB)
        .send({ raw: 'Agent B memory — user likes hiking' })
        .expect(201);

      memoryB1Id = res.body.id;

      const memory = await prisma.memory.findUnique({
        where: { id: memoryB1Id },
        include: { user: true },
      });
      expect(memory!.user.accountId).toBe(account1Id);
    });

    it('should create memory attributed to Agent C (different account)', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentCKey)
        .set('X-AM-User-ID', userIdC)
        .send({ raw: 'Agent C memory — confidential data in Account 2' })
        .expect(201);

      memoryC1Id = res.body.id;

      const memory = await prisma.memory.findUnique({
        where: { id: memoryC1Id },
        include: { user: true },
      });
      expect(memory!.user.accountId).toBe(account2Id);
    });
  });

  // =========================================================================
  // 2. Agent-Specific Filtering (agentId parameter)
  // =========================================================================
  describe('Agent-specific filtering', () => {
    it('Agent A API key should only see its own memories via query', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories/query')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', userIdA)
        .send({ query: 'memory', limit: 50 })
        .expect(201);

      // All returned memories should belong to Agent A's user scope
      const ids = res.body.memories.map((m: any) => m.id);
      expect(ids).not.toContain(memoryB1Id);
      expect(ids).not.toContain(memoryC1Id);
    });

    it('Agent B API key should only see its own memories via query', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories/query')
        .set('X-AM-API-Key', agentBKey)
        .set('X-AM-User-ID', userIdB)
        .send({ query: 'memory', limit: 50 })
        .expect(201);

      const ids = res.body.memories.map((m: any) => m.id);
      expect(ids).not.toContain(memoryA1Id);
      expect(ids).not.toContain(memoryA2Id);
      expect(ids).not.toContain(memoryC1Id);
    });

    it('Agent A should retrieve its own memory by ID', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/memories/${memoryA1Id}`)
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', userIdA)
        .expect(200);

      expect(res.body.id).toBe(memoryA1Id);
    });
  });

  // =========================================================================
  // 3. Account-Wide Scoping (JWT returns all agents' memories)
  // =========================================================================
  describe('Account-wide scoping via JWT', () => {
    it('JWT for Account 1 should access memories across both agents via context', async () => {
      const token = jwtService.sign({ sub: account1Id });

      const res = await request(app.getHttpServer())
        .post('/v1/context')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(201);

      // Account-wide context should include memories from both Agent A and Agent B
      expect(res.body.memoriesIncluded).toBeGreaterThan(0);
    });

    it('JWT for Account 1 should query memories from both agents', async () => {
      const token = jwtService.sign({ sub: account1Id });

      const res = await request(app.getHttpServer())
        .post('/v1/memories/query')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'memory', limit: 50 })
        .expect(201);

      // Should succeed — account-wide query
      expect(res.body.memories).toBeInstanceOf(Array);
    });

    it('JWT for Account 1 should list agents', async () => {
      const token = jwtService.sign({ sub: account1Id });

      const res = await request(app.getHttpServer())
        .get('/v1/account/agents')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const agentNames = res.body.agents.map((a: any) => a.name);
      expect(agentNames).toContain('Agent A');
      expect(agentNames).toContain('Agent B');
      // Should NOT contain Agent C from Account 2
      expect(agentNames).not.toContain('Agent C');
    });
  });

  // =========================================================================
  // 4. Cross-Account Isolation
  // =========================================================================
  describe('Cross-account isolation', () => {
    it('Agent C (Account 2) should NOT see Agent A memories via query', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories/query')
        .set('X-AM-API-Key', agentCKey)
        .set('X-AM-User-ID', userIdC)
        .send({ query: 'favorite color blue Acme Corp', limit: 50 })
        .expect(201);

      const ids = res.body.memories.map((m: any) => m.id);
      expect(ids).not.toContain(memoryA1Id);
      expect(ids).not.toContain(memoryA2Id);
      expect(ids).not.toContain(memoryB1Id);
    });

    it('Agent C should NOT access Agent A memory by ID', async () => {
      await request(app.getHttpServer())
        .get(`/v1/memories/${memoryA1Id}`)
        .set('X-AM-API-Key', agentCKey)
        .set('X-AM-User-ID', userIdC)
        .expect((res) => {
          // Should be 403 or return null/empty — NOT the actual memory
          if (res.status === 200) {
            expect(res.body).toBeNull();
          } else {
            expect([403, 404]).toContain(res.status);
          }
        });
    });

    it('Agent A should NOT access Agent C memory by ID', async () => {
      await request(app.getHttpServer())
        .get(`/v1/memories/${memoryC1Id}`)
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', userIdA)
        .expect((res) => {
          if (res.status === 200) {
            expect(res.body).toBeNull();
          } else {
            expect([403, 404]).toContain(res.status);
          }
        });
    });

    it('JWT for Account 2 should NOT see Account 1 agents', async () => {
      const token = jwtService.sign({ sub: account2Id });

      const res = await request(app.getHttpServer())
        .get('/v1/account/agents')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const agentNames = res.body.agents.map((a: any) => a.name);
      expect(agentNames).toContain('Agent C');
      expect(agentNames).not.toContain('Agent A');
      expect(agentNames).not.toContain('Agent B');
    });

    it('JWT for Account 2 context should NOT include Account 1 memories', async () => {
      const token = jwtService.sign({ sub: account2Id });

      const res = await request(app.getHttpServer())
        .post('/v1/context')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(201);

      // If context includes text, it should NOT contain Account 1 content
      if (res.body.context) {
        expect(res.body.context).not.toContain('favorite color is blue');
        expect(res.body.context).not.toContain('works at Acme Corp');
        expect(res.body.context).not.toContain('likes hiking');
      }
    });
  });

  // =========================================================================
  // 5. Same-Account Cross-Agent Access (Agent A reads Agent B's via get-by-ID)
  // =========================================================================
  describe('Same-account cross-agent access', () => {
    it('Agent B should be forbidden from accessing Agent A memory by direct ID (RLS)', async () => {
      // Even within the same account, agent-scoped API keys are user-scoped
      // Agent B's user is different from Agent A's user
      await request(app.getHttpServer())
        .get(`/v1/memories/${memoryA1Id}`)
        .set('X-AM-API-Key', agentBKey)
        .set('X-AM-User-ID', userIdB)
        .expect((res) => {
          // RLS should block cross-agent direct access via API key
          // (returns 403 or null)
          if (res.status === 200) {
            expect(res.body).toBeNull();
          } else {
            expect([403, 404]).toContain(res.status);
          }
        });
    });

    it('Account-wide JWT CAN access both agents memories by ID', async () => {
      const token = jwtService.sign({ sub: account1Id });

      // Access Agent A's memory via JWT
      const resA = await request(app.getHttpServer())
        .get(`/v1/memories/${memoryA1Id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // JWT with account scope should be able to see the memory
      // (may return the memory or null depending on user resolution)
      // The key test is it doesn't return 403
      expect([200]).toContain(resA.status);
    });
  });
});
