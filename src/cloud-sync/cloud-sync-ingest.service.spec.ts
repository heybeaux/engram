import { Test, TestingModule } from '@nestjs/testing';
import { CloudSyncIngestService } from './cloud-sync-ingest.service';
import { PrismaService } from '../prisma/prisma.service';

describe('CloudSyncIngestService', () => {
  let service: CloudSyncIngestService;
  let prisma: any;

  const mockPrisma = {
    memory: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    memoryExtraction: {
      create: jest.fn(),
    },
    syncIdMap: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    syncAgentMap: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    syncUserMap: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    agent: {
      create: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    cloudInstance: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn((cb: (tx: any) => Promise<any>) => cb(mockPrisma)),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudSyncIngestService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<CloudSyncIngestService>(CloudSyncIngestService);
  });

  const setupAgentAndUserResolution = () => {
    mockPrisma.syncAgentMap.findUnique.mockResolvedValue({
      cloudAgentId: 'cloud-agent-1',
    });
    mockPrisma.syncUserMap.findUnique.mockResolvedValue({
      cloudUserId: 'cloud-user-1',
    });
  };

  describe('handleSyncPush', () => {
    it('should create new memory when no dedup match', async () => {
      setupAgentAndUserResolution();
      mockPrisma.memory.findFirst.mockResolvedValue(null);
      mockPrisma.syncIdMap.findUnique.mockResolvedValue(null);
      mockPrisma.memory.create.mockResolvedValue({ id: 'cloud-mem-1' });
      mockPrisma.syncIdMap.upsert.mockResolvedValue({});
      mockPrisma.syncIdMap.count.mockResolvedValue(1);
      mockPrisma.cloudInstance.upsert.mockResolvedValue({});

      const result = await service.handleSyncPush('acc-1', 'inst-1', {
        memories: [
          {
            localId: 'local-1',
            raw: 'Test memory',
            layer: 'SESSION',
            contentHash: 'hash-1',
            localAgentId: 'agent-1',
            agentName: 'Test Agent',
            localUserId: 'user-1',
            userExternalId: 'ext-1',
          },
        ],
      } as any);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('created');
      expect(result.results[0].cloudMemoryId).toBe('cloud-mem-1');
    });

    it('should skip when contentHash already exists', async () => {
      setupAgentAndUserResolution();
      mockPrisma.memory.findFirst.mockResolvedValue({ id: 'existing-mem' });
      mockPrisma.syncIdMap.upsert.mockResolvedValue({});
      mockPrisma.syncIdMap.count.mockResolvedValue(1);
      mockPrisma.cloudInstance.upsert.mockResolvedValue({});

      const result = await service.handleSyncPush('acc-1', 'inst-1', {
        memories: [
          {
            localId: 'local-1',
            raw: 'Duplicate',
            layer: 'SESSION',
            contentHash: 'existing-hash',
          },
        ],
      } as any);

      expect(result.results[0].status).toBe('skipped');
      expect(mockPrisma.memory.create).not.toHaveBeenCalled();
    });

    it('should update when syncIdMap exists and hash changed', async () => {
      setupAgentAndUserResolution();
      mockPrisma.memory.findFirst.mockResolvedValue(null);
      // syncIdMap.findUnique is called once per memory for the sync ID check
      mockPrisma.syncIdMap.findUnique.mockResolvedValue({
        cloudMemoryId: 'cloud-mem-1',
        contentHash: 'old-hash',
      });
      mockPrisma.memory.update.mockResolvedValue({});
      mockPrisma.syncIdMap.upsert.mockResolvedValue({});
      mockPrisma.syncIdMap.count.mockResolvedValue(1);
      mockPrisma.cloudInstance.upsert.mockResolvedValue({});

      const result = await service.handleSyncPush('acc-1', 'inst-1', {
        memories: [
          {
            localId: 'local-1',
            raw: 'Updated content',
            layer: 'SESSION',
            contentHash: 'new-hash',
          },
        ],
      } as any);

      expect(result.results[0].status).toBe('updated');
    });

    it('should create extraction when provided', async () => {
      setupAgentAndUserResolution();
      mockPrisma.memory.findFirst.mockResolvedValue(null);
      mockPrisma.syncIdMap.findUnique.mockResolvedValue(null);
      mockPrisma.memory.create.mockResolvedValue({ id: 'cloud-mem-1' });
      mockPrisma.syncIdMap.upsert.mockResolvedValue({});
      mockPrisma.syncIdMap.count.mockResolvedValue(1);
      mockPrisma.cloudInstance.upsert.mockResolvedValue({});

      await service.handleSyncPush('acc-1', 'inst-1', {
        memories: [
          {
            localId: 'local-1',
            raw: 'Test',
            layer: 'SESSION',
            contentHash: 'hash-ext',
            extraction: {
              who: 'Beaux',
              what: 'likes coffee',
              topics: ['preferences'],
            },
          },
        ],
      } as any);

      expect(mockPrisma.memoryExtraction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            memoryId: 'cloud-mem-1',
            who: 'Beaux',
          }),
        }),
      );
    });

    it('should handle failures gracefully per-memory', async () => {
      setupAgentAndUserResolution();
      mockPrisma.memory.findFirst.mockRejectedValue(new Error('DB error'));
      mockPrisma.syncIdMap.count.mockResolvedValue(0);
      mockPrisma.cloudInstance.upsert.mockResolvedValue({});

      const result = await service.handleSyncPush('acc-1', 'inst-1', {
        memories: [
          {
            localId: 'local-1',
            raw: 'Fail',
            layer: 'SESSION',
            contentHash: 'h1',
          },
        ],
      } as any);

      expect(result.results[0].status).toBe('failed');
      expect(result.results[0].error).toContain('DB error');
    });

    it('should handle multiple memories in one push', async () => {
      // Reset and set up fresh for each call in the loop
      mockPrisma.syncAgentMap.findUnique.mockResolvedValue({
        cloudAgentId: 'cloud-agent-1',
      });
      mockPrisma.syncUserMap.findUnique.mockResolvedValue({
        cloudUserId: 'cloud-user-1',
      });
      mockPrisma.memory.findFirst.mockResolvedValue(null);
      mockPrisma.syncIdMap.findUnique.mockResolvedValue(null);
      mockPrisma.memory.create
        .mockResolvedValueOnce({ id: 'cm-1' })
        .mockResolvedValueOnce({ id: 'cm-2' });
      mockPrisma.syncIdMap.upsert.mockResolvedValue({});
      mockPrisma.syncIdMap.count.mockResolvedValue(2);
      mockPrisma.cloudInstance.upsert.mockResolvedValue({});

      const result = await service.handleSyncPush('acc-1', 'inst-1', {
        memories: [
          { localId: 'l1', raw: 'Mem 1', layer: 'SESSION', contentHash: 'h1' },
          { localId: 'l2', raw: 'Mem 2', layer: 'IDENTITY', contentHash: 'h2' },
        ],
      } as any);

      expect(result.results).toHaveLength(2);
      expect(result.results.filter((r) => r.status === 'created')).toHaveLength(
        2,
      );
    });
  });

  describe('upsertSyncIdMap', () => {
    it('should upsert sync id mapping', async () => {
      mockPrisma.syncIdMap.upsert.mockResolvedValue({});
      await service.upsertSyncIdMap('inst-1', 'local-1', 'cloud-1', 'hash-1');
      expect(mockPrisma.syncIdMap.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            instanceId_localMemoryId: {
              instanceId: 'inst-1',
              localMemoryId: 'local-1',
            },
          },
        }),
      );
    });

    it('should handle P2002 unique constraint with updateMany fallback', async () => {
      const p2002Error = new Error('Unique constraint') as any;
      p2002Error.code = 'P2002';
      mockPrisma.syncIdMap.upsert.mockRejectedValue(p2002Error);
      mockPrisma.syncIdMap.updateMany.mockResolvedValue({ count: 1 });

      await service.upsertSyncIdMap('inst-1', 'local-1', 'cloud-1', 'hash-1');
      expect(mockPrisma.syncIdMap.updateMany).toHaveBeenCalled();
    });

    it('should rethrow non-P2002 errors', async () => {
      mockPrisma.syncIdMap.upsert.mockRejectedValue(new Error('Unknown'));
      await expect(
        service.upsertSyncIdMap('inst-1', 'local-1', 'cloud-1'),
      ).rejects.toThrow('Unknown');
    });
  });

  describe('updateCloudInstance', () => {
    it('should upsert cloud instance', async () => {
      mockPrisma.syncIdMap.count.mockResolvedValue(42);
      mockPrisma.cloudInstance.upsert.mockResolvedValue({});

      await service.updateCloudInstance('acc-1', 'inst-1', 'My Instance', 5);
      expect(mockPrisma.cloudInstance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            accountId_instanceId: { accountId: 'acc-1', instanceId: 'inst-1' },
          },
          create: expect.objectContaining({
            instanceName: 'My Instance',
            memoryCount: 42,
            lastPushCount: 5,
            status: 'active',
          }),
        }),
      );
    });
  });

  describe('getInstances', () => {
    it('should return instances for account', async () => {
      const instances = [{ instanceId: 'inst-1', status: 'active' }];
      mockPrisma.cloudInstance.findMany = jest
        .fn()
        .mockResolvedValue(instances);

      const result = await service.getInstances('acc-1');
      expect(result).toEqual(instances);
    });
  });
});
