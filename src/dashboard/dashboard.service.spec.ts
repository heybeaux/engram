import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DashboardService', () => {
  let service: DashboardService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      user: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        delete: jest.fn(),
      },
      memory: {
        count: jest.fn(),
        findMany: jest.fn(),
        groupBy: jest.fn(),
        deleteMany: jest.fn(),
      },
      memoryExtraction: {
        count: jest.fn(),
      },
      entity: {
        count: jest.fn(),
      },
      memoryChainLink: {
        count: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
  });

  describe('getStats', () => {
    it('should return dashboard statistics', async () => {
      const agentId = 'agent-1';
      const accountId = 'acc-123';
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'user-1' },
        { id: 'user-2' },
      ]);
      mockPrisma.memory.count
        .mockResolvedValueOnce(100) // totalMemories
        .mockResolvedValueOnce(30) // memoriesLastWeek
        .mockResolvedValueOnce(20); // memoriesPreviousWeek
      mockPrisma.user.count
        .mockResolvedValueOnce(2) // totalUsers (all agents)
        .mockResolvedValueOnce(1) // usersLastWeek
        .mockResolvedValueOnce(0); // usersPreviousWeek
      mockPrisma.memoryExtraction.count.mockResolvedValue(80);
      mockPrisma.memory.groupBy.mockResolvedValue([
        { layer: 'SESSION', _count: { id: 60 } },
        { layer: 'CORE', _count: { id: 40 } },
      ]);
      mockPrisma.memory.findMany.mockResolvedValue([
        {
          id: 'mem-1',
          createdAt: new Date(),
          source: 'API',
        },
      ]);

      const result = await service.getStats(agentId, accountId);

      expect(result.totalMemories).toBe(100);
      expect(result.totalUsers).toBe(2);
      expect(result.memoryTrend).toBe(50); // (30-20)/20 * 100
      expect(result.userTrend).toBe(1); // 0 previous, so returns count
      expect(result.healthScore).toBe(80);
      expect(result.memoryByLayer).toBeDefined();
      expect(result.recentActivity).toHaveLength(1);
      expect(result.apiRequests).toHaveLength(7);
    });

    it('should handle zero memories gracefully', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.memory.count.mockResolvedValue(0);
      mockPrisma.user.count
        .mockResolvedValueOnce(0) // totalUsers
        .mockResolvedValueOnce(0) // usersLastWeek
        .mockResolvedValueOnce(0); // usersPreviousWeek
      mockPrisma.memoryExtraction.count.mockResolvedValue(0);
      mockPrisma.memory.groupBy.mockResolvedValue([]);
      mockPrisma.memory.findMany.mockResolvedValue([]);

      const result = await service.getStats('agent-1', 'acc-123');

      expect(result.totalMemories).toBe(0);
      expect(result.totalUsers).toBe(0);
      expect(result.healthScore).toBe(100); // 0 memories = 100% health
    });
  });

  describe('listMemories', () => {
    it('should return paginated memories', async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'user-1' }]);
      mockPrisma.memory.findMany.mockResolvedValue([
        { id: 'mem-1', raw: 'test', createdAt: new Date() },
      ]);
      mockPrisma.memory.count.mockResolvedValue(1);

      const result = await service.listMemories('agent-1', {
        page: 1,
        limit: 25,
      } as any);

      expect(result.memories).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('should filter by layer', async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'user-1' }]);
      mockPrisma.memory.findMany.mockResolvedValue([]);
      mockPrisma.memory.count.mockResolvedValue(0);

      await service.listMemories('agent-1', {
        page: 1,
        limit: 25,
        layer: 'CORE',
      } as any);

      const whereArg = mockPrisma.memory.findMany.mock.calls[0][0].where;
      expect(whereArg.layer).toBe('CORE');
    });
  });

  describe('listUsers', () => {
    it('should return users with memory stats', async () => {
      const now = new Date();
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: 'user-1',
          externalId: 'ext-1',
          createdAt: now,
          _count: { memories: 5 },
          memories: [{ createdAt: now }],
        },
      ]);

      const result = await service.listUsers('agent-1', 'account-1');

      expect(result.users).toHaveLength(1);
      expect(result.users[0].memoryCount).toBe(5);
      expect(result.users[0].externalId).toBe('ext-1');
    });
  });

  describe('getUserDetail', () => {
    it('should return user detail with layer breakdown', async () => {
      const now = new Date();
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        externalId: 'ext-1',
        createdAt: now,
        deletedAt: null,
        memories: [{ createdAt: now }],
      });
      mockPrisma.memory.groupBy.mockResolvedValue([
        { layer: 'SESSION', _count: { id: 3 } },
        { layer: 'CORE', _count: { id: 2 } },
      ]);

      const result = await service.getUserDetail('user-1');

      expect(result).not.toBeNull();
      expect(result!.memoryCount).toBe(5);
      expect(result!.memoriesByLayer['SESSION']).toBe(3);
      expect(result!.memoriesByLayer['CORE']).toBe(2);
    });

    it('should return null for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await service.getUserDetail('missing');

      expect(result).toBeNull();
    });

    it('should return null for deleted user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        deletedAt: new Date(),
      });

      const result = await service.getUserDetail('user-1');

      expect(result).toBeNull();
    });
  });

  describe('deleteUser', () => {
    it('should delete user without memories', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      mockPrisma.memory.count.mockResolvedValue(0);
      mockPrisma.user.delete.mockResolvedValue({});

      const result = await service.deleteUser('user-1', false);

      expect(result).toEqual({ deleted: true, memoriesDeleted: 0 });
      expect(mockPrisma.user.delete).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
    });

    it('should delete user with memories when requested', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      mockPrisma.memory.deleteMany.mockResolvedValue({ count: 10 });
      mockPrisma.user.delete.mockResolvedValue({});

      const result = await service.deleteUser('user-1', true);

      expect(result).toEqual({ deleted: true, memoriesDeleted: 10 });
      expect(mockPrisma.memory.deleteMany).toHaveBeenCalled();
    });

    it('should return null for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await service.deleteUser('missing');

      expect(result).toBeNull();
    });
  });

  describe('getHealth', () => {
    it('should return healthy status when metrics are good', async () => {
      mockPrisma.memory.count
        .mockResolvedValueOnce(100) // totalMemories
        .mockResolvedValueOnce(10); // memoriesLast24h
      mockPrisma.memoryExtraction.count
        .mockResolvedValueOnce(90) // extractionsWithWho
        .mockResolvedValueOnce(85); // extractionsWithWhat
      mockPrisma.entity.count.mockResolvedValue(50);
      mockPrisma.memoryChainLink.count.mockResolvedValue(30);
      // safetyCriticalCount and consolidatedCount
      mockPrisma.memory.count
        .mockResolvedValueOnce(5) // safetyCritical
        .mockResolvedValueOnce(20); // consolidated

      const result = await service.getHealth();

      expect(result.status).toBe('healthy');
      expect(result.metrics.totalMemories).toBe(100);
      expect(result.metrics.extractionRate).toBe(85);
      expect(result.issues).toHaveLength(0);
    });

    it('should return degraded status with low extraction rate', async () => {
      mockPrisma.memory.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(5);
      mockPrisma.memoryExtraction.count
        .mockResolvedValueOnce(50) // who
        .mockResolvedValueOnce(60); // what
      mockPrisma.entity.count.mockResolvedValue(10);
      mockPrisma.memoryChainLink.count.mockResolvedValue(5);
      mockPrisma.memory.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      const result = await service.getHealth();

      expect(result.status).toBe('degraded');
      expect(result.issues.length).toBeGreaterThan(0);
    });
  });
});
