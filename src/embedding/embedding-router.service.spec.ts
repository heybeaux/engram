import { Test, TestingModule } from '@nestjs/testing';
import { EmbeddingRouterService, PerModelId } from './embedding-router.service';
import { PrismaService } from '../prisma/prisma.service';

const makeVec = (dim: number, fill = 0.5) => Array(dim).fill(fill);

const mockPrisma = {
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
};

describe('EmbeddingRouterService', () => {
  let service: EmbeddingRouterService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbeddingRouterService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<EmbeddingRouterService>(EmbeddingRouterService);
  });

  // ── writeEmbedding ──────────────────────────────────────────────────────────

  describe('writeEmbedding', () => {
    it.each<[PerModelId, string]>([
      ['openai-small', 'embedding_openai_small'],
      ['bge-base', 'embedding_bge_base'],
      ['minilm', 'embedding_minilm'],
      ['nomic', 'embedding_nomic'],
    ])('routes %s to table %s', async (model, expectedTable) => {
      mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
      const vec = makeVec(4);

      await service.writeEmbedding('mem-1', model, vec);

      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      const [sql, , , , vecStr] = mockPrisma.$executeRawUnsafe.mock.calls[0];
      expect(sql).toContain(`"${expectedTable}"`);
      expect(vecStr).toBe(`[${vec.join(',')}]`);
    });

    it('uses provided modelVersion string', async () => {
      mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
      await service.writeEmbedding(
        'mem-1',
        'minilm',
        makeVec(4),
        'all-MiniLM-L6-v2',
      );

      const [, , , version] = mockPrisma.$executeRawUnsafe.mock.calls[0];
      expect(version).toBe('all-MiniLM-L6-v2');
    });

    it('falls back to model id when no version provided', async () => {
      mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
      await service.writeEmbedding('mem-2', 'bge-base', makeVec(4));

      const [, , , version] = mockPrisma.$executeRawUnsafe.mock.calls[0];
      expect(version).toBe('bge-base');
    });

    it.each<[string, unknown[]]>([
      ['NaN slot', [0.1, Number.NaN, 0.3, 0.4]],
      ['null slot', [0.1, null, 0.3, 0.4]],
      ['undefined slot', [0.1, undefined, 0.3, 0.4]],
      ['Infinity slot', [0.1, Number.POSITIVE_INFINITY, 0.3, 0.4]],
      ['empty array', []],
    ])(
      'rejects malformed vector (%s) before touching prisma',
      async (_label, vector) => {
        await expect(
          service.writeEmbedding('mem-bad', 'minilm', vector as number[]),
        ).rejects.toThrow(/Invalid embedding/);
        expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
      },
    );
  });

  // ── queryByModel ────────────────────────────────────────────────────────────

  describe('queryByModel', () => {
    it('returns mapped rows ordered by score', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { memory_id: 'a', model_version: 'v1', score: 0.9 },
        { memory_id: 'b', model_version: 'v1', score: 0.7 },
      ]);

      const result = await service.queryByModel('minilm', makeVec(4), 5);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        memoryId: 'a',
        modelVersion: 'v1',
        score: 0.9,
      });
      expect(result[1]).toEqual({
        memoryId: 'b',
        modelVersion: 'v1',
        score: 0.7,
      });
    });

    it('passes correct table and k to prisma', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
      await service.queryByModel('openai-small', makeVec(3), 10);

      const [sql, , limit] = mockPrisma.$queryRawUnsafe.mock.calls[0];
      expect(sql).toContain('"embedding_openai_small"');
      expect(limit).toBe(10);
    });

    it('rejects malformed query vector before touching prisma', async () => {
      await expect(
        service.queryByModel('minilm', [0.1, Number.NaN, 0.3] as number[], 5),
      ).rejects.toThrow(/Invalid embedding/);
      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });
  });

  // ── queryUnion ──────────────────────────────────────────────────────────────

  describe('queryUnion', () => {
    it('returns empty array when no models given', async () => {
      const result = await service.queryUnion([], makeVec(4), 5);
      expect(result).toEqual([]);
      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('deduplicates by memoryId keeping highest normalised score', async () => {
      // Model A returns mem-1 with score 0.9, mem-2 with 0.5
      // Model B returns mem-1 with score 0.8, mem-3 with 0.4
      const callResults = [
        [
          { memory_id: 'mem-1', model_version: 'a', score: 0.9 },
          { memory_id: 'mem-2', model_version: 'a', score: 0.5 },
        ],
        [
          { memory_id: 'mem-1', model_version: 'b', score: 0.8 },
          { memory_id: 'mem-3', model_version: 'b', score: 0.4 },
        ],
      ];
      let call = 0;
      mockPrisma.$queryRawUnsafe.mockImplementation(() =>
        Promise.resolve(callResults[call++] ?? []),
      );

      const result = await service.queryUnion(
        ['bge-base', 'minilm'],
        makeVec(4),
        5,
      );

      // mem-1 should appear once
      const ids = result.map((r) => r.memoryId);
      expect(ids.filter((id) => id === 'mem-1')).toHaveLength(1);
      // All three unique memories present
      expect(new Set(ids).size).toBe(3);
    });

    it('respects k limit in final result', async () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({
        memory_id: `mem-${i}`,
        model_version: 'v1',
        score: 1 - i * 0.05,
      }));
      mockPrisma.$queryRawUnsafe.mockResolvedValue(rows);

      const result = await service.queryUnion(['minilm'], makeVec(4), 3);
      expect(result).toHaveLength(3);
    });

    it('handles model returning empty results gracefully', async () => {
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { memory_id: 'mem-x', model_version: 'v1', score: 0.8 },
        ]);

      const result = await service.queryUnion(
        ['bge-base', 'minilm'],
        makeVec(4),
        5,
      );
      expect(result).toHaveLength(1);
      expect(result[0].memoryId).toBe('mem-x');
    });
  });
});
