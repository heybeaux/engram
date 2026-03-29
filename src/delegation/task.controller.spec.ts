import { Test, TestingModule } from '@nestjs/testing';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';
import { NotFoundException } from '@nestjs/common';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('TaskController', () => {
  let controller: TaskController;
  let service: any;

  const mockTask = {
    id: 'task-1',
    userId: 'user-1',
    assignedTo: 'agent-a',
    assignedBy: 'agent-b',
    taskDescription: 'Do the thing',
    status: 'ASSIGNED',
    deadline: null,
    metadata: null,
    templateId: null,
    contractId: null,
    result: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      update: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TaskController],
      providers: [
        { provide: TaskService, useValue: service },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TaskController>(TaskController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /v1/tasks', () => {
    it('should create a task', async () => {
      service.create!.mockResolvedValue(mockTask);

      const dto = {
        assignedTo: 'agent-a',
        assignedBy: 'agent-b',
        taskDescription: 'Do the thing',
      };
      const result = await controller.create('user-1', dto as any);

      expect(service.create).toHaveBeenCalledWith('user-1', dto);
      expect(result).toEqual(mockTask);
    });

    it('should pass optional fields through', async () => {
      service.create!.mockResolvedValue(mockTask);

      const dto = {
        assignedTo: 'agent-a',
        assignedBy: 'agent-b',
        taskDescription: 'Scheduled task',
        deadline: '2026-04-01T00:00:00Z',
        metadata: { priority: 'high' },
        templateId: 'tmpl-1',
        contractId: 'contract-1',
      };
      await controller.create('user-1', dto as any);

      expect(service.create).toHaveBeenCalledWith('user-1', dto);
    });
  });

  describe('PATCH /v1/tasks/:id', () => {
    it('should update task status', async () => {
      const updated = { ...mockTask, status: 'COMPLETED' };
      service.update!.mockResolvedValue(updated);

      const dto = { status: 'COMPLETED' as const };
      const result = await controller.update('user-1', 'task-1', dto as any);

      expect(service.update).toHaveBeenCalledWith('user-1', 'task-1', dto);
      expect(result.status).toBe('COMPLETED');
    });

    it('should update task result', async () => {
      const updated = { ...mockTask, result: 'Done successfully' };
      service.update!.mockResolvedValue(updated);

      const dto = { result: 'Done successfully' };
      await controller.update('user-1', 'task-1', dto as any);

      expect(service.update).toHaveBeenCalledWith('user-1', 'task-1', dto);
    });

    it('should throw NotFoundException for unknown task', async () => {
      service.update!.mockRejectedValue(new NotFoundException('Task not found'));

      await expect(
        controller.update('user-1', 'unknown', { status: 'COMPLETED' } as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /v1/tasks', () => {
    it('should return all tasks for user', async () => {
      service.findAll!.mockResolvedValue([mockTask]);

      const query = {};
      const result = await controller.findAll('user-1', query as any);

      expect(service.findAll).toHaveBeenCalledWith('user-1', query);
      expect(result).toEqual([mockTask]);
    });

    it('should pass query filters through', async () => {
      service.findAll!.mockResolvedValue([]);

      const query = { status: 'COMPLETED', assignedTo: 'agent-a', contractId: 'c-1' };
      await controller.findAll('user-1', query as any);

      expect(service.findAll).toHaveBeenCalledWith('user-1', query);
    });
  });

  describe('GET /v1/tasks/:id', () => {
    it('should return a single task', async () => {
      service.findOne!.mockResolvedValue(mockTask);

      const result = await controller.findOne('user-1', 'task-1');

      expect(service.findOne).toHaveBeenCalledWith('user-1', 'task-1');
      expect(result).toEqual(mockTask);
    });

    it('should throw NotFoundException for unknown task', async () => {
      service.findOne!.mockRejectedValue(new NotFoundException('Task not found'));

      await expect(controller.findOne('user-1', 'unknown')).rejects.toThrow(NotFoundException);
    });
  });
});
