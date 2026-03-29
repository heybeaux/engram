import { Test, TestingModule } from '@nestjs/testing';
import { CloudLinkController } from './cloud-link.controller';
import { CloudLinkService } from './cloud-link.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';

describe('CloudLinkController', () => {
  let controller: CloudLinkController;
  let mockService: any;

  beforeEach(async () => {
    mockService = {
      linkCloud: jest.fn(),
      unlinkCloud: jest.fn(),
      getStatus: jest.fn(),
      refreshSubscription: jest.fn(),
      healthCheck: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CloudLinkController],
      providers: [
        { provide: CloudLinkService, useValue: mockService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<CloudLinkController>(CloudLinkController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('link', () => {
    it('should call linkCloud with accountId, apiKey, and options', async () => {
      const req = { accountId: 'acct-1' };
      const body = {
        apiKey: 'key-123',
        localAgentId: 'local-1',
        cloudAgentId: 'cloud-1',
      };
      const expected = { linked: true, plan: 'pro' };
      mockService.linkCloud.mockResolvedValue(expected);

      const result = await controller.link(req, body);

      expect(result).toEqual(expected);
      expect(mockService.linkCloud).toHaveBeenCalledWith('acct-1', 'key-123', {
        localAgentId: 'local-1',
        cloudAgentId: 'cloud-1',
        localUserId: undefined,
        cloudUserId: undefined,
        userExternalId: undefined,
      });
    });

    it('should pass all optional mapping fields', async () => {
      const req = { accountId: 'acct-2' };
      const body = {
        apiKey: 'key-456',
        localAgentId: 'la-1',
        cloudAgentId: 'ca-1',
        localUserId: 'lu-1',
        cloudUserId: 'cu-1',
        userExternalId: 'ext-1',
      };
      mockService.linkCloud.mockResolvedValue({});

      await controller.link(req, body);

      expect(mockService.linkCloud).toHaveBeenCalledWith('acct-2', 'key-456', {
        localAgentId: 'la-1',
        cloudAgentId: 'ca-1',
        localUserId: 'lu-1',
        cloudUserId: 'cu-1',
        userExternalId: 'ext-1',
      });
    });

    it('should propagate service errors', async () => {
      const req = { accountId: 'acct-1' };
      const body = { apiKey: 'bad-key' };
      mockService.linkCloud.mockRejectedValue(new Error('Invalid API key'));

      await expect(controller.link(req, body)).rejects.toThrow(
        'Invalid API key',
      );
    });
  });

  describe('unlink', () => {
    it('should call unlinkCloud with accountId', async () => {
      const req = { accountId: 'acct-1' };
      mockService.unlinkCloud.mockResolvedValue(undefined);

      const result = await controller.unlink(req);

      expect(result).toBeUndefined();
      expect(mockService.unlinkCloud).toHaveBeenCalledWith('acct-1');
    });
  });

  describe('status', () => {
    it('should return cloud link status', async () => {
      const req = { accountId: 'acct-1' };
      const expected = { linked: true, plan: 'pro', expiresAt: '2026-12-31' };
      mockService.getStatus.mockResolvedValue(expected);

      const result = await controller.status(req);

      expect(result).toEqual(expected);
      expect(mockService.getStatus).toHaveBeenCalledWith('acct-1');
    });
  });

  describe('refresh', () => {
    it('should refresh subscription status', async () => {
      const req = { accountId: 'acct-1' };
      const expected = { refreshed: true };
      mockService.refreshSubscription.mockResolvedValue(expected);

      const result = await controller.refresh(req);

      expect(result).toEqual(expected);
      expect(mockService.refreshSubscription).toHaveBeenCalledWith('acct-1');
    });
  });

  describe('healthCheck', () => {
    it('should return health check result', async () => {
      const req = { accountId: 'acct-1' };
      const expected = { healthy: true, latencyMs: 45 };
      mockService.healthCheck.mockResolvedValue(expected);

      const result = await controller.healthCheck(req);

      expect(result).toEqual(expected);
      expect(mockService.healthCheck).toHaveBeenCalledWith('acct-1');
    });

    it('should propagate health check failures', async () => {
      const req = { accountId: 'acct-1' };
      mockService.healthCheck.mockRejectedValue(
        new Error('Cloud unreachable'),
      );

      await expect(controller.healthCheck(req)).rejects.toThrow(
        'Cloud unreachable',
      );
    });
  });
});
