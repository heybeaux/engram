import { Test, TestingModule } from '@nestjs/testing';
import { EmbeddingWriteService } from './embedding-write.service';
import { PrismaService } from '../prisma/prisma.service';

const make = (dims: number, fill = 0.1) =>
  Array.from({ length: dims }, (_, i) => fill + i * 0.0001);

describe('EmbeddingWriteService', () => {
  let service: EmbeddingWriteService;
  let prisma: jest.Mocked<
    Pick<PrismaService, '$executeRawUnsafe' | '$queryRawUnsafe'>
  >;

  beforeEach(async () => {
    prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ exists: 1 }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbeddingWriteService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(EmbeddingWriteService);
  });

  afterEach(() => {
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EXPECTED_EMBED_DIMENSIONS;
  });

  // ── validateDimensions ────────────────────────────────────────────────

  describe('validateDimensions', () => {
    it('throws on dimension mismatch for known model', () => {
      expect(() => service.validateDimensions('bge-base', make(1536))).toThrow(
        /expected 768 dims but got 1536/,
      );
    });

    it('passes for correct dimensions', () => {
      expect(() => service.validateDimensions('bge-base', make(768))).not.toThrow();
      expect(() => service.validateDimensions('openai-small', make(1536))).not.toThrow();
      expect(() => service.validateDimensions('openai-large', make(3072))).not.toThrow();
    });

    it('passes for unknown model (no guard applied)', () => {
      expect(() =>
        service.validateDimensions('my-custom-model', make(512)),
      ).not.toThrow();
    });
  });

  // ── writeMemoryEmbedding ──────────────────────────────────────────────

  describe('writeMemoryEmbedding', () => {
    it('throws before any DB write when dimensions mismatch for known model', async () => {
      await expect(
        service.writeMemoryEmbedding('mem-1', 'bge-base', make(1536)),
      ).rejects.toThrow(/expected 768 dims but got 1536/);

      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('writes legacy inline column AND memory_embeddings for 768-dim bge-base', async () => {
      const vector = make(768);
      await service.writeMemoryEmbedding('mem-2', 'bge-base', vector);

      // existence check
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('SELECT 1 AS exists FROM memories'),
        'mem-2',
      );

      const calls = (prisma.$executeRawUnsafe as jest.Mock).mock.calls;
      // first write: legacy inline
      expect(calls[0][0]).toContain('UPDATE memories SET embedding');
      expect(calls[0][2]).toBe('mem-2');
      // second write: memory_embeddings upsert
      expect(calls[1][0]).toContain('INSERT INTO memory_embeddings');
      expect(calls[1][2]).toBe('mem-2');
      expect(calls[1][3]).toBe('bge-base');
      expect(calls[1][4]).toBe(768);
    });

    it('skips legacy inline write for 1536-dim openai-small but writes memory_embeddings', async () => {
      const vector = make(1536);
      await service.writeMemoryEmbedding('mem-3', 'openai-small', vector);

      const calls = (prisma.$executeRawUnsafe as jest.Mock).mock.calls;
      // Only one SQL call: memory_embeddings upsert (no legacy inline for 1536 dims)
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toContain('INSERT INTO memory_embeddings');
      expect(calls[0][3]).toBe('openai-small');
      expect(calls[0][4]).toBe(1536);
    });

    it('no-ops when memory does not exist (existence check returns empty)', async () => {
      (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([]);
      const vector = make(768);

      await service.writeMemoryEmbedding('missing-mem', 'bge-base', vector);

      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('skipLegacyInline=true skips existence check and legacy column write', async () => {
      const vector = make(768);
      await service.writeMemoryEmbedding('mem-4', 'bge-base', vector, true);

      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      const calls = (prisma.$executeRawUnsafe as jest.Mock).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toContain('INSERT INTO memory_embeddings');
    });
  });

  // ── writeLegacyInlineEmbedding ────────────────────────────────────────

  describe('writeLegacyInlineEmbedding', () => {
    it('writes memories.embedding for 768-dim vector', async () => {
      const vector = make(768);
      await service.writeLegacyInlineEmbedding('mem-5', vector);

      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE memories SET embedding'),
        expect.stringMatching(/^\[[\d.,e+-]+\]$/),
        'mem-5',
      );
    });

    it('skips write (no DB call) for 1536-dim vector — prevents Postgres 22000', async () => {
      const vector = make(1536);
      await service.writeLegacyInlineEmbedding('mem-6', vector);

      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('skips write for 3072-dim openai-large', async () => {
      const vector = make(3072);
      await service.writeLegacyInlineEmbedding('mem-7', vector);

      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  // ── serialization guards ──────────────────────────────────────────────
  // Use an unknown model so dimension guard doesn't fire before serialization.

  describe('vector serialization', () => {
    it('rejects empty array', async () => {
      await expect(
        service.writeMemoryEmbedding('mem-8', 'unknown-model', []),
      ).rejects.toThrow(/Empty or invalid vector/);
    });

    it('rejects sparse array with holes', async () => {
      // eslint-disable-next-line no-sparse-arrays
      const sparse = [0.1, , 0.3] as unknown as number[];
      await expect(
        service.writeMemoryEmbedding('mem-9', 'unknown-model', sparse),
      ).rejects.toThrow(/Sparse array/);
    });

    it('rejects array containing NaN', async () => {
      const withNaN = make(768);
      withNaN[5] = NaN;
      // unknown-model: no dimension guard, so serialization check fires
      await expect(
        service.writeMemoryEmbedding('mem-10', 'unknown-model', withNaN),
      ).rejects.toThrow(/Non-finite value/);
    });
  });
});
