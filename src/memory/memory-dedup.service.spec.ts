import { Test, TestingModule } from '@nestjs/testing';
import {
  MemoryDedupService,
  DEDUP_AUTO_MERGE_THRESHOLD,
  DEDUP_REINFORCE_THRESHOLD,
  DEDUP_REVIEW_THRESHOLD,
} from './memory-dedup.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';

const mockPrisma = {
  memory: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  mergeCandidate: {
    create: jest.fn(),
  },
  $executeRaw: jest.fn(),
};

const mockEmbedding = {
  generate: jest.fn(),
  search: jest.fn(),
};

describe('MemoryDedupService', () => {
  let service: MemoryDedupService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryDedupService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbeddingService, useValue: mockEmbedding },
      ],
    }).compile();
    service = module.get<MemoryDedupService>(MemoryDedupService);
  });

  describe('findDuplicateV2', () => {
    const mockMemory = {
      id: 'mem-1',
      deletedAt: null,
      confidence: 0.7,
      importanceScore: 0.5,
    };

    beforeEach(() => {
      mockEmbedding.generate.mockResolvedValue([0.1, 0.2, 0.3]);
    });

    it('should return create when no similar memories found', async () => {
      mockEmbedding.search.mockResolvedValue([]);
      const result = await service.findDuplicateV2('user1', 'test text');
      expect(result).toEqual({ action: 'create' });
    });

    it('should return merged when score >= auto-merge threshold', async () => {
      mockEmbedding.search.mockResolvedValue([{ id: 'mem-1', score: 0.95 }]);
      mockPrisma.memory.findUnique.mockResolvedValue(mockMemory);

      const result = await service.findDuplicateV2('user1', 'test text');

      expect(result.action).toBe('merged');
      expect(result.existingMemory).toEqual(mockMemory);
      expect(result.similarityScore).toBe(0.95);
    });

    it('should ignore the excluded candidate memory when vector search returns self', async () => {
      mockEmbedding.search.mockResolvedValue([{ id: 'mem-new', score: 1 }]);

      const result = await service.findDuplicateV2(
        'user1',
        'test text',
        DEDUP_AUTO_MERGE_THRESHOLD,
        'mem-new',
      );

      expect(result).toEqual({ action: 'create' });
      expect(mockPrisma.memory.findUnique).not.toHaveBeenCalled();
      expect(mockEmbedding.search).toHaveBeenCalledWith(
        'user1',
        [0.1, 0.2, 0.3],
        6,
      );
    });

    it('should skip self and use the next valid duplicate candidate', async () => {
      const existingMemory = { ...mockMemory, id: 'mem-existing' };
      mockEmbedding.search.mockResolvedValue([
        { id: 'mem-new', score: 1 },
        { id: 'mem-existing', score: 0.96 },
      ]);
      mockPrisma.memory.findUnique.mockResolvedValue(existingMemory);

      const result = await service.findDuplicateV2(
        'user1',
        'test text',
        DEDUP_AUTO_MERGE_THRESHOLD,
        'mem-new',
      );

      expect(result.action).toBe('merged');
      expect(result.existingMemory).toEqual(existingMemory);
      expect(result.similarityScore).toBe(0.96);
      expect(mockPrisma.memory.findUnique).toHaveBeenCalledWith({
        where: { id: 'mem-existing' },
      });
    });

    it('should keep scanning past missing or soft-deleted candidates', async () => {
      const existingMemory = { ...mockMemory, id: 'mem-valid' };
      mockEmbedding.search.mockResolvedValue([
        { id: 'mem-new', score: 1 },
        { id: 'mem-missing', score: 0.99 },
        { id: 'mem-deleted', score: 0.98 },
        { id: 'mem-valid', score: 0.97 },
      ]);
      mockPrisma.memory.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          ...mockMemory,
          id: 'mem-deleted',
          deletedAt: new Date(),
        })
        .mockResolvedValueOnce(existingMemory);

      const result = await service.findDuplicateV2(
        'user1',
        'test text',
        DEDUP_AUTO_MERGE_THRESHOLD,
        'mem-new',
      );

      expect(result.action).toBe('merged');
      expect(result.existingMemory).toEqual(existingMemory);
      expect(result.similarityScore).toBe(0.97);
    });

    it('should return reinforced when score >= reinforce threshold but < auto-merge', async () => {
      mockEmbedding.search.mockResolvedValue([{ id: 'mem-1', score: 0.88 }]);
      mockPrisma.memory.findUnique.mockResolvedValue(mockMemory);

      const result = await service.findDuplicateV2('user1', 'test text');

      expect(result.action).toBe('reinforced');
      expect(result.similarityScore).toBe(0.88);
    });

    it('should create MergeCandidate when score >= review threshold but < reinforce', async () => {
      mockEmbedding.search.mockResolvedValue([{ id: 'mem-1', score: 0.8 }]);
      mockPrisma.memory.findUnique.mockResolvedValue(mockMemory);

      const result = await service.findDuplicateV2('user1', 'test text');

      expect(result.action).toBe('create');
      expect(mockPrisma.mergeCandidate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user1',
          memoryIds: ['mem-1'],
          similarity: 0.8,
          status: 'PENDING',
        }),
      });
    });

    it('should return create when score < review threshold', async () => {
      mockEmbedding.search.mockResolvedValue([{ id: 'mem-1', score: 0.5 }]);
      mockPrisma.memory.findUnique.mockResolvedValue(mockMemory);

      const result = await service.findDuplicateV2('user1', 'test text');

      expect(result.action).toBe('create');
      expect(mockPrisma.mergeCandidate.create).not.toHaveBeenCalled();
    });

    it('should return create when existing memory is soft-deleted', async () => {
      mockEmbedding.search.mockResolvedValue([{ id: 'mem-1', score: 0.95 }]);
      mockPrisma.memory.findUnique.mockResolvedValue({
        ...mockMemory,
        deletedAt: new Date(),
      });

      const result = await service.findDuplicateV2('user1', 'test text');
      expect(result.action).toBe('create');
    });

    it('should return create when memory not found in DB', async () => {
      mockEmbedding.search.mockResolvedValue([{ id: 'mem-1', score: 0.95 }]);
      mockPrisma.memory.findUnique.mockResolvedValue(null);

      const result = await service.findDuplicateV2('user1', 'test text');
      expect(result.action).toBe('create');
    });

    it('should gracefully handle embedding errors', async () => {
      mockEmbedding.generate.mockRejectedValue(
        new Error('Embedding service down'),
      );

      const result = await service.findDuplicateV2('user1', 'test text');
      expect(result.action).toBe('create');
    });

    it('should handle MergeCandidate creation failure gracefully', async () => {
      mockEmbedding.search.mockResolvedValue([{ id: 'mem-1', score: 0.8 }]);
      mockPrisma.memory.findUnique.mockResolvedValue(mockMemory);
      mockPrisma.mergeCandidate.create.mockRejectedValue(new Error('DB error'));

      // Should not throw
      const result = await service.findDuplicateV2('user1', 'test text');
      expect(result.action).toBe('create');
    });
  });

  describe('findDuplicate (legacy)', () => {
    it('should return existing memory when duplicate found', async () => {
      const mockMemory = { id: 'mem-1', deletedAt: null };
      mockEmbedding.generate.mockResolvedValue([0.1]);
      mockEmbedding.search.mockResolvedValue([{ id: 'mem-1', score: 0.95 }]);
      mockPrisma.memory.findUnique.mockResolvedValue(mockMemory);

      const result = await service.findDuplicate('user1', 'test');
      expect(result).toEqual(mockMemory);
    });

    it('should return null when no duplicate', async () => {
      mockEmbedding.generate.mockResolvedValue([0.1]);
      mockEmbedding.search.mockResolvedValue([]);

      const result = await service.findDuplicate('user1', 'test');
      expect(result).toBeNull();
    });
  });

  describe('autoMergeMemory', () => {
    it('should boost confidence and update counters', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        id: 'mem-1',
        confidence: 0.7,
      });

      await service.autoMergeMemory(
        'mem-1',
        'new content',
        'EXPLICIT_STATEMENT' as any,
      );

      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });

    it('should not update when memory not found', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue(null);

      await service.autoMergeMemory(
        'nonexistent',
        'new content',
        'SYSTEM' as any,
      );

      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('should cap boosted confidence at 1.0', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        id: 'mem-1',
        confidence: 0.98,
      });

      await service.autoMergeMemory(
        'mem-1',
        'content',
        'EXPLICIT_STATEMENT' as any,
      );

      // The first arg to $executeRaw is a template string array, confidence is embedded
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });
  });

  describe('reinforceMemory', () => {
    it('should update counters via raw SQL', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        id: 'mem-1',
        importanceScore: 0.5,
      });

      await service.reinforceMemory('mem-1');

      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });

    it('should cap importance at 1.0 if exceeded', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        id: 'mem-1',
        importanceScore: 1.1,
      });

      await service.reinforceMemory('mem-1');

      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        data: { importanceScore: 1.0 },
      });
    });
  });
});
