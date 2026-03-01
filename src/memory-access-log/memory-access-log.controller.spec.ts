import { Test, TestingModule } from '@nestjs/testing';
import { MemoryAccessLogController } from './memory-access-log.controller';
import { MemoryAccessLogService } from './memory-access-log.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('MemoryAccessLogController', () => {
  let controller: MemoryAccessLogController;
  let service: jest.Mocked<
    Pick<MemoryAccessLogService, 'getAttribution' | 'getSessionSummary'>
  >;

  beforeEach(async () => {
    service = {
      getAttribution: jest.fn(),
      getSessionSummary: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MemoryAccessLogController],
      providers: [{ provide: MemoryAccessLogService, useValue: service }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(MemoryAccessLogController);
  });

  describe('getAttribution', () => {
    it('should call service.getAttribution with memory id', async () => {
      const mockResult = {
        memoryId: 'mem-1',
        createdBy: {
          sessionKey: 'agent:main',
          label: 'Main',
          createdAt: new Date(),
        },
        accessHistory: [],
        accessCount: 3,
        uniqueSessions: 2,
      };
      service.getAttribution.mockResolvedValue(mockResult);

      const result = await controller.getAttribution('mem-1');

      expect(service.getAttribution).toHaveBeenCalledWith('mem-1');
      expect(result).toEqual(mockResult);
    });

    it('should propagate service errors', async () => {
      service.getAttribution.mockRejectedValue(new Error('Not found'));
      await expect(controller.getAttribution('bad-id')).rejects.toThrow(
        'Not found',
      );
    });
  });

  describe('getSessionSummary', () => {
    it('should call service.getSessionSummary with session key', async () => {
      const mockResult = {
        sessionKey: 'agent:main',
        label: 'Main',
        status: 'ACTIVE',
        memoriesCreated: 5,
        memoriesAccessed: 10,
        uniqueMemoriesAccessed: 8,
        duration: '45m',
      };
      service.getSessionSummary.mockResolvedValue(mockResult);

      const result = await controller.getSessionSummary('agent:main');

      expect(service.getSessionSummary).toHaveBeenCalledWith('agent:main');
      expect(result).toEqual(mockResult);
    });

    it('should propagate service errors', async () => {
      service.getSessionSummary.mockRejectedValue(
        new Error('Session not found'),
      );
      await expect(controller.getSessionSummary('bad-key')).rejects.toThrow(
        'Session not found',
      );
    });
  });
});
