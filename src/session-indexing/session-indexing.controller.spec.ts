import { Test, TestingModule } from '@nestjs/testing';
import { SessionIndexingController } from './session-indexing.controller';
import { SessionIndexingService } from './session-indexing.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

describe('SessionIndexingController', () => {
  let controller: SessionIndexingController;
  let service: jest.Mocked<SessionIndexingService>;

  const userId = 'user-1';

  beforeEach(async () => {
    const mockService = {
      indexSession: jest.fn(),
      getSessionMemories: jest.fn(),
      flushMemories: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SessionIndexingController],
      providers: [{ provide: SessionIndexingService, useValue: mockService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<SessionIndexingController>(SessionIndexingController);
    service = module.get(SessionIndexingService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /sessions/index', () => {
    it('should index a session', async () => {
      const dto = { sessionId: 's1', transcript: 'hello world' } as any;
      const expected = { memoriesCreated: 3 };
      service.indexSession.mockResolvedValue(expected as any);

      const result = await controller.indexSession(userId, dto);
      expect(result).toEqual(expected);
      expect(service.indexSession).toHaveBeenCalledWith(userId, dto);
    });

    it('should propagate service errors', async () => {
      service.indexSession.mockRejectedValue(new Error('Invalid transcript'));
      await expect(controller.indexSession(userId, {} as any)).rejects.toThrow('Invalid transcript');
    });
  });

  describe('GET /sessions/:id/memories', () => {
    it('should return session memories with defaults', async () => {
      const memories = [{ id: 'm1' }, { id: 'm2' }];
      service.getSessionMemories.mockResolvedValue(memories as any);

      const result = await controller.getSessionMemories(userId, 's1');
      expect(result).toEqual(memories);
      expect(service.getSessionMemories).toHaveBeenCalledWith(userId, 's1', undefined, undefined);
    });

    it('should parse limit and offset query params', async () => {
      service.getSessionMemories.mockResolvedValue({ sessionId: 's1', memories: [], total: 0 } as any);

      await controller.getSessionMemories(userId, 's1', '10', '5');
      expect(service.getSessionMemories).toHaveBeenCalledWith(userId, 's1', 10, 5);
    });

    it('should handle only limit provided', async () => {
      service.getSessionMemories.mockResolvedValue({ sessionId: 's1', memories: [], total: 0 } as any);

      await controller.getSessionMemories(userId, 's1', '20');
      expect(service.getSessionMemories).toHaveBeenCalledWith(userId, 's1', 20, undefined);
    });
  });

  describe('POST /memories/flush', () => {
    it('should flush memories', async () => {
      const dto = { memories: [{ content: 'important fact' }] } as any;
      const expected = { flushed: 1 };
      service.flushMemories.mockResolvedValue(expected as any);

      const result = await controller.flushMemories(userId, dto);
      expect(result).toEqual(expected);
      expect(service.flushMemories).toHaveBeenCalledWith(userId, dto);
    });

    it('should propagate service errors', async () => {
      service.flushMemories.mockRejectedValue(new Error('Flush failed'));
      await expect(controller.flushMemories(userId, {} as any)).rejects.toThrow('Flush failed');
    });
  });
});
