import { Test, TestingModule } from '@nestjs/testing';
import { CloudSyncService } from './cloud-sync.service';
import { CloudSyncPushService } from './cloud-sync-push.service';
import { CloudSyncPullService } from './cloud-sync-pull.service';
import { CloudSyncIngestService } from './cloud-sync-ingest.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloudLinkService } from '../cloud-link/cloud-link.service';
import { BadRequestException } from '@nestjs/common';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('CloudSyncService', () => {
  let service: CloudSyncService;
  let prisma: any;

  const mockCloudLink = {
    id: 'link-1',
    accountId: 'acc-1',
    instanceId: 'inst-1',
    cloudApiKey: 'fake-encrypted-key',
    autoSync: false,
  };

  const mockMemory = {
    id: 'mem-1',
    raw: 'Test memory content',
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    createdAt: new Date('2026-01-01'),
    importanceScore: 0.5,
    effectiveScore: 0.6,
    importanceHint: null,
    memoryType: null,
    priority: 3,
    contentHash: null,
    extraction: { topics: ['test'] },
    entities: [],
  };

  beforeEach(async () => {
    prisma = {
      cloudLink: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      memory: {
        count: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      memoryExtraction: {
        create: jest.fn(),
      },
      syncIdMap: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      syncEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
      syncAgentMap: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      syncUserMap: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      instanceSyncKey: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      cloudInstance: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      agent: {
        create: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValue([{ pg_try_advisory_lock: true }]),
      $transaction: jest.fn((cb: (tx: any) => Promise<any>) => cb(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudSyncService,
        { provide: PrismaService, useValue: prisma },
        { provide: CloudLinkService, useValue: {} },
        {
          provide: CloudSyncPushService,
          useValue: {
            performSyncWithClient: jest.fn(),
            syncBatchToCloud: jest.fn(),
          },
        },
        {
          provide: CloudSyncPullService,
          useValue: { triggerPull: jest.fn(), handleSyncPull: jest.fn() },
        },
        {
          provide: CloudSyncIngestService,
          useValue: {
            handleSyncPush: jest.fn(),
            updateCloudInstance: jest.fn(),
            getInstances: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CloudSyncService>(CloudSyncService);
    // Override decryptApiKey for tests
    (service as any).decryptApiKey = jest.fn().mockReturnValue('test-api-key');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getSyncStatus', () => {
    it('should return sync status when linked', async () => {
      prisma.cloudLink.findUnique.mockResolvedValue(mockCloudLink);
      prisma.memory.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(75); // synced
      prisma.memory.findFirst.mockResolvedValue({
        cloudSyncedAt: new Date('2026-02-15'),
      });

      const result = await service.getSyncStatus('acc-1');

      expect(result).toEqual({
        lastSyncedAt: '2026-02-15T00:00:00.000Z',
        totalMemories: 100,
        syncedCount: 75,
        pendingCount: 25,
        autoSync: false,
        syncing: false,
      });
    });

    it('should throw if not linked', async () => {
      prisma.cloudLink.findUnique.mockResolvedValue(null);
      await expect(service.getSyncStatus('acc-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('triggerSync', () => {
    it('should sync unsynced memories in batches via /v1/sync/push', async () => {
      prisma.cloudLink.findUnique.mockResolvedValue(mockCloudLink);
      prisma.memory.count.mockResolvedValue(1); // totalPending
      prisma.memory.findMany
        .mockResolvedValueOnce([mockMemory])
        .mockResolvedValueOnce([]); // no more
      prisma.memory.update.mockResolvedValue({});

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              sourceMemoryId: 'mem-1',
              cloudMemoryId: 'cloud-1',
              status: 'created',
            },
          ],
        }),
      });

      const result = await service.triggerSync('acc-1');

      expect(result.message).toBe('Sync started in background');
    });

    it('should reject if sync already in progress', async () => {
      prisma.cloudLink.findUnique.mockResolvedValue(mockCloudLink);
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      // First call acquires advisory lock and starts background sync
      const first = await service.triggerSync('acc-1');
      expect(first.message).toBe('Sync started in background');

      // Simulate advisory lock held by another instance on second call
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { pg_try_advisory_lock: false },
      ]);

      // Second call should reject because advisory lock is held
      await expect(service.triggerSync('acc-1')).rejects.toThrow(
        'Sync already in progress',
      );

      // Let background sync complete
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe('handleSyncPush (cloud-side)', () => {
    let ingestService: CloudSyncIngestService;

    beforeEach(async () => {
      // Create a real ingest service with the mock prisma for these tests
      const ingestModule = await Test.createTestingModule({
        providers: [
          CloudSyncIngestService,
          { provide: PrismaService, useValue: prisma },
        ],
      }).compile();
      ingestService = ingestModule.get(CloudSyncIngestService);
    });

    const setupAgentUserMocks = () => {
      prisma.syncAgentMap.findUnique.mockResolvedValue(null);
      prisma.agent.create.mockResolvedValue({ id: 'cloud-agent-1' });
      prisma.syncAgentMap.create.mockResolvedValue({});
      prisma.syncUserMap.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'cloud-user-1' });
      prisma.syncUserMap.create.mockResolvedValue({});
    };

    it('should create memory and SyncIdMap entry', async () => {
      setupAgentUserMocks();
      prisma.memory.findFirst.mockResolvedValue(null);
      prisma.syncIdMap.findUnique.mockResolvedValue(null);
      prisma.memory.create.mockResolvedValue({ id: 'cloud-mem-1' });
      prisma.syncIdMap.upsert.mockResolvedValue({});

      const result = await ingestService.handleSyncPush('acc-1', 'inst-1', {
        memories: [
          {
            raw: 'hello world',
            layer: 'SESSION',
            source: 'EXPLICIT_STATEMENT',
            contentHash: 'abc123',
            localId: 'local-1',
            instanceId: 'inst-1',
            agentName: 'Test Agent',
            localAgentId: 'local-agent-1',
            userExternalId: 'user@test.com',
            localUserId: 'local-user-1',
          },
        ],
        syncProtocolVersion: 2,
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('created');
      expect(result.results[0].cloudMemoryId).toBe('cloud-mem-1');
    });

    it('should skip if contentHash already exists', async () => {
      setupAgentUserMocks();
      prisma.memory.findFirst.mockResolvedValue({ id: 'existing-1' });
      prisma.syncIdMap.upsert.mockResolvedValue({});

      const result = await ingestService.handleSyncPush('acc-1', 'inst-1', {
        memories: [
          {
            raw: 'hello world',
            layer: 'SESSION',
            source: 'EXPLICIT_STATEMENT',
            contentHash: 'abc123',
            localId: 'local-1',
            instanceId: 'inst-1',
          },
        ],
      });

      expect(result.results[0].status).toBe('skipped');
      expect(result.results[0].cloudMemoryId).toBe('existing-1');
    });
  });

  describe('setAutoSync', () => {
    it('should update auto-sync preference', async () => {
      prisma.cloudLink.findUnique.mockResolvedValue(mockCloudLink);
      prisma.cloudLink.update.mockResolvedValue({});

      await service.setAutoSync('acc-1', true);

      expect(prisma.cloudLink.update).toHaveBeenCalledWith({
        where: { accountId: 'acc-1' },
        data: { autoSync: true },
      });
    });
  });
});
