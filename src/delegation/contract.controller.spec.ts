import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ContractController } from './contract.controller';
import { ContractService } from './contract.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

const mockContract = {
  id: 'contract-1',
  userId: 'user-1',
  delegator: 'agent-a',
  delegate: 'agent-b',
  taskDescription: 'Deploy v2',
  status: 'PROPOSED',
  terms: {},
  result: null,
  verifiedAt: null,
  completedAt: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockContractService = {
  create: jest.fn().mockResolvedValue(mockContract),
  findAll: jest.fn().mockResolvedValue([mockContract]),
  findOne: jest.fn().mockResolvedValue(mockContract),
  update: jest.fn().mockResolvedValue({ ...mockContract, status: 'ACTIVE' }),
};

describe('ContractController', () => {
  let controller: ContractController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ContractController],
      providers: [
        { provide: ContractService, useValue: mockContractService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ContractController>(ContractController);
  });

  describe('create', () => {
    it('should delegate to contractService.create with userId and dto', async () => {
      const dto = {
        delegator: 'agent-a',
        delegate: 'agent-b',
        taskDescription: 'Deploy v2',
        terms: {},
      };
      const result = await controller.create('user-1', dto as any);
      expect(mockContractService.create).toHaveBeenCalledWith('user-1', dto);
      expect(result).toEqual(mockContract);
    });

    it('should propagate service errors', async () => {
      mockContractService.create.mockRejectedValueOnce(
        new Error('Validation failed'),
      );
      await expect(controller.create('user-1', {} as any)).rejects.toThrow(
        'Validation failed',
      );
    });
  });

  describe('findAll', () => {
    it('should return all contracts for the user', async () => {
      const result = await controller.findAll('user-1');
      expect(mockContractService.findAll).toHaveBeenCalledWith('user-1', undefined);
      expect(result).toEqual([mockContract]);
    });

    it('should pass status filter when provided', async () => {
      await controller.findAll('user-1', 'ACTIVE');
      expect(mockContractService.findAll).toHaveBeenCalledWith('user-1', 'ACTIVE');
    });

    it('should return empty array when no contracts exist', async () => {
      mockContractService.findAll.mockResolvedValueOnce([]);
      const result = await controller.findAll('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('findOne', () => {
    it('should return a single contract by id', async () => {
      const result = await controller.findOne('user-1', 'contract-1');
      expect(mockContractService.findOne).toHaveBeenCalledWith('user-1', 'contract-1');
      expect(result).toEqual(mockContract);
    });

    it('should propagate NotFoundException from service', async () => {
      mockContractService.findOne.mockRejectedValueOnce(
        new NotFoundException('Not found'),
      );
      await expect(controller.findOne('user-1', 'bad-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('should delegate update to service with userId, id, and dto', async () => {
      const dto = { status: 'ACTIVE' };
      const result = await controller.update('user-1', 'contract-1', dto as any);
      expect(mockContractService.update).toHaveBeenCalledWith(
        'user-1',
        'contract-1',
        dto,
      );
      expect(result.status).toBe('ACTIVE');
    });

    it('should propagate service errors on update', async () => {
      mockContractService.update.mockRejectedValueOnce(new Error('Forbidden'));
      await expect(
        controller.update('user-1', 'contract-1', {} as any),
      ).rejects.toThrow('Forbidden');
    });
  });
});
