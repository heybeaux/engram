import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createHash } from 'crypto';
import { EmbeddingService } from '../src/memory/embedding.service';

/**
 * Phase 3 Integration Tests: Pool-Filtered Recall
 *
 * Tests:
 * 1. Creating a memory with agentSessionKey sets createdBySession
 * 2. Creating a memory auto-adds to global pool
 * 3. Recall with agentSessionKey filters by accessible pools
 * 4. Recall without agentSessionKey is backward compatible (no filtering)
 */
describe('Pool-Filtered Recall (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const testApiKey = 'sk-test-pool-recall-e2e';
  const testApiKeyHash = createHash('sha256').update(testApiKey).digest('hex');
  const testUserId = 'test-user-pool-recall';
  let testInternalUserId: string;
  let globalPoolId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    prisma = app.get(PrismaService);

    // Clean up existing test data
    try {
      const existingUser = await prisma.user.findFirst({
        where: { externalId: testUserId },
      });
      if (existingUser) {
        // Clean pool memberships, pools, memories, etc.
        await (prisma as any).memoryPoolMembership.deleteMany({
          where: { pool: { userId: existingUser.id } },
        });
        await (prisma as any).memoryPool.deleteMany({
          where: { userId: existingUser.id },
        });
        await (prisma as any).memoryAccessLog.deleteMany({
          where: { agentSession: { sessionKey: { startsWith: 'agent:test' } } },
        });
        await prisma.memory.deleteMany({
          where: { userId: existingUser.id },
        });
        await prisma.user.deleteMany({ where: { externalId: testUserId } });
      }
    } catch (e) {
      // Ignore cleanup errors
    }

    await prisma.agent.deleteMany({ where: { apiKeyHash: testApiKeyHash } });
    await (prisma as any).agentSession.deleteMany({
      where: { sessionKey: { startsWith: 'agent:test' } },
    });

    // Create test agent + user
    const agent = await prisma.agent.create({
      data: {
        name: 'Pool Recall E2E Agent',
        apiKeyHash: testApiKeyHash,
        apiKeyHint: testApiKey.slice(-4),
      },
    });

    const user = await prisma.user.create({
      data: {
        externalId: testUserId,
        agentId: agent.id,
      },
    });
    testInternalUserId = user.id;

    // Create global pool for user
    const pool = await (prisma as any).memoryPool.create({
      data: {
        name: 'global',
        userId: testInternalUserId,
        visibility: 'GLOBAL',
        createdBy: 'agent:test:main',
      },
    });
    globalPoolId = pool.id;

    // Create agent session
    await (prisma as any).agentSession.upsert({
      where: { sessionKey: 'agent:test:main' },
      update: {},
      create: {
        sessionKey: 'agent:test:main',
        status: 'ACTIVE',
      },
    });
  }, 30000);

  afterAll(async () => {
    // Cleanup
    try {
      await (prisma as any).memoryAccessLog.deleteMany({
        where: { agentSession: { sessionKey: { startsWith: 'agent:test' } } },
      });
      await (prisma as any).memoryPoolMembership.deleteMany({
        where: { pool: { userId: testInternalUserId } },
      });
      await (prisma as any).memoryPool.deleteMany({
        where: { userId: testInternalUserId },
      });
      await prisma.memory.deleteMany({
        where: { userId: testInternalUserId },
      });
      await prisma.user.deleteMany({ where: { externalId: testUserId } });
      await prisma.agent.deleteMany({ where: { apiKeyHash: testApiKeyHash } });
      await (prisma as any).agentSession.deleteMany({
        where: { sessionKey: { startsWith: 'agent:test' } },
      });
    } catch (e) {
      // Ignore
    }
    await app.close();
  }, 15000);

  describe('Memory creation with agentSessionKey', () => {
    it('should set createdBySession when agentSessionKey is provided', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('x-user-id', testUserId)
        .send({
          raw: 'Pool test: Beaux prefers TypeScript over JavaScript',
          layer: 'IDENTITY',
          agentSessionKey: 'agent:test:main',
        })
        .expect(201);

      // Verify createdBySession was set
      const memory = await prisma.memory.findUnique({
        where: { id: res.body.id },
      });
      expect((memory as any).createdBySession).toBe('agent:test:main');
    });

    it('should auto-add memory to global pool', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('x-user-id', testUserId)
        .send({
          raw: 'Pool test: Auto-pool membership check',
          layer: 'IDENTITY',
          agentSessionKey: 'agent:test:main',
        })
        .expect(201);

      // Wait a bit for the async pool add
      await new Promise((r) => setTimeout(r, 500));

      // Verify pool membership
      const membership = await (prisma as any).memoryPoolMembership.findFirst({
        where: {
          memoryId: res.body.id,
          poolId: globalPoolId,
        },
      });
      expect(membership).not.toBeNull();
      expect(membership.addedBy).toBe('agent:test:main');
    });

    it('should NOT set createdBySession when agentSessionKey is not provided', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('x-user-id', testUserId)
        .send({
          raw: 'Pool test: No session key memory',
          layer: 'SESSION',
        })
        .expect(201);

      const memory = await prisma.memory.findUnique({
        where: { id: res.body.id },
      });
      expect((memory as any).createdBySession).toBeNull();
    });
  });

  describe('Recall backward compatibility', () => {
    it('should recall without agentSessionKey (no pool filtering)', async () => {
      // Create a memory first
      await request(app.getHttpServer())
        .post('/v1/memories')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('x-user-id', testUserId)
        .send({
          raw: 'Pool test: backward compatible recall test memory',
          layer: 'IDENTITY',
        })
        .expect(201);

      // Wait for embedding
      await new Promise((r) => setTimeout(r, 2000));

      // Recall without agentSessionKey — should work normally
      const res = await request(app.getHttpServer())
        .post('/v1/memories/query')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('x-user-id', testUserId)
        .send({
          query: 'backward compatible recall test',
          limit: 5,
        })
        .expect(201);

      expect(res.body.memories).toBeDefined();
      expect(res.body.memories.length).toBeGreaterThan(0);
    }, 15000);

    it('should recall with agentSessionKey (pool-filtered)', async () => {
      // Create a memory with session key (will be added to global pool)
      await request(app.getHttpServer())
        .post('/v1/memories')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('x-user-id', testUserId)
        .send({
          raw: 'Pool test: session filtered recall unique marker xyz789',
          layer: 'IDENTITY',
          agentSessionKey: 'agent:test:main',
        })
        .expect(201);

      // Wait for embedding + pool add
      await new Promise((r) => setTimeout(r, 2000));

      // Recall with agentSessionKey — should filter to accessible pools
      const res = await request(app.getHttpServer())
        .post('/v1/memories/query')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('x-user-id', testUserId)
        .send({
          query: 'session filtered recall unique marker xyz789',
          limit: 5,
          agentSessionKey: 'agent:test:main',
        })
        .expect(201);

      expect(res.body.memories).toBeDefined();
      // The memory should be found because it's in the global pool
      // which is accessible to all sessions
      expect(res.body.memories.length).toBeGreaterThan(0);
    }, 15000);
  });

  describe('Pool-scoped recall isolation', () => {
    it('should not return memories outside accessible pools', async () => {
      // Create a private pool for a different session
      const privatePool = await (prisma as any).memoryPool.create({
        data: {
          name: 'private-test-pool',
          userId: testInternalUserId,
          visibility: 'PRIVATE',
          createdBy: 'agent:test:other-session',
        },
      });

      // Create a memory and add ONLY to the private pool (not global)
      const memory = await prisma.memory.create({
        data: {
          userId: testInternalUserId,
          raw: 'Pool test: secret memory only in private pool zzzxxx123',
          layer: 'IDENTITY',
          importanceScore: 0.9,
          createdBySession: 'agent:test:other-session',
        } as any,
      });

      // Generate and store embedding for this memory
      const embeddingService = app.get(EmbeddingService);
      const emb = await embeddingService.generate(memory.raw);
      await embeddingService.store(memory.id, emb, {
        userId: testInternalUserId,
        layer: memory.layer as any,
        importance: memory.importanceScore,
      });

      // Add to private pool only
      await (prisma as any).memoryPoolMembership.create({
        data: {
          memoryId: memory.id,
          poolId: privatePool.id,
          addedBy: 'agent:test:other-session',
        },
      });

      // Recall as agent:test:main — should NOT see the private pool memory
      const res = await request(app.getHttpServer())
        .post('/v1/memories/query')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('x-user-id', testUserId)
        .send({
          query: 'secret memory only in private pool zzzxxx123',
          limit: 5,
          agentSessionKey: 'agent:test:main',
        })
        .expect(201);

      // The secret memory should NOT appear because agent:test:main
      // doesn't have access to agent:test:other-session's private pool
      const found = res.body.memories.find((m: any) => m.id === memory.id);
      expect(found).toBeUndefined();

      // Cleanup
      await (prisma as any).memoryPoolMembership.deleteMany({
        where: { poolId: privatePool.id },
      });
      await (prisma as any).memoryPool.delete({
        where: { id: privatePool.id },
      });
    }, 15000);
  });
});
