import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CloudSyncPushService, SyncResult } from './cloud-sync-push.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Mock content hash
jest.mock('../common/content-hash.util', () => ({
  generateContentHash: jest.fn((raw: string) => `hash-${raw.slice(0, 8)}`),
}));

describe('CloudSyncPushService', () => {
  let service: CloudSyncPushService;
  let prisma: any;

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
    contentHash: 'existing-hash',
    extraction: {
      who: 'user',
      what: 'test',
      when: new Date('2026-01-01'),
      whereCtx: null,
      why: null,
      how: null,
      topics: ['testing'],
    },
    entities: [
      {
        entity: {
          name: 'TestEntity',
          type: 'PERSON',
          normalizedName: 'testentity',
        },
      },
    ],
  };

  const makeMemory = (overrides: any = {}) => ({
    ...mockMemory,
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      memory: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudSyncPushService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback: string) => {
              if (key === 'CLOUD_API_URL') return 'https://api.test.com';
              return fallback;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<CloudSyncPushService>(CloudSyncPushService);
  });

  describe('performSyncWithClient', () => {
    const apiKey = 'test-api-key';
    const instanceId = 'inst-1';
    const signal = new AbortController().signal;
    const syncProgress = { synced: 0, total: 0 };

    it('should return zero counts when no memories to sync', async () => {
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      const result = await service.performSyncWithClient(
        prisma,
        apiKey,
        instanceId,
        signal,
        syncProgress,
      );

      expect(result.syncedCount).toBe(0);
      expect(result.newCount).toBe(0);
      expect(result.updatedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(result.errorCount).toBe(0);
      expect(result.lastSyncedAt).toBeNull();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should sync a batch of memories successfully', async () => {
      const memories = [
        makeMemory({ id: 'mem-1' }),
        makeMemory({ id: 'mem-2' }),
      ];
      prisma.memory.count.mockResolvedValue(2);
      prisma.memory.findMany
        .mockResolvedValueOnce(memories)
        .mockResolvedValueOnce([]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { sourceMemoryId: 'mem-1', status: 'created' },
            { sourceMemoryId: 'mem-2', status: 'updated' },
          ],
        }),
      });

      const result = await service.performSyncWithClient(
        prisma,
        apiKey,
        instanceId,
        signal,
        syncProgress,
      );

      expect(result.syncedCount).toBe(2);
      expect(result.newCount).toBe(1);
      expect(result.updatedCount).toBe(1);
      expect(result.lastSyncedAt).not.toBeNull();
      expect(prisma.memory.update).toHaveBeenCalledTimes(2);
    });

    it('should stop sync when signal is aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      prisma.memory.count.mockResolvedValue(5);

      const result = await service.performSyncWithClient(
        prisma,
        apiKey,
        instanceId,
        controller.signal,
        syncProgress,
      );

      expect(result.syncedCount).toBe(0);
      expect(prisma.memory.findMany).not.toHaveBeenCalled();
    });

    it('should stop on auth failure (401/403)', async () => {
      const memories = [makeMemory({ id: 'mem-1' })];
      prisma.memory.count.mockResolvedValue(1);
      prisma.memory.findMany
        .mockResolvedValueOnce(memories)
        .mockResolvedValueOnce([]);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const result = await service.performSyncWithClient(
        prisma,
        apiKey,
        instanceId,
        signal,
        syncProgress,
      );

      expect(result.errorCount).toBe(1);
      // Should not attempt more batches after auth failure
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should generate contentHash for memories missing one', async () => {
      const memNoHash = makeMemory({ id: 'mem-no-hash', contentHash: null });
      prisma.memory.count.mockResolvedValue(1);
      prisma.memory.findMany
        .mockResolvedValueOnce([memNoHash])
        .mockResolvedValueOnce([]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ sourceMemoryId: 'mem-no-hash', status: 'created' }],
        }),
      });

      await service.performSyncWithClient(
        prisma,
        apiKey,
        instanceId,
        signal,
        syncProgress,
      );

      // Should have updated hash in DB
      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'mem-no-hash' },
          data: { contentHash: expect.any(String) },
        }),
      );
    });

    it('should handle null instanceId by using "unknown"', async () => {
      const memories = [makeMemory({ id: 'mem-1' })];
      prisma.memory.count.mockResolvedValue(1);
      prisma.memory.findMany
        .mockResolvedValueOnce(memories)
        .mockResolvedValueOnce([]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ sourceMemoryId: 'mem-1', status: 'created' }],
        }),
      });

      await service.performSyncWithClient(
        prisma,
        apiKey,
        null,
        signal,
        syncProgress,
      );

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[1].headers['X-Instance-Id']).toBe('unknown');
    });

    it('should track progress correctly', async () => {
      const progress = { synced: 0, total: 0 };
      const memories = [makeMemory({ id: 'mem-1' })];
      prisma.memory.count.mockResolvedValue(1);
      prisma.memory.findMany
        .mockResolvedValueOnce(memories)
        .mockResolvedValueOnce([]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ sourceMemoryId: 'mem-1', status: 'created' }],
        }),
      });

      await service.performSyncWithClient(
        prisma,
        apiKey,
        instanceId,
        signal,
        progress,
      );

      expect(progress.total).toBe(1);
      expect(progress.synced).toBe(1);
    });

    it('should handle batch sync network failure gracefully', async () => {
      const memories = [makeMemory({ id: 'mem-1' })];
      prisma.memory.count.mockResolvedValue(1);
      prisma.memory.findMany
        .mockResolvedValueOnce(memories)
        .mockResolvedValueOnce([]);

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.performSyncWithClient(
        prisma,
        apiKey,
        instanceId,
        signal,
        syncProgress,
      );

      expect(result.errorCount).toBe(1);
      expect(result.syncedCount).toBe(0);
    });
  });

  describe('syncBatchToCloud', () => {
    const apiKey = 'test-api-key';
    const instanceId = 'inst-1';

    it('should send correct payload structure', async () => {
      const memories = [mockMemory];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ sourceMemoryId: 'mem-1', status: 'created' }],
        }),
      });

      await service.syncBatchToCloud(memories, apiKey, instanceId);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.com/v1/sync/push');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(opts.body);
      expect(body.syncProtocolVersion).toBe(2);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].raw).toBe('Test memory content');
      expect(body.memories[0].localId).toBe('mem-1');
      expect(body.memories[0].instanceId).toBe('inst-1');
      expect(body.memories[0].extraction.who).toBe('user');
      expect(body.memories[0].entities).toHaveLength(1);
    });

    it('should use X-Sync-Key header for esync_ keys', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      });

      await service.syncBatchToCloud([], 'esync_test-key', instanceId);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-Sync-Key']).toBe('esync_test-key');
      expect(headers['X-AM-API-Key']).toBeUndefined();
    });

    it('should use X-AM-API-Key header for regular keys', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      });

      await service.syncBatchToCloud([], 'regular-key', instanceId);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-AM-API-Key']).toBe('regular-key');
      expect(headers['X-Sync-Key']).toBeUndefined();
    });

    it('should throw on 401 with specific message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(
        service.syncBatchToCloud([mockMemory], apiKey, instanceId),
      ).rejects.toThrow('invalid or expired');
    });

    it('should throw on 403 with specific message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      await expect(
        service.syncBatchToCloud([mockMemory], apiKey, instanceId),
      ).rejects.toThrow('invalid or expired');
    });

    it('should throw on 429 rate limit', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests',
      });

      await expect(
        service.syncBatchToCloud([mockMemory], apiKey, instanceId),
      ).rejects.toThrow('rate limit');
    });

    it('should throw on other HTTP errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(
        service.syncBatchToCloud([mockMemory], apiKey, instanceId),
      ).rejects.toThrow('Cloud API error 500');
    });

    it('should count created/updated/skipped correctly', async () => {
      const memories = [
        makeMemory({ id: 'mem-1' }),
        makeMemory({ id: 'mem-2' }),
        makeMemory({ id: 'mem-3' }),
        makeMemory({ id: 'mem-4' }),
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { sourceMemoryId: 'mem-1', status: 'created' },
            { sourceMemoryId: 'mem-2', status: 'updated' },
            { sourceMemoryId: 'mem-3', status: 'skipped' },
            { sourceMemoryId: 'mem-4', status: 'failed', error: 'bad data' },
          ],
        }),
      });

      const result = await service.syncBatchToCloud(
        memories,
        apiKey,
        instanceId,
      );

      expect(result.synced).toBe(3);
      expect(result.newCount).toBe(1);
      expect(result.updatedCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.errors).toBe(1);
    });

    it('should mark synced memories with cloudSyncedAt', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ sourceMemoryId: 'mem-1', status: 'created' }],
        }),
      });

      await service.syncBatchToCloud([mockMemory], apiKey, instanceId);

      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        data: { cloudSyncedAt: expect.any(Date) },
      });
    });

    it('should handle prisma update failure gracefully', async () => {
      prisma.memory.update.mockRejectedValueOnce(new Error('DB error'));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ sourceMemoryId: 'mem-1', status: 'created' }],
        }),
      });

      // Should not throw - error is logged
      const result = await service.syncBatchToCloud(
        [mockMemory],
        apiKey,
        instanceId,
      );
      expect(result.synced).toBe(1);
    });

    it('should handle memory without extraction', async () => {
      const memNoExtraction = makeMemory({ extraction: null });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ sourceMemoryId: 'mem-1', status: 'created' }],
        }),
      });

      await service.syncBatchToCloud([memNoExtraction], apiKey, instanceId);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.memories[0].extraction).toBeUndefined();
    });

    it('should not leak API keys in request body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ sourceMemoryId: 'mem-1', status: 'created' }],
        }),
      });

      await service.syncBatchToCloud(
        [mockMemory],
        'secret-key-123',
        instanceId,
      );

      const body = mockFetch.mock.calls[0][1].body;
      expect(body).not.toContain('secret-key-123');
    });
  });
});
