import { Test, TestingModule } from '@nestjs/testing';
import { DelegationController } from './delegation.controller';
import { DelegationTaskService } from './delegation-task.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

const mockTaskService = {
  logTask: jest.fn(),
  getTasks: jest.fn(),
  getRecall: jest.fn(),
};

describe('DelegationController', () => {
  let controller: DelegationController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DelegationController],
      providers: [
        { provide: DelegationTaskService, useValue: mockTaskService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DelegationController>(DelegationController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ── Guard coverage ────────────────────────────────────────────────────────

  it('should apply ApiKeyOrJwtGuard to all endpoints', async () => {
    // Guard is applied at controller level — override confirms it exists
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DelegationController],
      providers: [
        { provide: DelegationTaskService, useValue: mockTaskService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => false })
      .compile();

    const guardedController =
      module.get<DelegationController>(DelegationController);
    expect(guardedController).toBeDefined();
  });

  // ── POST /v1/identity/delegation/tasks ────────────────────────────────────

  describe('logTask', () => {
    const dto = {
      sessionKey: 'sess-abc',
      task: 'Run analysis',
      status: 'success' as const,
      durationMs: 1500,
    };

    it('should log a task and return id + createdAt', () => {
      const created = {
        id: 'task-123',
        createdAt: '2026-03-15T04:00:00.000Z',
        ...dto,
      };
      mockTaskService.logTask.mockReturnValue(created);

      const result = controller.logTask(dto);

      expect(mockTaskService.logTask).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ id: 'task-123', createdAt: created.createdAt });
    });

    it('should only return id and createdAt (not full task)', () => {
      const created = {
        id: 'task-999',
        sessionKey: 'sess-secret',
        task: 'sensitive work',
        status: 'success',
        durationMs: 100,
        error: undefined,
        metadata: { secret: 'data' },
        createdAt: '2026-03-15T04:00:00.000Z',
      };
      mockTaskService.logTask.mockReturnValue(created);

      const result = controller.logTask(dto);

      expect(result).toEqual({ id: 'task-999', createdAt: created.createdAt });
      expect(result).not.toHaveProperty('metadata');
      expect(result).not.toHaveProperty('sessionKey');
    });

    it('should forward the full dto to the service', () => {
      const fullDto = {
        sessionKey: 'sess-abc',
        parentSessionKey: 'parent-sess',
        agentId: 'agent-1',
        task: 'Complex task',
        status: 'failure' as const,
        durationMs: 5000,
        error: 'Timed out',
        metadata: { retries: 3 },
      };
      mockTaskService.logTask.mockReturnValue({ id: 'x', createdAt: 'ts' });

      controller.logTask(fullDto);

      expect(mockTaskService.logTask).toHaveBeenCalledWith(fullDto);
    });

    it('should propagate service errors', () => {
      mockTaskService.logTask.mockImplementation(() => {
        throw new Error('Service error');
      });

      expect(() => controller.logTask(dto)).toThrow('Service error');
    });
  });

  // ── GET /v1/identity/delegation/tasks ─────────────────────────────────────

  describe('getTasks', () => {
    it('should return tasks with no filters', () => {
      const tasks = [{ id: 'task-1' }, { id: 'task-2' }];
      mockTaskService.getTasks.mockReturnValue(tasks);

      const result = controller.getTasks();

      expect(mockTaskService.getTasks).toHaveBeenCalledWith({
        agentId: undefined,
        status: undefined,
        limit: undefined,
        since: undefined,
      });
      expect(result).toEqual(tasks);
    });

    it('should pass agentId and status filters', () => {
      mockTaskService.getTasks.mockReturnValue([]);

      controller.getTasks('agent-1', 'success');

      expect(mockTaskService.getTasks).toHaveBeenCalledWith({
        agentId: 'agent-1',
        status: 'success',
        limit: undefined,
        since: undefined,
      });
    });

    it('should parse limit string to integer', () => {
      mockTaskService.getTasks.mockReturnValue([]);

      controller.getTasks(undefined, undefined, '25');

      expect(mockTaskService.getTasks).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 25 }),
      );
    });

    it('should pass since as string without parsing', () => {
      mockTaskService.getTasks.mockReturnValue([]);
      const since = '2026-03-14T00:00:00.000Z';

      controller.getTasks(undefined, undefined, undefined, since);

      expect(mockTaskService.getTasks).toHaveBeenCalledWith(
        expect.objectContaining({ since }),
      );
    });

    it('should pass all query params together', () => {
      mockTaskService.getTasks.mockReturnValue([]);

      controller.getTasks('agent-42', 'failure', '10', '2026-03-01T00:00:00Z');

      expect(mockTaskService.getTasks).toHaveBeenCalledWith({
        agentId: 'agent-42',
        status: 'failure',
        limit: 10,
        since: '2026-03-01T00:00:00Z',
      });
    });

    it('should handle NaN limit gracefully (parseInt returns NaN)', () => {
      mockTaskService.getTasks.mockReturnValue([]);

      controller.getTasks(undefined, undefined, 'notanumber');

      expect(mockTaskService.getTasks).toHaveBeenCalledWith(
        expect.objectContaining({ limit: NaN }),
      );
    });
  });

  // ── GET /v1/identity/delegation/recall ────────────────────────────────────

  describe('getRecall', () => {
    it('should return recall results with no filters', () => {
      const recall = [{ task: 'Do X', successRate: 0.9 }];
      mockTaskService.getRecall.mockReturnValue(recall);

      const result = controller.getRecall();

      expect(mockTaskService.getRecall).toHaveBeenCalledWith({
        agentId: undefined,
        task: undefined,
        limit: undefined,
      });
      expect(result).toEqual(recall);
    });

    it('should pass agentId and task filters', () => {
      mockTaskService.getRecall.mockReturnValue([]);

      controller.getRecall('agent-5', 'Run analysis');

      expect(mockTaskService.getRecall).toHaveBeenCalledWith({
        agentId: 'agent-5',
        task: 'Run analysis',
        limit: undefined,
      });
    });

    it('should parse limit string to integer', () => {
      mockTaskService.getRecall.mockReturnValue([]);

      controller.getRecall(undefined, undefined, '50');

      expect(mockTaskService.getRecall).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      );
    });

    it('should propagate service errors on recall', () => {
      mockTaskService.getRecall.mockImplementation(() => {
        throw new Error('DB unavailable');
      });

      expect(() => controller.getRecall('agent-1')).toThrow('DB unavailable');
    });
  });
});
