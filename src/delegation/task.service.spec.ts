import { Test, TestingModule } from '@nestjs/testing';
import { TaskService } from './task.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';
import { DelegationLedgerService } from './delegation-ledger.service';

describe('TaskService', () => {
  let service: TaskService;
  let prisma: any;
  let ledger: any;

  const mockTask = {
    id: 'task-1',
    userId: 'user-1',
    assignedTo: 'agent-b',
    assignedBy: 'agent-a',
    taskDescription: 'Review PR #42',
    status: 'ASSIGNED',
    deadline: null,
    completedAt: null,
    result: null,
    metadata: null,
    memoryId: null,
    templateId: null,
    contractId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    prisma = {
      delegatedTask: {
        create: jest.fn().mockResolvedValue(mockTask),
        findFirst: jest.fn().mockResolvedValue(mockTask),
        findMany: jest.fn().mockResolvedValue([mockTask]),
        update: jest
          .fn()
          .mockResolvedValue({ ...mockTask, status: 'IN_PROGRESS' }),
      },
    };
    ledger = { recordEvent: jest.fn().mockResolvedValue({ id: 'event-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: PrismaService, useValue: prisma },
        { provide: DelegationLedgerService, useValue: ledger },
      ],
    }).compile();

    service = module.get<TaskService>(TaskService);
  });

  describe('create', () => {
    it('should create a task', async () => {
      const result = await service.create('user-1', {
        assignedTo: 'agent-b',
        assignedBy: 'agent-a',
        taskDescription: 'Review PR #42',
      });
      expect(result.id).toBe('task-1');
      expect(prisma.delegatedTask.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          assignedTo: 'agent-b',
          taskDescription: 'Review PR #42',
        }),
      });
      expect(ledger.recordEvent).toHaveBeenCalledWith('user-1', {
        eventType: 'TASK_ASSIGNED',
        source: 'ENGRAM',
        contractId: undefined,
        taskId: 'task-1',
        agentId: 'agent-b',
        payload: expect.objectContaining({
          assignedBy: 'agent-a',
          assignedTo: 'agent-b',
          taskDescription: 'Review PR #42',
        }),
      });
    });
  });

  describe('update', () => {
    it('should update task status', async () => {
      await service.update('user-1', 'task-1', {
        status: 'IN_PROGRESS',
      });
      expect(prisma.delegatedTask.update).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { status: 'IN_PROGRESS' },
      });
      expect(ledger.recordEvent).toHaveBeenCalledWith('user-1', {
        eventType: 'TASK_STARTED',
        source: 'ENGRAM',
        contractId: undefined,
        taskId: 'task-1',
        agentId: 'agent-b',
        payload: expect.objectContaining({
          previousStatus: 'ASSIGNED',
          status: 'IN_PROGRESS',
        }),
      });
    });

    it('should set completedAt when completing', async () => {
      await service.update('user-1', 'task-1', {
        status: 'COMPLETED',
        result: 'Done',
      });
      expect(prisma.delegatedTask.update).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          completedAt: expect.any(Date),
          result: 'Done',
        }),
      });
    });

    it('should throw if task not found', async () => {
      prisma.delegatedTask.findFirst.mockResolvedValue(null);
      await expect(
        service.update('user-1', 'nope', { status: 'COMPLETED' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('should filter by status', async () => {
      await service.findAll('user-1', { status: 'ASSIGNED' });
      expect(prisma.delegatedTask.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', status: 'ASSIGNED' },
        orderBy: { createdAt: 'desc' },
        include: { template: true, contract: true },
      });
    });
  });
});
