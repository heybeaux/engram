import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { DelegationLedgerService } from './delegation-ledger.service';
import { PrismaService } from '../prisma/prisma.service';

function withReceiptHash(receipt: Record<string, any>) {
  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ ...receipt, integrity: undefined }))
    .digest('hex');
  return {
    ...receipt,
    integrity: {
      algorithm: 'sha256',
      receipt_payload_sha256: payloadHash,
      artifacts: [{ path: 'test.log', sha256: 'artifact-hash' }],
    },
  };
}

describe('DelegationLedgerService', () => {
  let service: DelegationLedgerService;
  let prisma: any;

  const contract = {
    id: 'contract-1',
    userId: 'user-1',
    delegator: 'nori',
    delegate: 'rook',
    taskDescription: 'Review production dashboard regressions',
    status: 'IN_PROGRESS',
  };

  const task = {
    id: 'task-1',
    userId: 'user-1',
    assignedBy: 'nori',
    assignedTo: 'rook',
    taskDescription: 'Review production dashboard regressions',
    status: 'COMPLETED',
    contractId: 'contract-1',
  };

  beforeEach(async () => {
    prisma = {
      delegationContract: {
        findFirst: jest.fn().mockResolvedValue(contract),
      },
      delegatedTask: {
        findFirst: jest.fn().mockResolvedValue(task),
        findMany: jest.fn().mockResolvedValue([]),
      },
      delegationEvent: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: `event-${prisma.delegationEvent.create.mock.calls.length}`,
            ...data,
          }),
        ),
      },
      delegationValidation: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: 'validation-1',
            createdAt: new Date(),
            ...data,
          }),
        ),
      },
      delegationReceipt: {
        upsert: jest.fn().mockImplementation(({ create }) =>
          Promise.resolve({
            id: 'delegation-receipt-1',
            createdAt: new Date(),
            ...create,
          }),
        ),
      },
      trustSignal: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: `signal-${prisma.trustSignal.create.mock.calls.length}`,
            ...data,
          }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DelegationLedgerService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(DelegationLedgerService);
  });

  describe('recordValidation', () => {
    it('stores a Lattice validation, emits lifecycle events, and creates a trust success signal for a clean pass', async () => {
      const result = await service.recordValidation('user-1', 'contract-1', {
        taskId: 'task-1',
        stateContract: {
          id: 'lattice-contract-1',
          traceId: 'trace-1',
          fromAgent: 'nori',
          toAgent: 'rook',
          metadata: {
            l0: {
              evidence: [{ ruleId: 'expected-output', outcome: 'pass' }],
            },
          },
        },
        validationResult: {
          passed: true,
          tier: 'L0+L1',
          tiersRun: ['L0', 'L1'],
          durationMs: 17,
          confidence: 0.98,
        },
      });

      expect(result).toMatchObject({
        contractId: 'contract-1',
        taskId: 'task-1',
        latticeContractId: 'lattice-contract-1',
        traceId: 'trace-1',
        passed: true,
        tier: 'L0+L1',
        tiersRun: ['L0', 'L1'],
        providerFailure: false,
      });
      expect(prisma.delegationValidation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          evidence: [{ ruleId: 'expected-output', outcome: 'pass' }],
          stateContract: expect.objectContaining({ id: 'lattice-contract-1' }),
          validationResult: expect.objectContaining({ passed: true }),
        }),
      });
      expect(prisma.delegationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'HANDOFF_VALIDATED',
          source: 'LATTICE',
          contractId: 'contract-1',
          taskId: 'task-1',
          agentId: 'rook',
          traceId: 'trace-1',
        }),
      });
      expect(prisma.trustSignal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          agentId: 'rook',
          signalType: 'SUCCESS',
          category: 'delegation',
          weight: 0.7,
          metadata: expect.objectContaining({
            source: 'delegation_validation',
            contractId: 'contract-1',
            delegationTaskId: 'task-1',
            validationId: 'validation-1',
          }),
        }),
      });
    });

    it('creates a failure trust signal for failed validation evidence', async () => {
      await service.recordValidation('user-1', 'contract-1', {
        stateContract: { id: 'lattice-contract-2' },
        validationResult: {
          passed: false,
          tier: 'L1',
          reason: 'required output missing',
        },
      });

      expect(prisma.trustSignal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          agentId: 'rook',
          signalType: 'FAILURE',
          weight: 1,
          context: expect.stringContaining('required output missing'),
        }),
      });
    });

    it('does not award success trust for provider-degraded passes', async () => {
      await service.recordValidation('user-1', 'contract-1', {
        stateContract: { id: 'lattice-contract-3' },
        validationResult: {
          passed: true,
          tier: 'L2',
          providerFailure: true,
        },
      });

      expect(prisma.delegationValidation.create).toHaveBeenCalled();
      expect(prisma.trustSignal.create).not.toHaveBeenCalled();
    });
  });

  describe('attachReceipt', () => {
    it('stores receipt proof, verifies payload integrity, emits event, and awards trust for self-verified receipts', async () => {
      const receipt = withReceiptHash({
        id: 'rcpt_123',
        status: 'self-verified',
        claim: { summary: 'Dashboard QA completed' },
        actor: { id: 'rook', model: 'sakana/fugu' },
        verification: {
          summary: 'All focused checks passed',
          checks: [{ name: 'jest', status: 'passed' }],
        },
        risk: { level: 'low' },
      });

      const result = await service.attachReceipt('user-1', 'task-1', {
        receipt,
      });

      expect(result).toMatchObject({
        receiptId: 'rcpt_123',
        taskId: 'task-1',
        contractId: 'contract-1',
        status: 'self-verified',
        claimSummary: 'Dashboard QA completed',
        actorId: 'rook',
        actorModel: 'sakana/fugu',
        integrityStatus: 'clean',
      });
      expect(prisma.delegationReceipt.upsert).toHaveBeenCalledWith({
        where: {
          userId_receiptId: { userId: 'user-1', receiptId: 'rcpt_123' },
        },
        create: expect.objectContaining({
          checks: [{ name: 'jest', status: 'passed' }],
          artifactHashes: [{ path: 'test.log', sha256: 'artifact-hash' }],
        }),
        update: expect.objectContaining({ status: 'self-verified' }),
      });
      expect(prisma.delegationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'RECEIPT_ATTACHED',
          source: 'RECEIPTS',
          taskId: 'task-1',
          agentId: 'rook',
        }),
      });
      expect(prisma.trustSignal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          agentId: 'rook',
          signalType: 'SUCCESS',
          weight: 1.3,
          metadata: expect.objectContaining({
            source: 'delegation_receipt',
            delegationTaskId: 'task-1',
            delegationReceiptId: 'delegation-receipt-1',
            receiptStatus: 'self-verified',
            integrityStatus: 'clean',
          }),
        }),
      });
    });

    it('records failed receipt checks as failure trust evidence', async () => {
      const receipt = withReceiptHash({
        id: 'rcpt_failed',
        status: 'needs-review',
        claim: { summary: 'Regression fix complete' },
        actor: { id: 'rook' },
        verification: {
          checks: [{ name: 'build', status: 'failed' }],
        },
      });

      await service.attachReceipt('user-1', 'task-1', { receipt });

      expect(prisma.trustSignal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          signalType: 'FAILURE',
          weight: 1.2,
          context: expect.stringContaining('failed check'),
        }),
      });
    });

    it('does not award trust when receipt checks are pending or not-run', async () => {
      const receipt = withReceiptHash({
        id: 'rcpt_pending',
        status: 'needs-review',
        claim: { summary: 'Work allegedly complete' },
        verification: {
          checks: [
            { name: 'build', status: 'passed' },
            { name: 'deploy', status: 'not-run' },
          ],
        },
      });

      await service.attachReceipt('user-1', 'task-1', { receipt });

      expect(prisma.delegationReceipt.upsert).toHaveBeenCalled();
      expect(prisma.trustSignal.create).not.toHaveBeenCalled();
    });
  });
});
