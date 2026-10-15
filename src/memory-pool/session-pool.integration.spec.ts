import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createHash } from 'crypto';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryPoolService } from './memory-pool.service';
import { MemoryPipelineService } from '../memory/memory-pipeline.service';

/**
 * ENG-57: End-to-end proof for session-specific and shared memory pools.
 *
 * This intentionally runs under src/ so normal CI `pnpm test` executes it.
 * The older test/*.e2e-spec.ts files only run via explicit test:e2e commands.
 */
describe('Session and shared memory pools integration (ENG-57)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let memoryPoolService: MemoryPoolService;

  const origTrustLocal = process.env.TRUST_LOCAL_NETWORK;
  const origLanBypass = process.env.LAN_BYPASS;

  const externalUserId = 'eng57-pool-e2e-user';
  const normalizedExternalUserId = externalUserId.toLowerCase();
  const accountEmail = 'eng57-session-pool-e2e@test.local';

  const agentAKey = 'sk-eng57-session-pool-agent-a';
  const agentBKey = 'sk-eng57-session-pool-agent-b';
  const agentAKeyHash = createHash('sha256').update(agentAKey).digest('hex');
  const agentBKeyHash = createHash('sha256').update(agentBKey).digest('hex');

  const parentSessionKey = 'agent:eng57:parent';
  const sessionBoxKey = 'agent:eng57:subagent:session-box';
  const sharedOwnerSessionKey = 'agent:eng57:subagent:shared-owner';
  const sharedConsumerSessionKey = 'agent:eng57:subagent:shared-consumer';

  let accountId: string;
  let internalUserId: string;
  let agentBId: string;

  beforeAll(async () => {
    process.env.TRUST_LOCAL_NETWORK = 'false';
    process.env.LAN_BYPASS = 'false';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MemoryPipelineService)
      .useValue({ extractAndEmbed: jest.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    memoryPoolService = app.get(MemoryPoolService);

    await cleanupTestData();

    const account = await prisma.account.create({
      data: {
        name: 'ENG-57 Session Pool E2E Account',
        email: accountEmail,
        passwordHash: 'not-real-hash',
      },
    });
    accountId = account.id;

    await prisma.agent.create({
      data: {
        name: 'ENG-57 Agent A',
        apiKeyHash: agentAKeyHash,
        apiKeyHint: '57-a',
        accountId,
      },
    });

    const agentB = await prisma.agent.create({
      data: {
        name: 'ENG-57 Agent B',
        apiKeyHash: agentBKeyHash,
        apiKeyHint: '57-b',
        accountId,
      },
    });
    agentBId = agentB.id;

    const user = await prisma.user.create({
      data: {
        accountId,
        externalId: normalizedExternalUserId,
      },
    });
    internalUserId = user.id;
  }, 30000);

  afterAll(async () => {
    try {
      if (prisma) await cleanupTestData();
    } finally {
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

      if (app) await app.close().catch(() => undefined);
    }
  }, 30000);

  it('proves agents can create a session-specific box and share a pool across agents', async () => {
    await registerSession(agentAKey, {
      sessionKey: parentSessionKey,
      taskDescription: 'Parent session for ENG-57 pool proof',
    });

    const sessionRes = await registerSession(agentAKey, {
      sessionKey: sessionBoxKey,
      parentKey: parentSessionKey,
      label: 'eng57-session-box',
      taskDescription: 'Create a specific box of session memories',
      // Simulates OpenClaw/docs sending the external X-AM-User-ID value.
      // The controller must normalize this to the authenticated internal user id.
      userId: externalUserId,
    });

    const taskPoolId = sessionRes.body.poolId;
    expect(taskPoolId).toEqual(expect.any(String));

    const taskPool = await prisma.memoryPool.findUnique({
      where: { id: taskPoolId },
    });
    expect(taskPool).toMatchObject({
      name: 'task:eng57-session-box',
      userId: internalUserId,
      visibility: 'SHARED',
      createdBy: sessionBoxKey,
    });

    const createMemoryRes = await request(app.getHttpServer())
      .post('/v1/memories')
      .set('X-AM-API-Key', agentAKey)
      .set('X-AM-User-ID', externalUserId)
      .send({
        raw: 'ENG-57 session box proof memory: agent A stores session-scoped context.',
        layer: 'SESSION',
        poolId: taskPoolId,
        agentSessionKey: sessionBoxKey,
      })
      .expect(201);

    const memoryId = createMemoryRes.body.id;
    const memory = await prisma.memory.findUnique({ where: { id: memoryId } });
    expect(memory).toMatchObject({
      userId: internalUserId,
      createdBySession: sessionBoxKey,
    });

    const poolsRes = await request(app.getHttpServer())
      .get('/v1/pools')
      .query({ visibility: 'SHARED' })
      .set('X-AM-API-Key', agentAKey)
      .set('X-AM-User-ID', externalUserId)
      .expect(200);

    const listedTaskPool = poolsRes.body.pools.find(
      (pool: any) => pool.id === taskPoolId,
    );
    expect(listedTaskPool).toMatchObject({
      id: taskPoolId,
      name: 'task:eng57-session-box',
      createdBySession: sessionBoxKey,
      memberCount: 1,
      grantCount: 2,
    });

    const membersRes = await request(app.getHttpServer())
      .get(`/v1/pools/${taskPoolId}/members`)
      .set('X-AM-API-Key', agentAKey)
      .set('X-AM-User-ID', externalUserId)
      .expect(200);

    expect(membersRes.body).toMatchObject({ total: 1 });
    expect(membersRes.body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memoryId,
          raw: expect.stringContaining('session box proof memory'),
          layer: 'SESSION',
          addedBy: sessionBoxKey,
        }),
      ]),
    );

    const attributionRes = await request(app.getHttpServer())
      .get(`/v1/memories/${memoryId}/attribution`)
      .set('X-AM-API-Key', agentAKey)
      .set('X-AM-User-ID', externalUserId)
      .expect(200);

    expect(attributionRes.body.createdBySession).toMatchObject({
      sessionKey: sessionBoxKey,
      parentSessionKey,
    });
    expect(attributionRes.body.pools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: taskPoolId,
          name: 'task:eng57-session-box',
          visibility: 'SHARED',
        }),
      ]),
    );

    await waitFor(async () => {
      const summaryRes = await request(app.getHttpServer())
        .get(`/v1/agent-sessions/${encodeURIComponent(sessionBoxKey)}/summary`)
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', externalUserId);
      expect(summaryRes.status).toBe(200);
      expect(summaryRes.body).toMatchObject({
        sessionKey: sessionBoxKey,
        memoriesCreated: 1,
        uniqueMemories: 1,
      });
    });

    const ownerSession = await registerSession(agentAKey, {
      sessionKey: sharedOwnerSessionKey,
      label: 'eng57-shared-owner',
      taskDescription: 'Own a shared memory pool',
      userId: externalUserId,
    });
    const consumerSession = await registerSession(agentBKey, {
      sessionKey: sharedConsumerSessionKey,
      label: 'eng57-shared-consumer',
      taskDescription: 'Consume a shared memory pool',
      userId: externalUserId,
    });

    const sharedPoolRes = await request(app.getHttpServer())
      .post('/v1/pools')
      .set('X-AM-API-Key', agentAKey)
      .set('X-AM-User-ID', externalUserId)
      .send({
        name: 'eng57-shared-agent-pool',
        userId: externalUserId,
        visibility: 'SHARED',
        description: 'ENG-57 pool shared between two agents',
        createdBy: sharedOwnerSessionKey,
      })
      .expect(201);

    const sharedPoolId = sharedPoolRes.body.id;
    expect(sharedPoolRes.body).toMatchObject({
      id: sharedPoolId,
      name: 'eng57-shared-agent-pool',
      visibility: 'SHARED',
      createdBySession: sharedOwnerSessionKey,
    });

    const storedSharedPool = await prisma.memoryPool.findUnique({
      where: { id: sharedPoolId },
    });
    expect(storedSharedPool?.userId).toBe(internalUserId);

    await request(app.getHttpServer())
      .post(`/v1/pools/${sharedPoolId}/grant`)
      .set('X-AM-API-Key', agentAKey)
      .set('X-AM-User-ID', externalUserId)
      .send({
        agentSessionId: consumerSession.body.id,
        permission: 'READ',
        grantedBy: sharedOwnerSessionKey,
      })
      .expect(201);

    const sharedMemoryRes = await request(app.getHttpServer())
      .post('/v1/memories')
      .set('X-AM-API-Key', agentAKey)
      .set('X-AM-User-ID', externalUserId)
      .send({
        raw: 'ENG-57 shared pool proof memory: agent B can consume this shared fact.',
        layer: 'SESSION',
        poolId: sharedPoolId,
        agentSessionKey: sharedOwnerSessionKey,
      })
      .expect(201);

    const sharedMemoryId = sharedMemoryRes.body.id;

    const sharedMembersRes = await request(app.getHttpServer())
      .get(`/v1/pools/${sharedPoolId}/members`)
      .set('X-AM-API-Key', agentBKey)
      .set('X-AM-User-ID', externalUserId)
      .expect(200);

    expect(sharedMembersRes.body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memoryId: sharedMemoryId,
          raw: expect.stringContaining('shared pool proof memory'),
          addedBy: sharedOwnerSessionKey,
        }),
      ]),
    );

    const grantsRes = await request(app.getHttpServer())
      .get(`/v1/pools/${sharedPoolId}/grants`)
      .set('X-AM-API-Key', agentBKey)
      .set('X-AM-User-ID', externalUserId)
      .expect(200);

    expect(grantsRes.body.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentSessionId: consumerSession.body.id,
          sessionKey: sharedConsumerSessionKey,
          permissions: 'READ',
        }),
      ]),
    );

    const consumerAccessiblePools =
      await memoryPoolService.getAccessiblePoolIds(
        sharedConsumerSessionKey,
        internalUserId,
        agentBId,
      );
    expect(consumerAccessiblePools).toContain(sharedPoolId);
    expect(consumerAccessiblePools).not.toContain(ownerSession.body.poolId);
  }, 30000);

  async function registerSession(
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/v1/agent-sessions')
      .set('X-AM-API-Key', apiKey)
      .set('X-AM-User-ID', externalUserId)
      .send(body)
      .expect((res) => {
        if (res.status !== 201) console.log('session create error', res.body);
      })
      .expect(201);
  }

  async function waitFor(
    assertion: () => Promise<void>,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const intervalMs = options.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() <= deadline) {
      try {
        await assertion();
        return;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    throw lastError;
  }

  async function cleanupTestData(): Promise<void> {
    const sessionKeys = [
      parentSessionKey,
      sessionBoxKey,
      sharedOwnerSessionKey,
      sharedConsumerSessionKey,
    ];
    const accountIds = [accountId].filter(Boolean);
    const userIds = [internalUserId].filter(Boolean);

    const users = await prisma.user.findMany({
      where: {
        OR: [
          { externalId: normalizedExternalUserId },
          ...(userIds.length ? [{ id: { in: userIds } }] : []),
        ],
      },
      select: { id: true },
    });
    const cleanupUserIds = users.map((user) => user.id);

    const accounts = await prisma.account.findMany({
      where: {
        OR: [
          { email: accountEmail },
          ...(accountIds.length ? [{ id: { in: accountIds } }] : []),
        ],
      },
      select: { id: true },
    });
    const cleanupAccountIds = accounts.map((account) => account.id);

    await prisma.memoryAccessLog
      .deleteMany({
        where: { agentSession: { sessionKey: { in: sessionKeys } } },
      })
      .catch(() => {});
    await prisma.memoryPoolMembership
      .deleteMany({
        where: {
          OR: [
            { pool: { userId: { in: cleanupUserIds } } },
            { addedBy: { in: sessionKeys } },
          ],
        },
      })
      .catch(() => {});
    await prisma.poolGrant
      .deleteMany({
        where: {
          OR: [
            { pool: { userId: { in: cleanupUserIds } } },
            { grantedBy: { in: sessionKeys } },
            { agentSession: { sessionKey: { in: sessionKeys } } },
          ],
        },
      })
      .catch(() => {});
    await prisma.memoryPool
      .deleteMany({
        where: {
          OR: [
            { userId: { in: cleanupUserIds } },
            { createdBy: { in: sessionKeys } },
          ],
        },
      })
      .catch(() => {});
    await prisma.memoryExtraction
      .deleteMany({
        where: { memory: { userId: { in: cleanupUserIds } } },
      })
      .catch(() => {});
    await prisma.memoryChainLink
      .deleteMany({
        where: {
          OR: [
            { source: { userId: { in: cleanupUserIds } } },
            { target: { userId: { in: cleanupUserIds } } },
          ],
        },
      })
      .catch(() => {});
    await prisma.memory
      .deleteMany({ where: { userId: { in: cleanupUserIds } } })
      .catch(() => {});
    await prisma.agentSession
      .deleteMany({ where: { sessionKey: { in: sessionKeys } } })
      .catch(() => {});
    await prisma.user
      .deleteMany({ where: { id: { in: cleanupUserIds } } })
      .catch(() => {});
    await prisma.agent
      .deleteMany({
        where: {
          OR: [
            { apiKeyHash: { in: [agentAKeyHash, agentBKeyHash] } },
            ...(cleanupAccountIds.length
              ? [{ accountId: { in: cleanupAccountIds } }]
              : []),
          ],
        },
      })
      .catch(() => {});
    await prisma.account
      .deleteMany({ where: { id: { in: cleanupAccountIds } } })
      .catch(() => {});
  }
});
