import { Test, TestingModule } from '@nestjs/testing';
import { ContractService } from './contract.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { DelegationLedgerService } from './delegation-ledger.service';

describe('ContractService', () => {
  let service: ContractService;
  let prisma: any;
  let ledger: any;

  const mockContract = {
    id: 'contract-1',
    userId: 'user-1',
    delegator: 'agent-a',
    delegate: 'agent-b',
    taskDescription: 'Deploy v2',
    status: 'PROPOSED',
    terms: { deadline: '2026-03-01', qualityCriteria: ['no regressions'] },
    result: null,
    verifiedAt: null,
    completedAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    tasks: [],
  };

  beforeEach(async () => {
    prisma = {
      delegationContract: {
        create: jest.fn().mockResolvedValue(mockContract),
        findMany: jest.fn().mockResolvedValue([mockContract]),
        findFirst: jest.fn().mockResolvedValue(mockContract),
        update: jest.fn().mockImplementation(({ data }) => ({
          ...mockContract,
          ...data,
        })),
      },
    };
    ledger = { recordEvent: jest.fn().mockResolvedValue({ id: 'event-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractService,
        { provide: PrismaService, useValue: prisma },
        { provide: DelegationLedgerService, useValue: ledger },
      ],
    }).compile();

    service = module.get<ContractService>(ContractService);
  });

  describe('create', () => {
    it('should create a contract in PROPOSED state', async () => {
      const result = await service.create('user-1', {
        delegator: 'agent-a',
        delegate: 'agent-b',
        taskDescription: 'Deploy v2',
        terms: { deadline: '2026-03-01' },
      });
      expect(result.status).toBe('PROPOSED');
      expect(ledger.recordEvent).toHaveBeenCalledWith('user-1', {
        eventType: 'CONTRACT_CREATED',
        source: 'ENGRAM',
        contractId: 'contract-1',
        agentId: 'agent-a',
        payload: expect.objectContaining({
          delegator: 'agent-a',
          delegate: 'agent-b',
          taskDescription: 'Deploy v2',
        }),
      });
    });
  });

  describe('update - state transitions', () => {
    it('should allow PROPOSED → ACCEPTED', async () => {
      await service.update('user-1', 'contract-1', {
        status: 'ACCEPTED',
      });
      expect(prisma.delegationContract.update).toHaveBeenCalled();
      expect(ledger.recordEvent).toHaveBeenCalledWith('user-1', {
        eventType: 'CONTRACT_ACCEPTED',
        source: 'ENGRAM',
        contractId: 'contract-1',
        agentId: 'agent-b',
        payload: expect.objectContaining({
          previousStatus: 'PROPOSED',
          status: 'ACCEPTED',
        }),
      });
    });

    it('should reject invalid transition PROPOSED → COMPLETED', async () => {
      await expect(
        service.update('user-1', 'contract-1', {
          status: 'COMPLETED',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow PROPOSED → REJECTED', async () => {
      await service.update('user-1', 'contract-1', {
        status: 'REJECTED',
      });
      expect(prisma.delegationContract.update).toHaveBeenCalled();
    });

    it('should set completedAt on COMPLETED', async () => {
      prisma.delegationContract.findFirst.mockResolvedValue({
        ...mockContract,
        status: 'IN_PROGRESS',
      });
      await service.update('user-1', 'contract-1', {
        status: 'COMPLETED',
      });
      expect(prisma.delegationContract.update).toHaveBeenCalledWith({
        where: { id: 'contract-1' },
        data: expect.objectContaining({
          completedAt: expect.any(Date),
        }),
      });
    });

    it('should throw if not found', async () => {
      prisma.delegationContract.findFirst.mockResolvedValue(null);
      await expect(
        service.update('user-1', 'nope', { status: 'ACCEPTED' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
