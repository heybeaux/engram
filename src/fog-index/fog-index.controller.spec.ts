import { Test, TestingModule } from '@nestjs/testing';
import { FogIndexController } from './fog-index.controller';
import { FogIndexService } from './fog-index.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('FogIndexController', () => {
  let controller: FogIndexController;
  let service: jest.Mocked<FogIndexService>;

  beforeEach(async () => {
    const mockService = {
      compute: jest.fn(),
      getHistory: jest.fn(),
      snapshot: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FogIndexController],
      providers: [{ provide: FogIndexService, useValue: mockService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<FogIndexController>(FogIndexController);
    service = module.get(FogIndexService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /', () => {
    it('should compute fog index with userId and agent info', async () => {
      const expected = { score: 42, tier: 'CLEAR' };
      service.compute.mockResolvedValue(expected as any);

      const req = {
        agent: { id: 'agent-1', accountId: 'acc-1' },
        accountId: 'acc-1',
      };
      const result = await controller.getCurrent('user-1', req);
      expect(result).toEqual(expected);
      expect(service.compute).toHaveBeenCalledWith({
        userId: 'user-1',
        agentId: 'agent-1',
        accountId: 'acc-1',
      });
    });

    it('should handle missing userId and req', async () => {
      service.compute.mockResolvedValue({ score: 0, tier: 'CLEAR' } as any);

      const result = await controller.getCurrent(undefined, undefined);
      expect(result).toBeDefined();
      expect(service.compute).toHaveBeenCalledWith({
        userId: undefined,
        agentId: undefined,
        accountId: undefined,
      });
    });

    it('should use agent.accountId as fallback for accountId', async () => {
      service.compute.mockResolvedValue({ score: 10, tier: 'HAZY' } as any);

      const req = { agent: { id: 'a1', accountId: 'from-agent' } };
      await controller.getCurrent(undefined, req);
      expect(service.compute).toHaveBeenCalledWith({
        userId: undefined,
        agentId: 'a1',
        accountId: 'from-agent',
      });
    });
  });

  describe('GET /history', () => {
    it('should return history with default limit', async () => {
      const history = [{ score: 40, tier: 'CLEAR', computedAt: '2026-01-01' }];
      service.getHistory.mockResolvedValue(history as any);

      const result = await controller.getHistory();
      expect(result).toEqual(history);
      expect(service.getHistory).toHaveBeenCalledWith(30);
    });

    it('should parse custom limit', async () => {
      service.getHistory.mockResolvedValue([]);

      await controller.getHistory('10');
      expect(service.getHistory).toHaveBeenCalledWith(10);
    });
  });

  describe('GET /snapshot', () => {
    it('should take a snapshot with user and agent info', async () => {
      const expected = { score: 55, tier: 'FOGGY' };
      service.snapshot.mockResolvedValue(expected as any);

      const req = {
        agent: { id: 'a1', accountId: 'acc-1' },
        accountId: 'acc-1',
      };
      const result = await controller.takeSnapshot('user-1', req);
      expect(result).toEqual(expected);
      expect(service.snapshot).toHaveBeenCalledWith({
        userId: 'user-1',
        agentId: 'a1',
        accountId: 'acc-1',
      });
    });

    it('should handle missing params', async () => {
      service.snapshot.mockResolvedValue({ score: 0, tier: 'CLEAR' } as any);

      await controller.takeSnapshot(undefined, undefined);
      expect(service.snapshot).toHaveBeenCalledWith({
        userId: undefined,
        agentId: undefined,
        accountId: undefined,
      });
    });
  });
});
