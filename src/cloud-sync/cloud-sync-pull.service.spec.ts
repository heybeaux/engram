import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { CloudSyncPullService } from './cloud-sync-pull.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock encryption util
jest.mock('../common/encryption.util', () => ({
  decrypt: jest.fn((val: string) => `decrypted_${val}`),
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('CloudSyncPullService', () => {
  let service: CloudSyncPullService;
  let prisma: any;

  const mockCloudLink = {
    accountId: 'acc-1',
    cloudApiKey: 'encrypted-key',
    cloudSyncKey: null,
    instanceId: 'inst-1',
    lastPulledAt: null,
  };

  beforeEach(async () => {
    prisma = {
      cloudLink: {
        findUnique: jest.fn().mockResolvedValue(mockCloudLink),
        update: jest.fn(),
      },
      memory: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new-mem-1' }),
        update: jest.fn(),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }),
      },
      syncEvent: {
        create: jest.fn(),
      },
      agent: {
        findMany: jest.fn().mockResolvedValue([{ id: 'agent-1' }]),
      },
      syncIdMap: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudSyncPullService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(CloudSyncPullService);
    mockFetch.mockReset();
  });

  describe('triggerPull', () => {
    it('should pull new memories from cloud', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            {
              cloudId: 'cloud-1',
              localId: null,
              raw: 'test memory',
              layer: 'SEMANTIC',
              source: 'EXPLICIT_STATEMENT',
              contentHash: 'hash-1',
              createdAt: '2026-02-27T00:00:00Z',
              updatedAt: '2026-02-27T00:00:00Z',
              deletedAt: null,
            },
          ],
          hasMore: false,
        }),
      });
      // Mock embedding backfill
      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await service.triggerPull('acc-1');

      expect(result.newCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(prisma.memory.create).toHaveBeenCalled();
      expect(prisma.cloudLink.update).toHaveBeenCalledWith({
        where: { accountId: 'acc-1' },
        data: { lastPulledAt: expect.any(Date) },
      });
    });

    it('should skip memories with existing content hash', async () => {
      prisma.memory.findFirst.mockResolvedValueOnce({ id: 'existing-1' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            {
              cloudId: 'cloud-1',
              localId: null,
              raw: 'dup',
              layer: 'SEMANTIC',
              source: 'EXPLICIT_STATEMENT',
              contentHash: 'existing-hash',
              createdAt: '2026-02-27T00:00:00Z',
              updatedAt: '2026-02-27T00:00:00Z',
              deletedAt: null,
            },
          ],
          hasMore: false,
        }),
      });

      const result = await service.triggerPull('acc-1');

      expect(result.skippedCount).toBe(1);
      expect(result.newCount).toBe(0);
    });

    it('should propagate tombstones (soft delete)', async () => {
      prisma.memory.findUnique.mockResolvedValueOnce({
        id: 'local-1',
        deletedAt: null,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            {
              cloudId: 'cloud-1',
              localId: 'local-1',
              raw: 'deleted',
              layer: 'SEMANTIC',
              source: 'EXPLICIT_STATEMENT',
              contentHash: null,
              createdAt: '2026-02-27T00:00:00Z',
              updatedAt: '2026-02-27T00:00:00Z',
              deletedAt: '2026-02-27T01:00:00Z',
            },
          ],
          hasMore: false,
        }),
      });

      const result = await service.triggerPull('acc-1');

      expect(result.deletedCount).toBe(1);
      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'local-1' },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('should throw when cloud link not found', async () => {
      prisma.cloudLink.findUnique.mockResolvedValue(null);

      await expect(service.triggerPull('bad-acc')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw on cloud API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      });

      await expect(service.triggerPull('acc-1')).rejects.toThrow(
        'Cloud pull failed: 500',
      );
    });

    it('should update existing local memory when content hash differs', async () => {
      prisma.memory.findFirst.mockResolvedValueOnce(null); // no hash match
      prisma.memory.findUnique.mockResolvedValueOnce({
        id: 'local-1',
        contentHash: 'old-hash',
      });
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            memories: [
              {
                cloudId: 'cloud-1',
                localId: 'local-1',
                raw: 'updated content',
                layer: 'SEMANTIC',
                source: 'EXPLICIT_STATEMENT',
                contentHash: 'new-hash',
                createdAt: '2026-02-27T00:00:00Z',
                updatedAt: '2026-02-27T00:00:00Z',
                deletedAt: null,
              },
            ],
            hasMore: false,
          }),
        })
        .mockResolvedValueOnce({ ok: true }); // embedding backfill

      const result = await service.triggerPull('acc-1');

      expect(result.updatedCount).toBe(1);
      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'local-1' },
        data: { raw: 'updated content', contentHash: 'new-hash' },
      });
    });

    it('should skip when no user found for new memory', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memories: [
            {
              cloudId: 'cloud-1',
              localId: null,
              raw: 'orphan',
              layer: 'SEMANTIC',
              source: 'EXPLICIT_STATEMENT',
              contentHash: 'hash-orphan',
              createdAt: '2026-02-27T00:00:00Z',
              updatedAt: '2026-02-27T00:00:00Z',
              deletedAt: null,
            },
          ],
          hasMore: false,
        }),
      });

      const result = await service.triggerPull('acc-1');

      expect(result.skippedCount).toBe(1);
      expect(result.newCount).toBe(0);
    });

    it('should handle pagination with hasMore', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            memories: [
              {
                cloudId: 'cloud-1',
                localId: null,
                raw: 'page 1',
                layer: 'SEMANTIC',
                source: 'EXPLICIT_STATEMENT',
                contentHash: 'h1',
                createdAt: '2026-02-27T00:00:00Z',
                updatedAt: '2026-02-27T00:00:00Z',
                deletedAt: null,
              },
            ],
            hasMore: true,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            memories: [
              {
                cloudId: 'cloud-2',
                localId: null,
                raw: 'page 2',
                layer: 'SEMANTIC',
                source: 'EXPLICIT_STATEMENT',
                contentHash: 'h2',
                createdAt: '2026-02-27T01:00:00Z',
                updatedAt: '2026-02-27T01:00:00Z',
                deletedAt: null,
              },
            ],
            hasMore: false,
          }),
        })
        .mockResolvedValueOnce({ ok: true }); // embedding backfill

      prisma.memory.create
        .mockResolvedValueOnce({ id: 'new-1' })
        .mockResolvedValueOnce({ id: 'new-2' });

      const result = await service.triggerPull('acc-1');

      expect(result.newCount).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(3); // 2 pages + embedding backfill
    });
  });

  describe('handleSyncPull', () => {
    it('should return memories updated since given date', async () => {
      prisma.user.findMany = jest.fn().mockResolvedValue([{ id: 'user-1' }]);
      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'mem-1',
          raw: 'test',
          layer: 'SEMANTIC',
          source: 'EXPLICIT_STATEMENT',
          contentHash: 'h1',
          createdAt: new Date('2026-02-27T00:00:00Z'),
          updatedAt: new Date('2026-02-27T01:00:00Z'),
          deletedAt: null,
        },
      ]);

      const result = await service.handleSyncPull(
        'acc-1',
        'inst-1',
        new Date(0),
        100,
      );

      expect(result.memories).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.memories[0].cloudId).toBe('mem-1');
    });

    it('should set hasMore when results exceed limit', async () => {
      prisma.user.findMany = jest.fn().mockResolvedValue([{ id: 'user-1' }]);
      const mems = Array.from({ length: 3 }, (_, i) => ({
        id: `mem-${i}`,
        raw: `test ${i}`,
        layer: 'SEMANTIC',
        source: 'EXPLICIT_STATEMENT',
        contentHash: `h${i}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      }));
      prisma.memory.findMany = jest.fn().mockResolvedValue(mems);

      const result = await service.handleSyncPull(
        'acc-1',
        'inst-1',
        new Date(0),
        2,
      );

      expect(result.hasMore).toBe(true);
      expect(result.memories).toHaveLength(2);
    });
  });
});
