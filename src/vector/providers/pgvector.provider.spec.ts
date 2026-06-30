import { Test, TestingModule } from '@nestjs/testing';
import { PgVectorProvider } from './pgvector.provider';
import { PrismaService } from '../../prisma/prisma.service';
import { VectorRecord, VectorSearchResult } from '../vector.interface';

// bge-base is the default model when EMBEDDING_MODEL / VECTOR_SEARCH_MODEL are unset
const BGE_DIMS = 768;
const makeEmbedding = (dims: number, fill = 0.1) =>
  new Array(dims).fill(fill).map((v, i) => v + i * 0.0001);

describe('PgVectorProvider', () => {
  let provider: PgVectorProvider;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      $executeRawUnsafe: jest.fn(),
      $executeRaw: jest.fn(),
      $queryRawUnsafe: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PgVectorProvider,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    provider = module.get<PgVectorProvider>(PgVectorProvider);
  });

  describe('name', () => {
    it('should be pgvector', () => {
      expect(provider.name).toBe('pgvector');
    });
  });

  describe('isConfigured', () => {
    it('should always return true (pgvector works with Postgres)', () => {
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('upsert', () => {
    it('768-dim vector writes inline column AND memory_embeddings', async () => {
      // inline UPDATE returns 1 → memory exists → memory_embeddings upsert fires
      mockPrisma.$executeRawUnsafe.mockResolvedValue(1);

      const embedding = makeEmbedding(BGE_DIMS);
      const record: VectorRecord = { id: 'mem-123', embedding };

      await provider.upsert(record);

      // First call: inline UPDATE memories SET embedding = ...
      const updateCall = mockPrisma.$executeRawUnsafe.mock.calls[0];
      expect(updateCall[0]).toContain('UPDATE memories');
      expect(updateCall[1]).toMatch(/^\[[\d.,e+-]+\]$/);
      expect(updateCall[2]).toBe('mem-123');

      // Second call: INSERT into memory_embeddings
      const insertCall = mockPrisma.$executeRawUnsafe.mock.calls[1];
      expect(insertCall[0]).toContain('memory_embeddings');
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    });

    it('768-dim vector formats embedding as pgvector string literal', async () => {
      mockPrisma.$executeRawUnsafe.mockResolvedValue(1);

      const embedding = makeEmbedding(BGE_DIMS);
      const record: VectorRecord = { id: 'mem-456', embedding };

      await provider.upsert(record);

      const callArgs = mockPrisma.$executeRawUnsafe.mock.calls[0];
      expect(callArgs[1]).toMatch(/^\[[\d.,e+-]+\]$/);
    });

    it('1536-dim (openai-small) skips inline UPDATE, writes memory_embeddings when memory exists', async () => {
      const savedModel = process.env.EMBEDDING_MODEL;
      process.env.EMBEDDING_MODEL = 'openai-small';

      const module2 = await Test.createTestingModule({
        providers: [
          PgVectorProvider,
          { provide: PrismaService, useValue: mockPrisma },
        ],
      }).compile();
      const p2 = module2.get<PgVectorProvider>(PgVectorProvider);

      // SELECT 1 existence check returns one row → memory exists
      mockPrisma.$queryRawUnsafe.mockResolvedValue([{ exists: 1 }]);
      mockPrisma.$executeRawUnsafe.mockResolvedValue(undefined);

      const largeEmbedding = makeEmbedding(1536, 0.2);
      const record: VectorRecord = { id: 'mem-large', embedding: largeEmbedding };

      await p2.upsert(record);

      // Should NOT call inline UPDATE
      const updateCall = mockPrisma.$executeRawUnsafe.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE memories SET embedding'),
      );
      expect(updateCall).toBeUndefined();

      // Should call SELECT 1 existence check via $queryRawUnsafe
      const existsCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('SELECT 1') && c[0].includes('FROM memories'),
      );
      expect(existsCall).toBeDefined();
      expect(existsCall[1]).toBe('mem-large');

      // Should write to memory_embeddings
      const insertCall = mockPrisma.$executeRawUnsafe.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('memory_embeddings'),
      );
      expect(insertCall).toBeDefined();

      if (savedModel === undefined) delete process.env.EMBEDDING_MODEL;
      else process.env.EMBEDDING_MODEL = savedModel;
    });

    it('1536-dim skips memory_embeddings insert for non-memory IDs (hierarchy_*)', async () => {
      const savedModel = process.env.EMBEDDING_MODEL;
      process.env.EMBEDDING_MODEL = 'openai-small';

      const module2 = await Test.createTestingModule({
        providers: [
          PgVectorProvider,
          { provide: PrismaService, useValue: mockPrisma },
        ],
      }).compile();
      const p2 = module2.get<PgVectorProvider>(PgVectorProvider);

      // SELECT 1 returns empty — ID is not a real memory row
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const record: VectorRecord = {
        id: 'hierarchy_l0_abc123',
        embedding: makeEmbedding(1536, 0.3),
      };

      await p2.upsert(record);

      // No insert into memory_embeddings
      const insertCall = mockPrisma.$executeRawUnsafe.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('memory_embeddings'),
      );
      expect(insertCall).toBeUndefined();

      if (savedModel === undefined) delete process.env.EMBEDDING_MODEL;
      else process.env.EMBEDDING_MODEL = savedModel;
    });

    it('should reject non-finite values before serializing', async () => {
      // Use correct dims so dimension guard passes; NaN guard fires after
      const embedding = makeEmbedding(BGE_DIMS);
      embedding[1] = Number.NaN;
      const record: VectorRecord = { id: 'mem-bad', embedding };

      await expect(provider.upsert(record)).rejects.toThrow(
        'contains non-finite values',
      );
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('should reject wrong-dimension embeddings (dimension guard)', async () => {
      const record: VectorRecord = {
        id: 'mem-wrong-dim',
        embedding: [0.1, 0.2, 0.3, 0.4], // 4-dim, not BGE_DIMS=768
      };

      await expect(provider.upsert(record)).rejects.toThrow(
        'Dimension mismatch',
      );
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe('upsertMany', () => {
    it('should upsert multiple records sequentially', async () => {
      // inline UPDATE returns 1 for each record (all are real memories)
      mockPrisma.$executeRawUnsafe.mockResolvedValue(1);

      const records: VectorRecord[] = [
        { id: 'mem-1', embedding: makeEmbedding(BGE_DIMS, 0.1) },
        { id: 'mem-2', embedding: makeEmbedding(BGE_DIMS, 0.2) },
        { id: 'mem-3', embedding: makeEmbedding(BGE_DIMS, 0.3) },
      ];

      await provider.upsertMany(records);

      // 2 calls per record (inline UPDATE + memory_embeddings INSERT) = 6
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(6);
    });

    it('should handle empty array', async () => {
      await provider.upsertMany([]);

      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe('search', () => {
    beforeEach(() => {
      // Default: runtime check returns 0 unmigrated (skip fallback)
      mockPrisma.$queryRawUnsafe.mockImplementation(
        (sql: string, ...args: any[]) => {
          if (sql.includes('COUNT(*)') && sql.includes('NOT IN')) {
            return Promise.resolve([{ count: BigInt(0) }]);
          }
          return Promise.resolve([]);
        },
      );
    });

    it('should skip legacy fallback when DISABLE_LEGACY_EMBEDDING_FALLBACK is set', async () => {
      const originalEnv = process.env.DISABLE_LEGACY_EMBEDDING_FALLBACK;
      process.env.DISABLE_LEGACY_EMBEDDING_FALLBACK = 'true';

      // Re-create provider to pick up env
      const module2: TestingModule = await Test.createTestingModule({
        providers: [
          PgVectorProvider,
          { provide: PrismaService, useValue: mockPrisma },
        ],
      }).compile();
      const flagProvider = module2.get<PgVectorProvider>(PgVectorProvider);

      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
      await flagProvider.search([0.1], { userId: 'user-123' });

      const query = mockPrisma.$queryRawUnsafe.mock.calls.find(
        (c: any[]) =>
          typeof c[0] === 'string' && c[0].includes('JOIN memory_embeddings'),
      );
      expect(query).toBeDefined();
      expect(query[0]).not.toContain('UNION ALL');

      process.env.DISABLE_LEGACY_EMBEDDING_FALLBACK = originalEnv || '';
      if (!originalEnv) delete process.env.DISABLE_LEGACY_EMBEDDING_FALLBACK;
    });

    it('should include legacy fallback when unmigrated memories exist', async () => {
      mockPrisma.$queryRawUnsafe.mockImplementation((sql: string) => {
        if (sql.includes('COUNT(*)') && sql.includes('NOT IN')) {
          return Promise.resolve([{ count: BigInt(5) }]);
        }
        return Promise.resolve([]);
      });

      // Reset cache by creating fresh provider
      const module2: TestingModule = await Test.createTestingModule({
        providers: [
          PgVectorProvider,
          { provide: PrismaService, useValue: mockPrisma },
        ],
      }).compile();
      const freshProvider = module2.get<PgVectorProvider>(PgVectorProvider);

      await freshProvider.search([0.1], { userId: 'user-123' });

      const query = mockPrisma.$queryRawUnsafe.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('UNION ALL'),
      );
      expect(query).toBeDefined();
    });

    it('should search for similar vectors', async () => {
      const mockResults: Array<{ id: string; score: number }> = [
        { id: 'mem-1', score: 0.95 },
        { id: 'mem-2', score: 0.88 },
      ];
      mockPrisma.$queryRawUnsafe.mockResolvedValue(mockResults);

      const result = await provider.search([0.1, 0.2, 0.3], {
        userId: 'user-123',
        limit: 10,
      });

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        '[0.1,0.2,0.3]',
        'bge-base',
        'user-123',
      );
      expect(result).toEqual([
        { id: 'mem-1', score: 0.95 },
        { id: 'mem-2', score: 0.88 },
      ]);
    });

    it('should reject invalid query embeddings before querying', async () => {
      await expect(
        provider.search([0.1, Number.POSITIVE_INFINITY], {
          userId: 'user-123',
          limit: 10,
        }),
      ).rejects.toThrow('contains non-finite values');
      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('should filter by layers when provided', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.search([0.1], {
        userId: 'user-123',
        limit: 10,
        filter: {
          layers: ['IDENTITY', 'PROJECT'],
        },
      });

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('layer IN'),
        '[0.1]',
        'bge-base',
        'user-123',
        'IDENTITY',
        'PROJECT',
      );
    });

    it('should filter by projectId when provided', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.search([0.1], {
        userId: 'user-123',
        limit: 10,
        filter: {
          projectId: 'project-456',
        },
      });

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('project_id'),
        '[0.1]',
        'bge-base',
        'user-123',
        'project-456',
      );
    });

    it('should filter by both layers and projectId', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.search([0.1], {
        userId: 'user-123',
        limit: 5,
        filter: {
          layers: ['SESSION'],
          projectId: 'project-789',
        },
      });

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('layer IN'),
        '[0.1]',
        'bge-base',
        'user-123',
        'SESSION',
        'project-789',
      );
    });

    it('should use default limit of 10', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.search([0.1], { userId: 'user-123' });

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT 10'),
        '[0.1]',
        'bge-base',
        'user-123',
      );
    });

    it('should use cosine distance for similarity', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.search([0.1], { userId: 'user-123' });

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('<=>'), // Cosine distance operator
        '[0.1]',
        'bge-base',
        'user-123',
      );
    });

    it('should exclude deleted memories', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.search([0.1], { userId: 'user-123' });

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('deleted_at IS NULL'),
        '[0.1]',
        'bge-base',
        'user-123',
      );
    });

    it('should exclude memories without embeddings', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.search([0.1], { userId: 'user-123' });

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('embedding IS NOT NULL'),
        '[0.1]',
        'bge-base',
        'user-123',
      );
    });

    it('should exclude non-survivor memories from recall candidates', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.search([0.1], { userId: 'user-123' });

      const sql = mockPrisma.$queryRawUnsafe.mock.calls.find(
        (c: any[]) =>
          typeof c[0] === 'string' &&
          c[0].includes('SELECT') &&
          c[0].includes('m.id') &&
          c[0].includes('JOIN memory_embeddings'),
      )?.[0];

      expect(sql).toContain('m.superseded_by_id IS NULL');
      expect(sql).toContain('m.searchable IS NOT FALSE');
      expect(sql).toContain("m.embedding_status != 'DUPLICATE'");
    });

    it('should filter by tags with array containment (ENG-42)', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.search([0.1], {
        userId: 'user-123',
        limit: 10,
        filter: {
          tags: ['google-ads', 'campaign'],
        },
      });

      const call = mockPrisma.$queryRawUnsafe.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('tags @>'),
      );
      expect(call).toBeDefined();
      expect(call[0]).toContain('m.tags @> ARRAY[');
      // Tags should be passed as individual params
      expect(call).toContain('google-ads');
      expect(call).toContain('campaign');
    });

    it('should filter by metadata with JSONB containment (ENG-42)', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.search([0.1], {
        userId: 'user-123',
        limit: 10,
        filter: {
          metadata: { client: 'acme', env: 'prod' },
        },
      });

      const call = mockPrisma.$queryRawUnsafe.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('metadata @>'),
      );
      expect(call).toBeDefined();
      expect(call[0]).toContain('m.metadata @>');
      // Metadata should be passed as JSON string param
      expect(call).toContain(JSON.stringify({ client: 'acme', env: 'prod' }));
    });

    it('should combine tags, metadata, and pool filters (ENG-42)', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await provider.search([0.1], {
        userId: 'user-123',
        limit: 10,
        filter: {
          poolIds: ['pool-1'],
          tags: ['tag-a'],
          metadata: { key: 'val' },
        },
      });

      const call = mockPrisma.$queryRawUnsafe.mock.calls.find(
        (c: any[]) =>
          typeof c[0] === 'string' &&
          c[0].includes('tags @>') &&
          c[0].includes('metadata @>') &&
          c[0].includes('memory_pool_memberships'),
      );
      expect(call).toBeDefined();
    });

    it('should convert score to number', async () => {
      // Prisma might return score as string or bigint
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { id: 'mem-1', score: '0.95' },
        { id: 'mem-2', score: 0.88 },
      ]);

      const result = await provider.search([0.1], { userId: 'user-123' });

      expect(typeof result[0].score).toBe('number');
      expect(typeof result[1].score).toBe('number');
    });
  });

  describe('delete', () => {
    it('should set embedding to NULL', async () => {
      await provider.delete('mem-123');

      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });
  });

  describe('deleteByUser', () => {
    it('should set all user embeddings to NULL', async () => {
      await provider.deleteByUser('user-456');

      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });
  });
});
