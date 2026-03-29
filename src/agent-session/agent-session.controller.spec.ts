import { Test, TestingModule } from '@nestjs/testing';
import { AgentSessionController } from './agent-session.controller';
import { AgentSessionService } from './agent-session.service';
import { NotFoundException } from '@nestjs/common';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('AgentSessionController', () => {
  let controller: AgentSessionController;
  let service: any;

  const mockSession = {
    id: 'as-1',
    sessionKey: 'agent-key-1',
    parentKey: null,
    label: 'test-task',
    taskDescription: 'Do something',
    contextTokenBudget: 4000,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    endedAt: null,
  };

  beforeEach(async () => {
    service = {
      upsert: jest.fn(),
      getByKey: jest.fn(),
      updateStatus: jest.fn(),
      listByParent: jest.fn(),
      list: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentSessionController],
      providers: [
        { provide: AgentSessionService, useValue: service },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AgentSessionController>(AgentSessionController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /v1/agent-sessions', () => {
    it('should upsert an agent session', async () => {
      service.upsert!.mockResolvedValue(mockSession as any);

      const dto = { sessionKey: 'agent-key-1', label: 'test-task' };
      const result = await controller.upsert(dto as any);

      expect(service.upsert).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockSession);
    });

    it('should pass all optional fields', async () => {
      service.upsert!.mockResolvedValue(mockSession as any);

      const dto = {
        sessionKey: 'agent-key-2',
        parentKey: 'parent-1',
        label: 'sub-task',
        taskDescription: 'Sub task work',
        userId: 'u1',
        contextTokenBudget: 2000,
      };
      await controller.upsert(dto as any);

      expect(service.upsert).toHaveBeenCalledWith(dto);
    });
  });

  describe('GET /v1/agent-sessions/:key', () => {
    it('should return session by key', async () => {
      service.getByKey!.mockResolvedValue(mockSession as any);

      const result = await controller.getByKey('agent-key-1');

      expect(service.getByKey).toHaveBeenCalledWith('agent-key-1');
      expect(result).toEqual(mockSession);
    });

    it('should throw NotFoundException for unknown key', async () => {
      service.getByKey!.mockRejectedValue(
        new NotFoundException("Agent session 'unknown' not found"),
      );

      await expect(controller.getByKey('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  describe('PATCH /v1/agent-sessions/:key', () => {
    it('should update session status', async () => {
      const updated = { ...mockSession, status: 'COMPLETED' };
      service.updateStatus!.mockResolvedValue(updated as any);

      const dto = { status: 'COMPLETED' };
      const result = await controller.update('agent-key-1', dto as any);

      expect(service.updateStatus).toHaveBeenCalledWith('agent-key-1', dto);
      expect(result.status).toBe('COMPLETED');
    });

    it('should update label', async () => {
      const updated = { ...mockSession, label: 'new-label' };
      service.updateStatus!.mockResolvedValue(updated as any);

      const dto = { label: 'new-label' };
      await controller.update('agent-key-1', dto as any);

      expect(service.updateStatus).toHaveBeenCalledWith('agent-key-1', dto);
    });

    it('should throw NotFoundException for unknown key', async () => {
      service.updateStatus!.mockRejectedValue(
        new NotFoundException("Agent session 'unknown' not found"),
      );

      await expect(controller.update('unknown', {} as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /v1/agent-sessions', () => {
    it('should list by parent when parentKey is provided', async () => {
      const children = [mockSession];
      service.listByParent!.mockResolvedValue(children as any);

      const result = await controller.list('parent-1');

      expect(service.listByParent).toHaveBeenCalledWith('parent-1');
      expect(result).toEqual({ sessions: children, total: 1 });
    });

    it('should call list with parsed options when no parentKey', async () => {
      const listResult = { sessions: [mockSession], total: 1 };
      service.list!.mockResolvedValue(listResult);

      const result = await controller.list(undefined, 'ACTIVE', '10', '5');

      expect(service.list).toHaveBeenCalledWith({
        status: 'ACTIVE',
        limit: 10,
        offset: 5,
      });
      expect(result).toEqual(listResult);
    });

    it('should call list with undefined for missing optional params', async () => {
      const listResult = { sessions: [], total: 0 };
      service.list!.mockResolvedValue(listResult);

      const result = await controller.list();

      expect(service.list).toHaveBeenCalledWith({
        status: undefined,
        limit: undefined,
        offset: undefined,
      });
      expect(result).toEqual(listResult);
    });

    it('should prioritize parentKey over other filters', async () => {
      service.listByParent!.mockResolvedValue([]);

      const result = await controller.list('parent-1', 'ACTIVE', '10', '0');

      expect(service.listByParent).toHaveBeenCalledWith('parent-1');
      expect(service.list).not.toHaveBeenCalled();
      expect(result).toEqual({ sessions: [], total: 0 });
    });
  });
});
