import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createHash } from 'crypto';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';

/**
 * End-to-end proof for delegation ledger infrastructure.
 *
 * This exercises the actual HTTP/API path an agent orchestration layer would
 * use: delegator creates a contract/task, delegate discovers and completes it,
 * Lattice validation evidence and a Receipt are attached, and Engram reports
 * the resulting trust chain.
 */
describe('Delegation Ledger E2E', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const origTrustLocal = process.env.TRUST_LOCAL_NETWORK;
  const origLanBypass = process.env.LAN_BYPASS;

  const delegatorKey = 'sk-delegation-e2e-delegator';
  const delegateKey = 'sk-delegation-e2e-delegate';
  const otherAccountKey = 'sk-delegation-e2e-other';
  const delegatorKeyHash = createHash('sha256')
    .update(delegatorKey)
    .digest('hex');
  const delegateKeyHash = createHash('sha256')
    .update(delegateKey)
    .digest('hex');
  const otherAccountKeyHash = createHash('sha256')
    .update(otherAccountKey)
    .digest('hex');

  const externalUserId = 'delegation-ledger-e2e-user';
  const otherExternalUserId = 'delegation-ledger-e2e-other-user';

  let accountId: string;
  let otherAccountId: string;
  let delegatorAgentId: string;
  let delegateAgentId: string;
  let contractId: string;
  let taskId: string;

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
    await cleanupTestData();

    const account = await prisma.account.create({
      data: {
        name: 'Delegation Ledger E2E Account',
        email: 'delegation-ledger-e2e@test.local',
        passwordHash: 'not-real-hash',
      },
    });
    accountId = account.id;

    const delegator = await prisma.agent.create({
      data: {
        name: 'Delegation E2E Delegator',
        apiKeyHash: delegatorKeyHash,
        apiKeyHint: 'dlee-delegator',
        accountId,
      },
    });
    delegatorAgentId = delegator.id;

    const delegate = await prisma.agent.create({
      data: {
        name: 'Delegation E2E Delegate',
        apiKeyHash: delegateKeyHash,
        apiKeyHint: 'dlee-delegate',
        accountId,
      },
    });
    delegateAgentId = delegate.id;

    const otherAccount = await prisma.account.create({
      data: {
        name: 'Delegation Ledger E2E Other Account',
        email: 'delegation-ledger-e2e-other@test.local',
        passwordHash: 'not-real-hash',
      },
    });
    otherAccountId = otherAccount.id;

    await prisma.agent.create({
      data: {
        name: 'Delegation E2E Other Agent',
        apiKeyHash: otherAccountKeyHash,
        apiKeyHint: 'dlee-other',
        accountId: otherAccountId,
      },
    });
  });

  afterAll(async () => {
    await cleanupTestData();

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

  it('tracks delegation from assignment through completion evidence and trust reports', async () => {
    const contractRes = await request(app.getHttpServer())
      .post('/v1/delegation/contracts')
      .set('X-AM-API-Key', delegatorKey)
      .set('X-AM-User-ID', externalUserId)
      .send({
        delegator: delegatorAgentId,
        delegate: delegateAgentId,
        taskDescription: 'Delegate a real end-to-end proof task',
        terms: {
          qualityCriteria: [
            'Delegate can discover assigned task',
            'Result is backed by Lattice validation and Receipt evidence',
          ],
          escalationRules: ['Return failed validation to delegator'],
        },
        metadata: { scenario: 'delegation-ledger-e2e' },
      })
      .expect((res) => {
        if (res.status !== 201) console.log('contract create error', res.body);
      })
      .expect(201);

    contractId = contractRes.body.id;
    expect(contractRes.body.status).toBe('PROPOSED');

    await request(app.getHttpServer())
      .patch(`/v1/delegation/contracts/${contractId}`)
      .set('X-AM-API-Key', delegateKey)
      .set('X-AM-User-ID', externalUserId)
      .send({ status: 'ACCEPTED' })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/v1/delegation/contracts/${contractId}`)
      .set('X-AM-API-Key', delegatorKey)
      .set('X-AM-User-ID', externalUserId)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    const taskRes = await request(app.getHttpServer())
      .post('/v1/delegation/tasks')
      .set('X-AM-API-Key', delegatorKey)
      .set('X-AM-User-ID', externalUserId)
      .send({
        assignedTo: delegateAgentId,
        assignedBy: delegatorAgentId,
        taskDescription: 'Produce the delegation proof artifact',
        contractId,
        metadata: { scenario: 'delegation-ledger-e2e' },
      })
      .expect(201);

    taskId = taskRes.body.id;
    expect(taskRes.body.status).toBe('ASSIGNED');

    const delegateQueueRes = await request(app.getHttpServer())
      .get('/v1/delegation/tasks')
      .query({ assignedTo: delegateAgentId })
      .set('X-AM-API-Key', delegateKey)
      .set('X-AM-User-ID', externalUserId)
      .expect(200);

    expect(delegateQueueRes.body.map((task: any) => task.id)).toContain(taskId);

    await request(app.getHttpServer())
      .patch(`/v1/delegation/tasks/${taskId}`)
      .set('X-AM-API-Key', delegateKey)
      .set('X-AM-User-ID', externalUserId)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/v1/delegation/tasks/${taskId}`)
      .set('X-AM-API-Key', delegateKey)
      .set('X-AM-User-ID', externalUserId)
      .send({
        status: 'COMPLETED',
        result: 'Delegate completed the proof artifact and attached evidence.',
      })
      .expect(200);

    const validationRes = await request(app.getHttpServer())
      .post(`/v1/delegation/contracts/${contractId}/validations`)
      .set('X-AM-API-Key', delegatorKey)
      .set('X-AM-User-ID', externalUserId)
      .send({
        taskId,
        stateContract: {
          id: 'lat_delegate_proof_001',
          schemaVersion: '0.1.0',
          traceId: 'trace-delegation-ledger-e2e',
          fromAgent: delegatorAgentId,
          toAgent: delegateAgentId,
          inputs: { payload: { taskId }, contentType: 'application/json' },
          outputs: {
            payload: { result: 'proof artifact complete' },
            contentType: 'application/json',
          },
          metadata: {
            l0: {
              ruleSetId: 'delegation-proof-rules',
              evidence: [
                {
                  ruleId: 'task-has-result',
                  kind: 'jsonpath',
                  outcome: 'pass',
                  jsonpath: '$.outputs.payload.result',
                },
              ],
            },
          },
        },
        validationResult: {
          passed: true,
          tier: 'L0+L1',
          tiersRun: ['L0', 'L1'],
          durationMs: 12,
          confidence: 0.99,
        },
      })
      .expect(201);

    expect(validationRes.body.passed).toBe(true);
    expect(validationRes.body.providerFailure).toBe(false);

    const receipt: any = {
      schema_version: '1.0.0',
      id: 'rcpt_delegation_ledger_e2e',
      status: 'self-verified',
      claim: {
        summary: 'Delegate completed the assigned proof task',
      },
      actor: {
        type: 'agent',
        id: delegateAgentId,
        model: 'test-delegate',
      },
      task: {
        id: taskId,
        description: 'Produce the delegation proof artifact',
      },
      verification: {
        summary: 'All proof checks passed',
        checks: [
          {
            name: 'delegated task completed',
            status: 'passed',
            evidence: 'Task transitioned to COMPLETED',
          },
          {
            name: 'lattice validation passed',
            status: 'passed',
            evidence: validationRes.body.id,
          },
        ],
      },
      risk: {
        level: 'low',
        notes: 'E2E proof only; no production side effects.',
      },
    };
    receipt.integrity = {
      receipt_payload_sha256: createHash('sha256')
        .update(JSON.stringify({ ...receipt, integrity: undefined }))
        .digest('hex'),
      artifacts: [],
    };

    const receiptRes = await request(app.getHttpServer())
      .post(`/v1/delegation/tasks/${taskId}/receipts`)
      .set('X-AM-API-Key', delegateKey)
      .set('X-AM-User-ID', externalUserId)
      .send({ contractId, receipt })
      .expect(201);

    expect(receiptRes.body.status).toBe('self-verified');
    expect(receiptRes.body.integrityStatus).toBe('clean');

    const reportRes = await request(app.getHttpServer())
      .get(`/v1/delegation/tasks/${taskId}/trust-report`)
      .set('X-AM-API-Key', delegatorKey)
      .set('X-AM-User-ID', externalUserId)
      .expect(200);

    expect(reportRes.body.task.id).toBe(taskId);
    expect(reportRes.body.status).toBe('COMPLETED');
    expect(reportRes.body.contract.id).toBe(contractId);
    expect(reportRes.body.currentBlocker).toBeNull();
    expect(reportRes.body.evidenceSummary).toMatchObject({
      validationCount: 1,
      receiptCount: 1,
      hasCleanValidation: true,
      hasSelfVerifiedReceipt: true,
    });
    expect(reportRes.body.trustSummary).toMatchObject({
      signalCount: 2,
      successCount: 2,
      failureCount: 0,
      correctionCount: 0,
      weightedTotal: 2,
    });

    const eventTypes = reportRes.body.events.map(
      (event: any) => event.eventType,
    );
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'CONTRACT_CREATED',
        'CONTRACT_ACCEPTED',
        'CONTRACT_STARTED',
        'TASK_ASSIGNED',
        'TASK_STARTED',
        'TASK_COMPLETED',
        'HANDOFF_VALIDATED',
        'RECEIPT_ATTACHED',
        'TRUST_SCORED',
      ]),
    );

    const signalSources = reportRes.body.trustSignals.map(
      (signal: any) => signal.metadata?.source,
    );
    expect(signalSources).toEqual(
      expect.arrayContaining(['delegation_validation', 'delegation_receipt']),
    );

    const agentReportRes = await request(app.getHttpServer())
      .get(`/v1/delegation/trust-reports/${delegateAgentId}`)
      .set('X-AM-API-Key', delegateKey)
      .set('X-AM-User-ID', externalUserId)
      .expect(200);

    expect(agentReportRes.body.agentId).toBe(delegateAgentId);
    expect(agentReportRes.body.tasks.map((task: any) => task.id)).toContain(
      taskId,
    );
    expect(agentReportRes.body.trustSummary.successCount).toBe(2);
  });

  it('prevents another account from reading the delegation trust report', async () => {
    await request(app.getHttpServer())
      .get(`/v1/delegation/tasks/${taskId}/trust-report`)
      .set('X-AM-API-Key', otherAccountKey)
      .set('X-AM-User-ID', otherExternalUserId)
      .expect(404);
  });

  async function cleanupTestData() {
    const accountIds = (
      await prisma.account.findMany({
        where: {
          email: {
            in: [
              'delegation-ledger-e2e@test.local',
              'delegation-ledger-e2e-other@test.local',
            ],
          },
        },
        select: { id: true },
      })
    ).map((account) => account.id);

    const userFilters: any[] = [
      { externalId: { in: [externalUserId, otherExternalUserId] } },
    ];
    if (accountIds.length) userFilters.push({ accountId: { in: accountIds } });

    const users = await prisma.user.findMany({
      where: { OR: userFilters },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);

    if (userIds.length) {
      await prisma.trustSignal.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.delegationReceipt.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.delegationValidation.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.delegationEvent.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.delegatedTask.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.delegationContract.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }

    await prisma.agent.deleteMany({
      where: {
        apiKeyHash: {
          in: [delegatorKeyHash, delegateKeyHash, otherAccountKeyHash],
        },
      },
    });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
});
