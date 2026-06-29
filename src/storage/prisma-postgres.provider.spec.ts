import { Test, TestingModule } from '@nestjs/testing';
import { PrismaPostgresProvider } from './prisma-postgres.provider';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingWriteService } from '../vector/embedding-write.service';

const mockPrisma = {
  memory: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    aggregate: jest.fn(),
  },
  mergeCandidate: {
    create: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
};

const mockEmbeddingWrite = {
  writeLegacyInlineEmbedding: jest.fn().mockResolvedValue(undefined),
  writeMemoryEmbedding: jest.fn().mockResolvedValue(undefined),
};

describe('PrismaPostgresProvider', () => {
  let provider: PrismaPostgresProvider;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaPostgresProvider,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbeddingWriteService, useValue: mockEmbeddingWrite },
      ],
    }).compile();

    provider = module.get<PrismaPostgresProvider>(PrismaPostgresProvider);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
    expect(provider.name).toBe('prisma-postgres');
  });

  // ── Memory CRUD ──────────────────────────────────────────────────────

  describe('createMemory', () => {
    it('should create a memory without embedding', async () => {
      const data = {
        userId: 'u1',
        raw: 'hello world',
        layer: 'IDENTITY' as any,
      };
      const mockResult = { id: 'm1', ...data, createdAt: new Date() };
      mockPrisma.memory.create.mockResolvedValue(mockResult);

      const result = await provider.createMemory(data);
      expect(result.id).toBe('m1');
      expect(mockPrisma.memory.create).toHaveBeenCalledWith({ data });
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('should create a memory with embedding', async () => {
      const data = {
        userId: 'u1',
        raw: 'hello',
        layer: 'IDENTITY' as any,
        embedding: [0.1, 0.2],
      };
      const mockResult = {
        id: 'm1',
        userId: 'u1',
        raw: 'hello',
        layer: 'IDENTITY',
      };
      mockPrisma.memory.create.mockResolvedValue(mockResult);

      await provider.createMemory(data);
      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: { userId: 'u1', raw: 'hello', layer: 'IDENTITY' },
      });
      expect(mockEmbeddingWrite.writeLegacyInlineEmbedding).toHaveBeenCalledWith(
        'm1',
        [0.1, 0.2],
      );
    });
  });

  describe('getMemory', () => {
    it('should get a memory by id', async () => {
      const mockResult = { id: 'm1', raw: 'test' };
      mockPrisma.memory.findUnique.mockResolvedValue(mockResult);

      const result = await provider.getMemory('m1');
      expect(result).toEqual(mockResult);
      expect(mockPrisma.memory.findUnique).toHaveBeenCalledWith({
        where: { id: 'm1' },
        include: undefined,
      });
    });

    it('should get a memory with extraction included', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        id: 'm1',
        extraction: { who: 'user' },
      });

      const result = await provider.getMemory('m1', { extraction: true });
      expect(result?.extraction).toBeDefined();
      expect(mockPrisma.memory.findUnique).toHaveBeenCalledWith({
        where: { id: 'm1' },
        include: { extraction: true },
      });
    });

    it('should return null for non-existent memory', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue(null);

      const result = await provider.getMemory('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('updateMemory', () => {
    it('should update a memory', async () => {
      const mockResult = { id: 'm1', raw: 'updated' };
      mockPrisma.memory.update.mockResolvedValue(mockResult);

      const result = await provider.updateMemory('m1', { raw: 'updated' });
      expect(result.raw).toBe('updated');
    });

    it('should update embedding separately', async () => {
      mockPrisma.memory.update.mockResolvedValue({ id: 'm1' });

      await provider.updateMemory('m1', {
        raw: 'updated',
        embedding: [0.3, 0.4],
      });
      expect(mockEmbeddingWrite.writeLegacyInlineEmbedding).toHaveBeenCalledWith(
        'm1',
        [0.3, 0.4],
      );
    });
  });

  describe('incrementMemory', () => {
    it('should increment fields', async () => {
      mockPrisma.memory.update.mockResolvedValue({ id: 'm1', usedCount: 2 });

      await provider.incrementMemory(
        'm1',
        { usedCount: 1 },
        { lastUsedAt: new Date() },
      );
      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({
          usedCount: { increment: 1 },
        }),
      });
    });
  });

  describe('deleteMemory', () => {
    it('should soft-delete a memory', async () => {
      mockPrisma.memory.update.mockResolvedValue({
        id: 'm1',
        deletedAt: new Date(),
      });

      await provider.deleteMemory('m1');
      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });

  // ── Queries ──────────────────────────────────────────────────────────

  describe('findMemories', () => {
    it('should find memories with filters', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        { id: 'm1' },
        { id: 'm2' },
      ]);

      const result = await provider.findMemories(
        { userId: 'u1', deletedAt: null },
        { limit: 10, orderBy: 'createdAt', orderDirection: 'desc' },
      );
      expect(result).toHaveLength(2);
      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', deletedAt: null },
        include: undefined,
        orderBy: { createdAt: 'desc' },
        take: 10,
        skip: undefined,
      });
    });

    it('should handle layer filter', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([]);

      await provider.findMemories({ layers: ['IDENTITY', 'PROJECT'] as any[] });
      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { layer: { in: ['IDENTITY', 'PROJECT'] } },
        }),
      );
    });

    it('should handle date range filters', async () => {
      const start = new Date('2024-01-01');
      const end = new Date('2024-12-31');
      mockPrisma.memory.findMany.mockResolvedValue([]);

      await provider.findMemories({ createdAtGte: start, createdAtLte: end });
      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdAt: { gte: start, lte: end } },
        }),
      );
    });

    it('should handle ids filter', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([]);

      await provider.findMemories({ ids: ['m1', 'm2'] });
      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['m1', 'm2'] } },
        }),
      );
    });
  });

  describe('countMemories', () => {
    it('should count memories', async () => {
      mockPrisma.memory.count.mockResolvedValue(42);

      const result = await provider.countMemories({
        userId: 'u1',
        deletedAt: null,
      });
      expect(result).toBe(42);
    });
  });

  describe('updateManyMemories', () => {
    it('should update many memories', async () => {
      mockPrisma.memory.updateMany.mockResolvedValue({ count: 5 });

      const result = await provider.updateManyMemories(
        { ids: ['m1', 'm2', 'm3', 'm4', 'm5'] },
        { consolidated: true },
      );
      expect(result).toBe(5);
    });
  });

  // ── Vector Search ────────────────────────────────────────────────────

  describe('vectorSearch', () => {
    it('should perform vector similarity search', async () => {
      const mockResults = [
        { id: 'm1', score: 0.95 },
        { id: 'm2', score: 0.82 },
      ];
      mockPrisma.$queryRawUnsafe.mockResolvedValue(mockResults);

      const result = await provider.vectorSearch([0.1, 0.2, 0.3], {
        limit: 5,
        filters: { userId: 'u1' },
      });

      expect(result).toHaveLength(2);
      expect(result[0].score).toBe(0.95);
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
      // Verify the SQL includes the cosine distance operator
      const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).toContain('<=>');
      expect(sql).toContain('embedding');
    });

    it('should apply threshold filter', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.vectorSearch([0.1], { limit: 5, threshold: 0.7 });
      const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).toContain('>=');
    });
  });

  describe('getMemoryEmbedding', () => {
    it('should return parsed embedding', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { embedding: '[0.1,0.2,0.3]' },
      ]);

      const result = await provider.getMemoryEmbedding('m1');
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it('should return null if no embedding', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await provider.getMemoryEmbedding('m1');
      expect(result).toBeNull();
    });
  });

  // ── Bulk Operations ──────────────────────────────────────────────────

  describe('bulkCreate', () => {
    it('should create multiple memories in a transaction', async () => {
      const data = [
        { userId: 'u1', raw: 'a', layer: 'IDENTITY' as any },
        { userId: 'u1', raw: 'b', layer: 'SESSION' as any },
      ];

      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          memory: {
            create: jest
              .fn()
              .mockResolvedValueOnce({ id: 'm1', ...data[0] })
              .mockResolvedValueOnce({ id: 'm2', ...data[1] }),
          },
          $executeRawUnsafe: jest.fn(),
        };
        return fn(tx);
      });

      const result = await provider.bulkCreate(data);
      expect(result).toHaveLength(2);
    });
  });

  // ── Stats ────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('should return storage stats', async () => {
      mockPrisma.memory.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(90) // active
        .mockResolvedValueOnce(10) // deleted
        .mockResolvedValueOnce(5); // consolidated

      mockPrisma.memory.groupBy
        .mockResolvedValueOnce([
          { layer: 'IDENTITY', _count: { _all: 30 } },
          { layer: 'SESSION', _count: { _all: 60 } },
        ])
        .mockResolvedValueOnce([{ memoryType: 'FACT', _count: { _all: 40 } }]);

      const result = await provider.getStats('u1');
      expect(result.totalMemories).toBe(100);
      expect(result.activeMemories).toBe(90);
      expect(result.deletedMemories).toBe(10);
      expect(result.consolidatedMemories).toBe(5);
      expect(result.layerDistribution.IDENTITY).toBe(30);
      expect(result.memoryTypeDistribution?.FACT).toBe(40);
    });
  });

  describe('groupBy', () => {
    it('should group by field', async () => {
      mockPrisma.memory.groupBy.mockResolvedValue([
        { layer: 'IDENTITY', _count: { _all: 30 } },
        { layer: 'SESSION', _count: { _all: 60 } },
      ]);

      const result = await provider.groupBy('layer', { userId: 'u1' });
      expect(result).toEqual([
        { value: 'IDENTITY', count: 30 },
        { value: 'SESSION', count: 60 },
      ]);
    });
  });

  describe('aggregate', () => {
    it('should aggregate numeric field', async () => {
      mockPrisma.memory.aggregate.mockResolvedValue({
        _avg: { importanceScore: 0.75 },
      });

      const result = await provider.aggregate('importanceScore', 'avg', {
        userId: 'u1',
      });
      expect(result).toBe(0.75);
    });
  });

  // ── Merge / Dedup ────────────────────────────────────────────────────

  describe('createMergeCandidate', () => {
    it('should create a merge candidate', async () => {
      const data = {
        userId: 'u1',
        memoryIds: ['m1', 'm2'],
        similarity: 0.92,
        suggestedStrategy: 'MERGE',
        suggestedSurvivorId: 'm1',
        status: 'PENDING',
      };
      mockPrisma.mergeCandidate.create.mockResolvedValue({
        id: 'mc1',
        ...data,
      });

      const result = await provider.createMergeCandidate(data);
      expect(result.id).toBe('mc1');
    });
  });

  // ── Health ───────────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('should return healthy when DB is reachable', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(true);
      expect(result.provider).toBe('prisma-postgres');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy when DB is unreachable', async () => {
      mockPrisma.$queryRaw.mockRejectedValue(new Error('Connection refused'));

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.details?.error).toBe('Connection refused');
    });
  });
});
