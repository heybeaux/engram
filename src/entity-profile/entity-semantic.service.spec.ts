import { EntitySemanticService } from './entity-semantic.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const mockPrisma = {
  memory: {
    findFirst: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const cfg: Record<string, string> = {
      LOCAL_EMBED_URL: 'http://localhost:8080',
    };
    return cfg[key] ?? defaultValue;
  }),
};

describe('EntitySemanticService', () => {
  let service: EntitySemanticService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new EntitySemanticService(mockPrisma as any, mockConfig as any);
  });

  // ─── findSemanticMatches ────────────────────────────────────────────────────

  describe('findSemanticMatches', () => {
    it('should return empty array when memory not found', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue(null);

      const result = await service.findSemanticMatches('mem-1', 'user-1');
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return empty array when no profiles exist', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({
        raw: 'some memory text',
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      });
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.findSemanticMatches('mem-1', 'user-1');
      expect(result).toEqual([]);
    });

    it('should return empty array when embed fails', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({
        raw: 'some memory text',
      });
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server Error',
      });

      const result = await service.findSemanticMatches('mem-1', 'user-1');
      expect(result).toEqual([]);
    });

    it('should return matching profiles above threshold', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'I love hiking' });

      // Embed memory — returns [1, 0, 0]
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
      });

      // Profile A: [1, 0, 0] → similarity 1.0 (above 0.75)
      // Profile B: [0, 1, 0] → similarity 0.0 (below 0.75)
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-a', embedding: '[1,0,0]' },
        { id: 'profile-b', embedding: '[0,1,0]' },
      ]);

      const result = await service.findSemanticMatches('mem-1', 'user-1', 0.75);

      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe('profile-a');
      expect(result[0].similarity).toBeCloseTo(1.0);
    });

    it('should sort results by descending similarity', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [1, 1, 0] }] }),
      });

      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-low', embedding: '[0.8,0,0]' },
        { id: 'profile-high', embedding: '[1,1,0]' },
      ]);

      const result = await service.findSemanticMatches('mem-1', 'user-1', 0.5);

      expect(result[0].similarity).toBeGreaterThan(result[1].similarity);
      expect(result[0].profileId).toBe('profile-high');
    });

    it('should skip profiles with null embedding', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
      });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-null', embedding: null },
        { id: 'profile-valid', embedding: '[1,0,0]' },
      ]);

      const result = await service.findSemanticMatches('mem-1', 'user-1', 0.5);

      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe('profile-valid');
    });

    it('should skip profiles with mismatched vector dimensions (no crash)', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
      });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-mismatched', embedding: '[1,0]' }, // 2d vs 3d
        { id: 'profile-ok', embedding: '[1,0,0]' },
      ]);

      const result = await service.findSemanticMatches('mem-1', 'user-1', 0.5);

      // Mismatched profile should be skipped (caught internally), valid one returned
      expect(result.some((r) => r.profileId === 'profile-ok')).toBe(true);
      expect(result.some((r) => r.profileId === 'profile-mismatched')).toBe(
        false,
      );
    });

    it('should use custom threshold when provided', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
      });
      // Similarity will be ~0.7071 for [0.707, 0.707, 0]
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-mid', embedding: '[0.707,0.707,0]' },
      ]);

      const resultAbove = await service.findSemanticMatches(
        'mem-1',
        'user-1',
        0.5,
      );
      expect(resultAbove).toHaveLength(1);

      jest.clearAllMocks();
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
      });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-mid', embedding: '[0.707,0.707,0]' },
      ]);
      const resultBelow = await service.findSemanticMatches(
        'mem-1',
        'user-1',
        0.99,
      );
      expect(resultBelow).toHaveLength(0);
    });

    it('should parse both bracket styles of postgres vectors', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
      });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-curly', embedding: '{1,0,0}' }, // curly brace format
      ]);

      const result = await service.findSemanticMatches('mem-1', 'user-1', 0.5);
      expect(result).toHaveLength(1);
      expect(result[0].similarity).toBeCloseTo(1.0);
    });
  });

  // ─── embed ──────────────────────────────────────────────────────────────────

  describe('embed', () => {
    it('should return embedding array on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      });

      const result = await service.embed('hello world');

      expect(result).toEqual([0.1, 0.2, 0.3]);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/embeddings',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should throw on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

      await expect(service.embed('test')).rejects.toThrow(
        'Embed server error 503',
      );
    });

    it('should throw when response has no data array', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'unexpected' }),
      });

      await expect(service.embed('test')).rejects.toThrow(
        'Invalid response from embed server',
      );
    });

    it('should throw when first data item has no embedding', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ object: 'embedding' }] }),
      });

      await expect(service.embed('test')).rejects.toThrow(
        'Invalid response from embed server',
      );
    });

    it('should use LOCAL_EMBED_URL from config', async () => {
      const customConfig = {
        get: jest.fn((key: string, def?: any) => {
          if (key === 'LOCAL_EMBED_URL') return 'http://custom-embed:9999';
          return def;
        }),
      };
      const customService = new EntitySemanticService(
        mockPrisma as any,
        customConfig as any,
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.5] }] }),
      });

      await customService.embed('test');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://custom-embed:9999/v1/embeddings',
        expect.anything(),
      );
    });
  });

  // ─── cosineSimilarity (via public surface / findSemanticMatches) ────────────

  describe('cosine similarity edge cases', () => {
    it('should return 0 when one vector is all zeros', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0, 0, 0] }] }),
      });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-a', embedding: '[1,0,0]' },
      ]);

      // Zero vector memory → similarity should be 0 (denom = 0 guard)
      const result = await service.findSemanticMatches('mem-1', 'user-1', -1); // threshold -1 to accept everything
      expect(result).toHaveLength(1);
      expect(result[0].similarity).toBe(0);
    });

    it('should handle identical vectors with similarity 1.0', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ raw: 'test' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.5, 0.5, 0.5] }] }),
      });
      mockPrisma.$queryRaw.mockResolvedValue([
        { id: 'profile-same', embedding: '[0.5,0.5,0.5]' },
      ]);

      const result = await service.findSemanticMatches('mem-1', 'user-1', 0.99);
      expect(result).toHaveLength(1);
      expect(result[0].similarity).toBeCloseTo(1.0);
    });
  });
});
