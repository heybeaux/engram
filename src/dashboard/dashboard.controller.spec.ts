import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { InternalOnlyGuard } from '../common/guards/internal-only.guard';

describe('DashboardController', () => {
  let controller: DashboardController;
  let service: jest.Mocked<DashboardService>;

  const agent = { id: 'agent-1', accountId: 'acc-1' };

  beforeEach(async () => {
    const mockService = {
      getStats: jest.fn(),
      listMemories: jest.fn(),
      listUsers: jest.fn(),
      getUserDetail: jest.fn(),
      deleteUser: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [{ provide: DashboardService, useValue: mockService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(InternalOnlyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DashboardController>(DashboardController);
    service = module.get(DashboardService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /stats', () => {
    it('should return stats', async () => {
      const stats = { totalMemories: 100, totalUsers: 5 };
      service.getStats.mockResolvedValue(stats as any);

      const result = await controller.getStats(agent);
      expect(result).toEqual(stats);
      expect(service.getStats).toHaveBeenCalledWith('agent-1', 'acc-1');
    });
  });

  describe('GET /memories', () => {
    it('should return memories list', async () => {
      const response = { data: [{ id: 'm1' }], total: 1 };
      service.listMemories.mockResolvedValue(response as any);

      const dto = { page: 1, limit: 10 } as any;
      const result = await controller.listMemories(agent, dto);
      expect(result).toEqual(response);
      expect(service.listMemories).toHaveBeenCalledWith('agent-1', dto);
    });
  });

  describe('GET /users', () => {
    it('should return users list', async () => {
      const users = { data: [{ id: 'u1' }], total: 1 };
      service.listUsers.mockResolvedValue(users as any);

      const result = await controller.listUsers(agent);
      expect(result).toEqual(users);
      expect(service.listUsers).toHaveBeenCalledWith('agent-1', 'acc-1');
    });
  });

  describe('GET /users/:id', () => {
    it('should return user detail', async () => {
      const user = { id: 'u1', memoriesCount: 10 };
      service.getUserDetail.mockResolvedValue(user as any);

      const result = await controller.getUserDetail('u1');
      expect(result).toEqual(user);
      expect(service.getUserDetail).toHaveBeenCalledWith('u1');
    });

    it('should throw NotFoundException when user not found', async () => {
      service.getUserDetail.mockResolvedValue(null);

      await expect(controller.getUserDetail('bad-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('DELETE /users/:id', () => {
    it('should delete user without memories', async () => {
      const expected = { deleted: true };
      service.deleteUser.mockResolvedValue(expected as any);

      const result = await controller.deleteUser('u1');
      expect(result).toEqual(expected);
      expect(service.deleteUser).toHaveBeenCalledWith('u1', false);
    });

    it('should delete user with memories when flag is true', async () => {
      const expected = { deleted: true, memoriesDeleted: 5 };
      service.deleteUser.mockResolvedValue(expected as any);

      const result = await controller.deleteUser('u1', 'true');
      expect(result).toEqual(expected);
      expect(service.deleteUser).toHaveBeenCalledWith('u1', true);
    });

    it('should throw NotFoundException when user not found', async () => {
      service.deleteUser.mockResolvedValue(null);

      await expect(controller.deleteUser('bad-id')).rejects.toThrow(NotFoundException);
    });

    it('should treat non-true string as false for deleteMemories', async () => {
      service.deleteUser.mockResolvedValue({ deleted: true } as any);

      await controller.deleteUser('u1', 'false');
      expect(service.deleteUser).toHaveBeenCalledWith('u1', false);
    });
  });
});
