import { Test, TestingModule } from '@nestjs/testing';
import { ScopedContextController } from './scoped-context.controller';
import { ScopedContextService } from './scoped-context.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('ScopedContextController', () => {
  let controller: ScopedContextController;
  let mockService: any;

  beforeEach(async () => {
    mockService = {
      generateScopedContext: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScopedContextController],
      providers: [{ provide: ScopedContextService, useValue: mockService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ScopedContextController>(ScopedContextController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('generateScopedContext', () => {
    it('should call service and return scoped context', async () => {
      const dto = {
        userId: 'user-1',
        agentSessionKey: 'session-abc',
        taskDescription: 'Summarize the meeting',
        maxTokens: 4000,
      };
      const expected = {
        context: '## Critical\n- Remember X\n## Task-Relevant\n- Y',
        tokenCount: 250,
        memoriesIncluded: 5,
        taskDescription: 'Summarize the meeting',
        sections: { critical: 2, taskRelevant: 2, background: 1 },
      };
      mockService.generateScopedContext.mockResolvedValue(expected);

      const result = await controller.generateScopedContext(dto as any);

      expect(result).toEqual(expected);
      expect(mockService.generateScopedContext).toHaveBeenCalledWith(dto);
    });

    it('should handle minimal dto (required fields only)', async () => {
      const dto = {
        userId: 'user-2',
        agentSessionKey: 'session-xyz',
      };
      const expected = {
        context: '',
        tokenCount: 0,
        memoriesIncluded: 0,
        taskDescription: null,
        sections: { critical: 0, taskRelevant: 0, background: 0 },
      };
      mockService.generateScopedContext.mockResolvedValue(expected);

      const result = await controller.generateScopedContext(dto as any);

      expect(result).toEqual(expected);
      expect(mockService.generateScopedContext).toHaveBeenCalledWith(dto);
    });

    it('should pass optional fields through to service', async () => {
      const dto = {
        userId: 'user-3',
        agentSessionKey: 'session-qrs',
        includeGlobal: true,
        poolIds: ['pool-1', 'pool-2'],
        topicHints: ['auth', 'security'],
        excludeTypes: ['preference'],
      };
      mockService.generateScopedContext.mockResolvedValue({
        context: 'ctx',
        tokenCount: 10,
        memoriesIncluded: 1,
        taskDescription: null,
        sections: { critical: 1, taskRelevant: 0, background: 0 },
      });

      await controller.generateScopedContext(dto as any);

      expect(mockService.generateScopedContext).toHaveBeenCalledWith(dto);
    });

    it('should propagate service errors', async () => {
      const dto = {
        userId: 'user-1',
        agentSessionKey: 'session-abc',
      };
      mockService.generateScopedContext.mockRejectedValue(
        new Error('Service unavailable'),
      );

      await expect(
        controller.generateScopedContext(dto as any),
      ).rejects.toThrow('Service unavailable');
    });
  });
});
