import { PrefetchCacheRedisAdapter } from './prefetch-cache-redis.adapter';
import { CachedMemory, TopicId } from './prefetch.types';

// =========================================================================
// Mock Redis
// =========================================================================
const mockScanStream = {
  on: jest.fn(),
};

const mockPipeline = {
  get: jest.fn().mockReturnThis(),
  exec: jest.fn(),
};

const mockRedis = {
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  sadd: jest.fn().mockResolvedValue(1),
  srem: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
  scanStream: jest.fn().mockReturnValue(mockScanStream),
  pipeline: jest.fn().mockReturnValue(mockPipeline),
};

// Helper to build a CachedMemory
function makeCachedMemory(overrides: Partial<CachedMemory> = {}): CachedMemory {
  return {
    id: 'mem-123',
    userId: 'user-456',
    raw: 'test memory content',
    topics: ['technical', 'work'] as TopicId[],
    score: 0.8,
    cachedAt: Date.now(),
    ...overrides,
  } as CachedMemory;
}

describe('PrefetchCacheRedisAdapter', () => {
  let adapter: PrefetchCacheRedisAdapter;

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-setup default mock returns after clearAllMocks
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);
    mockRedis.sadd.mockResolvedValue(1);
    mockRedis.srem.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.scanStream.mockReturnValue(mockScanStream);
    mockRedis.pipeline.mockReturnValue(mockPipeline);
    mockPipeline.exec.mockResolvedValue([]);

    adapter = new PrefetchCacheRedisAdapter(mockRedis as any);
  });

  // =========================================================================
  // persist
  // =========================================================================
  describe('persist', () => {
    it('should store memory as JSON with correct key and TTL', async () => {
      const memory = makeCachedMemory({ id: 'mem-abc' });
      const ttlMs = 60000; // 60 seconds

      adapter.persist(memory, ttlMs);

      // Allow microtask to flush
      await Promise.resolve();

      expect(mockRedis.set).toHaveBeenCalledWith(
        'prefetch:cache:mem-abc',
        JSON.stringify(memory),
        'EX',
        60, // Math.ceil(60000 / 1000)
      );
    });

    it('should round up TTL to nearest second', async () => {
      const memory = makeCachedMemory({ id: 'mem-ttl' });
      adapter.persist(memory, 1500); // 1.5 seconds → ceil = 2

      await Promise.resolve();

      expect(mockRedis.set).toHaveBeenCalledWith(
        'prefetch:cache:mem-ttl',
        expect.any(String),
        'EX',
        2,
      );
    });

    it('should add memory ID to topic index sets', async () => {
      const memory = makeCachedMemory({
        id: 'mem-topics',
        topics: ['health', 'family'] as TopicId[],
      });

      adapter.persist(memory, 30000);
      await Promise.resolve();

      expect(mockRedis.sadd).toHaveBeenCalledWith('prefetch:topic:health', 'mem-topics');
      expect(mockRedis.sadd).toHaveBeenCalledWith('prefetch:topic:family', 'mem-topics');
    });

    it('should set topic index TTL to 2x memory TTL', async () => {
      const memory = makeCachedMemory({
        id: 'mem-ttl2',
        topics: ['work'] as TopicId[],
      });

      mockRedis.sadd.mockResolvedValue(1);

      adapter.persist(memory, 30000); // 30s TTL
      await Promise.resolve();
      await Promise.resolve(); // extra tick for chained .then()

      expect(mockRedis.expire).toHaveBeenCalledWith('prefetch:topic:work', 60); // 30*2
    });

    it('should handle redis set failure silently (catch)', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('Redis down'));
      const memory = makeCachedMemory();

      // Should NOT throw
      expect(() => adapter.persist(memory, 5000)).not.toThrow();

      // Wait for promise rejection to be caught
      await new Promise((r) => setTimeout(r, 10));
    });

    it('should handle topic sadd failure silently', async () => {
      mockRedis.sadd.mockRejectedValueOnce(new Error('sadd fail'));
      const memory = makeCachedMemory({ topics: ['health'] as TopicId[] });

      expect(() => adapter.persist(memory, 5000)).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
    });

    it('should handle memory with no topics (empty array)', async () => {
      const memory = makeCachedMemory({ topics: [] });
      adapter.persist(memory, 5000);
      await Promise.resolve();

      expect(mockRedis.set).toHaveBeenCalled();
      expect(mockRedis.sadd).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // delete
  // =========================================================================
  describe('delete', () => {
    it('should delete memory key from Redis', async () => {
      adapter.delete('mem-del', []);
      await Promise.resolve();

      expect(mockRedis.del).toHaveBeenCalledWith('prefetch:cache:mem-del');
    });

    it('should remove memory ID from each topic set', async () => {
      adapter.delete('mem-del', ['work', 'technical'] as TopicId[]);
      await Promise.resolve();

      expect(mockRedis.srem).toHaveBeenCalledWith('prefetch:topic:work', 'mem-del');
      expect(mockRedis.srem).toHaveBeenCalledWith('prefetch:topic:technical', 'mem-del');
    });

    it('should handle redis del failure silently', async () => {
      mockRedis.del.mockRejectedValueOnce(new Error('del failed'));
      expect(() => adapter.delete('mem-x', [])).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
    });

    it('should handle srem failure silently', async () => {
      mockRedis.srem.mockRejectedValueOnce(new Error('srem failed'));
      expect(() => adapter.delete('mem-x', ['family'] as TopicId[])).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
    });

    it('should work with empty topics array', async () => {
      adapter.delete('mem-empty-topics', []);
      await Promise.resolve();

      expect(mockRedis.del).toHaveBeenCalled();
      expect(mockRedis.srem).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // deleteTopicIndex
  // =========================================================================
  describe('deleteTopicIndex', () => {
    it('should delete the topic index key', async () => {
      adapter.deleteTopicIndex('health' as TopicId);
      await Promise.resolve();

      expect(mockRedis.del).toHaveBeenCalledWith('prefetch:topic:health');
    });

    it('should handle del failure silently', async () => {
      mockRedis.del.mockRejectedValueOnce(new Error('del failed'));
      expect(() => adapter.deleteTopicIndex('work' as TopicId)).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  // =========================================================================
  // clearAll
  // =========================================================================
  describe('clearAll', () => {
    it('should scan with prefetch:* pattern and delete found keys', () => {
      const mockStream = {
        on: jest.fn((event, handler) => {
          if (event === 'data') {
            handler(['prefetch:cache:1', 'prefetch:cache:2']);
          }
          return mockStream;
        }),
      };
      mockRedis.scanStream.mockReturnValueOnce(mockStream);

      adapter.clearAll();

      expect(mockRedis.scanStream).toHaveBeenCalledWith({
        match: 'prefetch:*',
        count: 100,
      });
      expect(mockRedis.del).toHaveBeenCalledWith('prefetch:cache:1', 'prefetch:cache:2');
    });

    it('should not call del when scan returns empty batch', () => {
      const mockStream = {
        on: jest.fn((event, handler) => {
          if (event === 'data') {
            handler([]); // empty batch
          }
          return mockStream;
        }),
      };
      mockRedis.scanStream.mockReturnValueOnce(mockStream);

      adapter.clearAll();

      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // hydrate
  // =========================================================================
  describe('hydrate', () => {
    function setupScanStream(keys: string[]) {
      const mockStream = {
        on: jest.fn((event, handler) => {
          if (event === 'data') {
            handler(keys);
          } else if (event === 'end') {
            handler();
          }
          return mockStream;
        }),
      };
      mockRedis.scanStream.mockReturnValueOnce(mockStream);
    }

    it('should return empty array when no keys found', async () => {
      setupScanStream([]);

      const result = await adapter.hydrate(60000);

      expect(result).toEqual([]);
      expect(mockRedis.pipeline).not.toHaveBeenCalled();
    });

    it('should scan with prefetch:cache:* pattern', async () => {
      setupScanStream([]);

      await adapter.hydrate(60000);

      expect(mockRedis.scanStream).toHaveBeenCalledWith({
        match: 'prefetch:cache:*',
        count: 100,
      });
    });

    it('should return valid memories from pipeline results', async () => {
      const memory = makeCachedMemory({ cachedAt: Date.now() - 1000 }); // 1 second old

      setupScanStream(['prefetch:cache:mem-123']);
      mockPipeline.get.mockReturnThis();
      mockPipeline.exec.mockResolvedValue([[null, JSON.stringify(memory)]]);

      const result = await adapter.hydrate(60000); // 60s TTL

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('mem-123');
    });

    it('should filter out expired memories based on TTL', async () => {
      const expiredMemory = makeCachedMemory({
        id: 'expired',
        cachedAt: Date.now() - 120000, // 2 minutes ago
      });

      setupScanStream(['prefetch:cache:expired']);
      mockPipeline.exec.mockResolvedValue([[null, JSON.stringify(expiredMemory)]]);

      const result = await adapter.hydrate(60000); // 60s TTL

      expect(result).toHaveLength(0);
    });

    it('should skip entries with pipeline errors', async () => {
      setupScanStream(['prefetch:cache:bad']);
      mockPipeline.exec.mockResolvedValue([[new Error('read error'), null]]);

      const result = await adapter.hydrate(60000);

      expect(result).toHaveLength(0);
    });

    it('should skip null/undefined pipeline values', async () => {
      setupScanStream(['prefetch:cache:null-val']);
      mockPipeline.exec.mockResolvedValue([[null, null]]);

      const result = await adapter.hydrate(60000);

      expect(result).toHaveLength(0);
    });

    it('should skip malformed JSON entries', async () => {
      setupScanStream(['prefetch:cache:bad-json']);
      mockPipeline.exec.mockResolvedValue([[null, 'NOT_VALID_JSON']]);

      const result = await adapter.hydrate(60000);

      expect(result).toHaveLength(0);
    });

    it('should return empty array if pipeline exec returns null', async () => {
      setupScanStream(['prefetch:cache:some-key']);
      mockPipeline.exec.mockResolvedValue(null);

      const result = await adapter.hydrate(60000);

      expect(result).toHaveLength(0);
    });

    it('should reject if scanStream emits error', async () => {
      const mockStream = {
        on: jest.fn((event, handler) => {
          if (event === 'error') {
            handler(new Error('Redis scan error'));
          }
          return mockStream;
        }),
      };
      mockRedis.scanStream.mockReturnValueOnce(mockStream);

      await expect(adapter.hydrate(60000)).rejects.toThrow('Redis scan error');
    });

    it('should hydrate multiple valid memories in one call', async () => {
      const now = Date.now();
      const m1 = makeCachedMemory({ id: 'mem-1', cachedAt: now - 1000 });
      const m2 = makeCachedMemory({ id: 'mem-2', cachedAt: now - 2000 });

      setupScanStream(['prefetch:cache:mem-1', 'prefetch:cache:mem-2']);
      mockPipeline.exec.mockResolvedValue([
        [null, JSON.stringify(m1)],
        [null, JSON.stringify(m2)],
      ]);

      const result = await adapter.hydrate(60000);

      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toContain('mem-1');
      expect(result.map((m) => m.id)).toContain('mem-2');
    });
  });
});
