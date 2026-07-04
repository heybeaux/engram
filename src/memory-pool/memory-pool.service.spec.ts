import { Test, TestingModule } from '@nestjs/testing';
import { MemoryPoolService } from './memory-pool.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';

describe('MemoryPoolService', () => {
  let service: MemoryPoolService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      memoryPool: {
        create: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      poolGrant: {
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      memoryPoolMembership: {
        create: jest.fn(),
        delete: jest.fn(),
      },
      agentSession: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryPoolService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(MemoryPoolService);
  });

  describe('create', () => {
    it('should create a pool', async () => {
      const dto = { name: 'test-pool', userId: 'u1', createdBy: 'agent:main' };
      prisma.memoryPool.create.mockResolvedValue({
        id: 'p1',
        ...dto,
        visibility: 'GLOBAL',
      });

      const result = await service.create(dto);
      expect(result.name).toBe('test-pool');
      expect(result.createdBySession).toBe('agent:main');
    });
  });

  describe('listByUser', () => {
    it('should return dashboard-compatible pool list envelope', async () => {
      prisma.memoryPool.findMany.mockResolvedValue([
        {
          id: 'p1',
          name: 'global',
          description: null,
          visibility: 'GLOBAL',
          createdBy: 'system',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
          archivedAt: null,
          _count: { memberships: 2, grants: 0 },
        },
      ]);
      prisma.memoryPool.count.mockResolvedValue(1);

      const result = await service.listByUser('u1');

      expect(result.total).toBe(1);
      expect(result.pools).toEqual([
        expect.objectContaining({
          id: 'p1',
          createdBySession: 'system',
          memberCount: 2,
          grantCount: 0,
        }),
      ]);
      expect(prisma.memoryPool.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50, skip: 0 }),
      );
    });
  });

  describe('getById', () => {
    it('should throw NotFoundException when pool not found', async () => {
      prisma.memoryPool.findUnique.mockResolvedValue(null);
      await expect(service.getById('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return pool with relations when includeRelations is true', async () => {
      const pool = {
        id: 'p1',
        name: 'test',
        description: null,
        visibility: 'SHARED',
        createdBy: 'agent:main',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        archivedAt: null,
        _count: { memberships: 1, grants: 1 },
        memberships: [
          {
            id: 'mpm-1',
            memoryId: 'mem-1',
            poolId: 'p1',
            addedBy: 'agent:main',
            addedAt: new Date('2026-01-01T00:01:00Z'),
            memory: {
              id: 'mem-1',
              raw: 'hello',
              layer: 'SESSION',
              createdAt: new Date('2026-01-01T00:00:30Z'),
              importanceScore: 0.75,
            },
          },
        ],
        grants: [
          {
            id: 'grant-1',
            poolId: 'p1',
            agentSessionId: 'sess-1',
            agentId: null,
            permission: 'READ',
            grantedBy: 'agent:main',
            grantedAt: new Date('2026-01-01T00:02:00Z'),
            expiresAt: null,
            agentSession: {
              id: 'sess-1',
              sessionKey: 'agent:main',
              label: 'Main',
            },
          },
        ],
      };
      prisma.memoryPool.findUnique.mockResolvedValue(pool);

      const result = await service.getById('p1', true);
      expect(result).toEqual(
        expect.objectContaining({
          id: 'p1',
          createdBySession: 'agent:main',
          memberCount: 1,
          grantCount: 1,
          memberships: [
            expect.objectContaining({
              memoryId: 'mem-1',
              raw: 'hello',
              layer: 'SESSION',
              importanceScore: 0.75,
            }),
          ],
          grants: [
            expect.objectContaining({
              sessionKey: 'agent:main',
              permissions: 'READ',
            }),
          ],
        }),
      );
      expect(prisma.memoryPool.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            memberships: expect.any(Object),
            grants: expect.any(Object),
          }),
        }),
      );
    });
  });

  describe('deletePool', () => {
    it('should archive the pool', async () => {
      prisma.memoryPool.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.memoryPool.update.mockResolvedValue({
        id: 'p1',
        archivedAt: new Date(),
      });

      const result = await service.deletePool('p1');
      expect(result.archivedAt).toBeDefined();
      expect(prisma.memoryPool.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { archivedAt: expect.any(Date) },
      });
    });

    it('should throw if pool not found', async () => {
      prisma.memoryPool.findUnique.mockResolvedValue(null);
      await expect(service.deletePool('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findOrCreatePool', () => {
    it('should return existing pool if found', async () => {
      const existing = { id: 'p1', name: 'task:test', userId: 'u1' };
      prisma.memoryPool.findUnique.mockResolvedValue(existing);

      const result = await service.findOrCreatePool({
        name: 'task:test',
        userId: 'u1',
        createdBy: 'agent:sub',
      });
      expect(result).toEqual(existing);
      expect(prisma.memoryPool.create).not.toHaveBeenCalled();
    });

    it('should create new pool if not found', async () => {
      prisma.memoryPool.findUnique.mockResolvedValue(null);
      const created = {
        id: 'p2',
        name: 'task:test',
        userId: 'u1',
        visibility: 'SHARED',
      };
      prisma.memoryPool.create.mockResolvedValue(created);

      const result = await service.findOrCreatePool({
        name: 'task:test',
        userId: 'u1',
        visibility: 'SHARED',
        createdBy: 'agent:sub',
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: created.id,
          name: created.name,
          visibility: created.visibility,
        }),
      );
    });
  });

  describe('grantAccess', () => {
    it('should upsert a grant', async () => {
      prisma.memoryPool.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.poolGrant.upsert.mockResolvedValue({
        id: 'g1',
        poolId: 'p1',
        permission: 'READ',
      });

      const result = await service.grantAccess('p1', {
        agentSessionId: 's1',
        grantedBy: 'agent:main',
      });
      expect(result.permission).toBe('READ');
    });
  });

  describe('addMemory', () => {
    it('should add memory to pool', async () => {
      prisma.memoryPool.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.memoryPoolMembership.create.mockResolvedValue({
        id: 'm1',
        memoryId: 'mem1',
        poolId: 'p1',
      });

      const result = await service.addMemory('p1', {
        memoryId: 'mem1',
        addedBy: 'agent:sub',
      });
      expect(result.memoryId).toBe('mem1');
    });
  });

  describe('removeMemory', () => {
    it('should remove memory from pool', async () => {
      prisma.memoryPoolMembership.delete.mockResolvedValue({
        id: 'm1',
        memoryId: 'mem1',
        poolId: 'p1',
      });

      const result = await service.removeMemory('p1', 'mem1');
      expect(result.memoryId).toBe('mem1');
    });
  });

  describe('revokeAccess', () => {
    it('should delete the grant', async () => {
      prisma.poolGrant.delete.mockResolvedValue({
        id: 'g1',
        poolId: 'p1',
        agentSessionId: 's1',
      });

      const result = await service.revokeAccess('p1', 's1');
      expect(result.poolId).toBe('p1');
    });
  });

  describe('getAccessiblePoolIds', () => {
    it('should return global pools for a user', async () => {
      prisma.memoryPool.findMany
        .mockResolvedValueOnce([{ id: 'global-pool' }]) // global pools
        .mockResolvedValueOnce([]); // private pools
      prisma.agentSession.findUnique.mockResolvedValue({
        sessionKey: 'agent:main',
        parentKey: null,
        poolGrants: [],
      });

      const ids = await service.getAccessiblePoolIds('agent:main', 'u1');
      expect(ids).toContain('global-pool');
    });

    it('should include shared pools via grants', async () => {
      prisma.memoryPool.findMany
        .mockResolvedValueOnce([{ id: 'global-pool' }]) // global
        .mockResolvedValueOnce([{ id: 'shared-pool' }]) // shared via grant
        .mockResolvedValueOnce([]); // private
      prisma.agentSession.findUnique.mockResolvedValue({
        sessionKey: 'agent:sub:1',
        parentKey: 'agent:main',
        poolGrants: [{ poolId: 'shared-pool' }],
      });

      const ids = await service.getAccessiblePoolIds('agent:sub:1', 'u1');
      expect(ids).toContain('global-pool');
      expect(ids).toContain('shared-pool');
    });

    it('should include private pools created by session', async () => {
      prisma.memoryPool.findMany
        .mockResolvedValueOnce([]) // global
        .mockResolvedValueOnce([{ id: 'private-pool' }]); // private
      prisma.agentSession.findUnique.mockResolvedValue({
        sessionKey: 'agent:sub:1',
        parentKey: 'agent:main',
        poolGrants: [],
      });

      const ids = await service.getAccessiblePoolIds('agent:sub:1', 'u1');
      expect(ids).toContain('private-pool');
    });
  });
});
