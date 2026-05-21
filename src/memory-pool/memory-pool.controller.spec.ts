import { Test, TestingModule } from '@nestjs/testing';
import { MemoryPoolController } from './memory-pool.controller';
import { MemoryPoolService } from './memory-pool.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('MemoryPoolController', () => {
  let controller: MemoryPoolController;
  let mockService: any;

  beforeEach(async () => {
    mockService = {
      create: jest.fn(),
      listByUser: jest.fn(),
      getById: jest.fn(),
      deletePool: jest.fn(),
      grantAccess: jest.fn(),
      revokeAccess: jest.fn(),
      addMemory: jest.fn(),
      removeMemory: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MemoryPoolController],
      providers: [{ provide: MemoryPoolService, useValue: mockService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<MemoryPoolController>(MemoryPoolController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should create a pool', async () => {
      const dto = {
        name: 'Test Pool',
        userId: 'user-1',
        createdBy: 'session-1',
      };
      const expected = { id: 'pool-1', ...dto };
      mockService.create.mockResolvedValue(expected);

      const result = await controller.create(dto as any);

      expect(result).toEqual(expected);
      expect(mockService.create).toHaveBeenCalledWith(dto);
    });
  });

  describe('list', () => {
    it('should list pools for a user', async () => {
      const pools = [{ id: 'pool-1', name: 'Pool A' }];
      mockService.listByUser.mockResolvedValue(pools);

      const result = await controller.list('user-1');

      expect(result).toEqual(pools);
      expect(mockService.listByUser).toHaveBeenCalledWith('user-1', undefined);
    });

    it('should pass visibility filter', async () => {
      mockService.listByUser.mockResolvedValue([]);

      await controller.list('user-1', 'SHARED');

      expect(mockService.listByUser).toHaveBeenCalledWith('user-1', 'SHARED');
    });
  });

  describe('getById', () => {
    it('should get pool detail with includes', async () => {
      const pool = { id: 'pool-1', name: 'Pool A', memberships: [] };
      mockService.getById.mockResolvedValue(pool);

      const result = await controller.getById('pool-1');

      expect(result).toEqual(pool);
      expect(mockService.getById).toHaveBeenCalledWith('pool-1', true);
    });
  });

  describe('getMembers', () => {
    it('should return memberships from pool', async () => {
      const memberships = [{ memoryId: 'mem-1' }];
      mockService.getById.mockResolvedValue({ memberships });

      const result = await controller.getMembers('pool-1');

      expect(result).toEqual(memberships);
    });

    it('should return empty array when no memberships', async () => {
      mockService.getById.mockResolvedValue({});

      const result = await controller.getMembers('pool-1');

      expect(result).toEqual([]);
    });
  });

  describe('getGrants', () => {
    it('should return grants from pool', async () => {
      const grants = [{ sessionId: 'sess-1', permission: 'READ' }];
      mockService.getById.mockResolvedValue({ grants });

      const result = await controller.getGrants('pool-1');

      expect(result).toEqual(grants);
    });

    it('should return empty array when no grants', async () => {
      mockService.getById.mockResolvedValue({});

      const result = await controller.getGrants('pool-1');

      expect(result).toEqual([]);
    });
  });

  describe('deletePool', () => {
    it('should delete a pool', async () => {
      mockService.deletePool.mockResolvedValue({ deleted: true });

      const result = await controller.deletePool('pool-1');

      expect(result).toEqual({ deleted: true });
      expect(mockService.deletePool).toHaveBeenCalledWith('pool-1');
    });
  });

  describe('grant', () => {
    it('should grant access to pool', async () => {
      const dto = { agentSessionId: 'sess-1', grantedBy: 'session-1' };
      const expected = { id: 'grant-1', poolId: 'pool-1', ...dto };
      mockService.grantAccess.mockResolvedValue(expected);

      const result = await controller.grant('pool-1', dto as any);

      expect(result).toEqual(expected);
      expect(mockService.grantAccess).toHaveBeenCalledWith('pool-1', dto);
    });
  });

  describe('revoke', () => {
    it('should revoke session access', async () => {
      mockService.revokeAccess.mockResolvedValue({ revoked: true });

      const result = await controller.revoke('pool-1', 'sess-1');

      expect(result).toEqual({ revoked: true });
      expect(mockService.revokeAccess).toHaveBeenCalledWith('pool-1', 'sess-1');
    });
  });

  describe('addMemory', () => {
    it('should add memory to pool', async () => {
      const dto = { memoryId: 'mem-1', addedBy: 'session-1' };
      const expected = { poolId: 'pool-1', memoryId: 'mem-1' };
      mockService.addMemory.mockResolvedValue(expected);

      const result = await controller.addMemory('pool-1', dto as any);

      expect(result).toEqual(expected);
      expect(mockService.addMemory).toHaveBeenCalledWith('pool-1', dto);
    });
  });

  describe('removeMemory', () => {
    it('should remove memory from pool', async () => {
      mockService.removeMemory.mockResolvedValue({ removed: true });

      const result = await controller.removeMemory('pool-1', 'mem-1');

      expect(result).toEqual({ removed: true });
      expect(mockService.removeMemory).toHaveBeenCalledWith('pool-1', 'mem-1');
    });
  });
});
