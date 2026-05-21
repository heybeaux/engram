import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MemoryContradictionService } from './memory-contradiction.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';

const mockPrisma = {
  memory: {
    findUnique: jest.fn(),
  },
  $queryRawUnsafe: jest.fn(),
};

const mockEmbedding = {
  generate: jest.fn(),
  generateForRecall: jest.fn(),
};

const MOCK_EMBEDDING = Array.from({ length: 1536 }, (_, i) => i * 0.001);

describe('MemoryContradictionService', () => {
  let service: MemoryContradictionService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryContradictionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbeddingService, useValue: mockEmbedding },
      ],
    }).compile();

    service = module.get<MemoryContradictionService>(
      MemoryContradictionService,
    );
    mockEmbedding.generate.mockResolvedValue(MOCK_EMBEDDING);
    mockEmbedding.generateForRecall.mockResolvedValue(MOCK_EMBEDDING);
  });

  const mockContradictionRow = {
    id: 'mem-contra-1',
    raw: 'Coffee is harmful',
    memory_type: 'FACT',
    importance_score: 0.7,
    similarity: 0.92,
    created_at: new Date('2026-01-01'),
  };

  // ===================== Input validation =====================

  describe('input validation', () => {
    it('should throw BadRequestException if neither memoryId nor text is provided', async () => {
      await expect(
        service.findContradictions('user-1', {} as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException with correct message', async () => {
      await expect(
        service.findContradictions('user-1', {} as any),
      ).rejects.toThrow('Either memoryId or text must be provided');
    });

    it('should succeed with text only', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.findContradictions('user-1', {
        text: 'Coffee is good for you',
      });

      expect(result.contradictions).toEqual([]);
    });

    it('should succeed with memoryId only', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        id: 'mem-1',
        raw: 'Coffee is good for you',
        userId: 'user-1',
      });
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([]) // embedding lookup
        .mockResolvedValueOnce([]); // contradiction search

      const result = await service.findContradictions('user-1', {
        memoryId: 'mem-1',
      });

      expect(result.sourceId).toBe('mem-1');
      expect(result.sourceText).toBe('Coffee is good for you');
    });
  });

  // ===================== memoryId path =====================

  describe('findContradictions with memoryId', () => {
    const dto = { memoryId: 'mem-1' };
    const sourceMemory = {
      id: 'mem-1',
      raw: 'Coffee is good for health',
      userId: 'user-1',
    };

    beforeEach(() => {
      mockPrisma.memory.findUnique.mockResolvedValue(sourceMemory);
    });

    it('should throw NotFoundException if memory not found', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue(null);

      await expect(service.findContradictions('user-1', dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException with correct message', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue(null);

      await expect(
        service.findContradictions('user-1', { memoryId: 'nonexistent' }),
      ).rejects.toThrow('Memory nonexistent not found');
    });

    it('should use stored embedding when available', async () => {
      const storedEmbedding = MOCK_EMBEDDING.slice(0, 5).join(',') + ',...';
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([{ embedding: `[${MOCK_EMBEDDING.join(',')}]` }])
        .mockResolvedValueOnce([]);

      await service.findContradictions('user-1', dto);

      expect(mockEmbedding.generateForRecall).not.toHaveBeenCalled();
    });

    it('should generate embedding if stored embedding is missing', async () => {
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([]) // empty embedding lookup
        .mockResolvedValueOnce([]); // no contradictions

      await service.findContradictions('user-1', dto);

      expect(mockEmbedding.generateForRecall).toHaveBeenCalledWith(
        'Coffee is good for health',
      );
    });

    it('should exclude source memory from results', async () => {
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([mockContradictionRow]);

      const result = await service.findContradictions('user-1', dto);

      // Verify the second query contains the exclusion logic
      const secondCallQuery = mockPrisma.$queryRawUnsafe.mock.calls[1][0];
      expect(secondCallQuery).toContain('m.id !=');
    });

    it('should return source memory info', async () => {
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.findContradictions('user-1', dto);

      expect(result.sourceId).toBe('mem-1');
      expect(result.sourceText).toBe('Coffee is good for health');
    });
  });

  // ===================== text path =====================

  describe('findContradictions with text', () => {
    it('should generate embedding from provided text', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions('user-1', { text: 'Some assertion' });

      expect(mockEmbedding.generateForRecall).toHaveBeenCalledWith(
        'Some assertion',
      );
      expect(mockPrisma.memory.findUnique).not.toHaveBeenCalled();
    });

    it('should set sourceId to null for text-based search', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.findContradictions('user-1', {
        text: 'Coffee is bad',
      });

      expect(result.sourceId).toBeNull();
    });

    it('should set sourceText to the provided text', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.findContradictions('user-1', {
        text: 'Coffee is bad',
      });

      expect(result.sourceText).toBe('Coffee is bad');
    });
  });

  // ===================== result mapping =====================

  describe('result mapping', () => {
    beforeEach(() => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([mockContradictionRow]);
    });

    it('should map raw rows to ContradictionResult objects', async () => {
      const result = await service.findContradictions('user-1', {
        text: 'Coffee is good',
      });

      expect(result.contradictions).toHaveLength(1);
      expect(result.contradictions[0]).toEqual({
        id: 'mem-contra-1',
        raw: 'Coffee is harmful',
        memoryType: 'FACT',
        importanceScore: 0.7,
        similarity: 0.92,
        createdAt: mockContradictionRow.created_at,
      });
    });

    it('should convert similarity to Number', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        {
          ...mockContradictionRow,
          similarity: '0.95',
          importance_score: '0.8',
        },
      ]);

      const result = await service.findContradictions('user-1', {
        text: 'Test',
      });

      expect(typeof result.contradictions[0].similarity).toBe('number');
      expect(typeof result.contradictions[0].importanceScore).toBe('number');
    });

    it('should include total count', async () => {
      const result = await service.findContradictions('user-1', {
        text: 'Test',
      });

      expect(result.total).toBe(1);
    });

    it('should include latencyMs', async () => {
      const result = await service.findContradictions('user-1', {
        text: 'Test',
      });

      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ===================== filtering options =====================

  describe('filtering options', () => {
    it('should apply default threshold of 0.8 and limit of 10', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions('user-1', { text: 'Test' });

      const queryArgs = mockPrisma.$queryRawUnsafe.mock.calls[0];
      const params = queryArgs.slice(1);
      expect(params).toContain(0.8); // threshold
      expect(params).toContain(10); // limit
    });

    it('should apply custom threshold and limit', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions('user-1', {
        text: 'Test',
        threshold: 0.95,
        limit: 5,
      });

      const queryArgs = mockPrisma.$queryRawUnsafe.mock.calls[0];
      const params = queryArgs.slice(1);
      expect(params).toContain(0.95);
      expect(params).toContain(5);
    });

    it('should include agentId filter when provided', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions('user-1', {
        text: 'Test',
        agentId: 'agent-1',
      });

      const query = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(query).toContain('m.agent_id');
    });

    it('should work with null userId (no user filter)', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.findContradictions(null, { text: 'Test' });

      expect(result.total).toBe(0);
      const query = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(query).not.toContain('m.user_id');
    });

    it('should handle array userId with ANY clause', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions(['user-1', 'user-2'], { text: 'Test' });

      const query = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(query).toContain('ANY');
    });

    it('should use scalar userId comparison for single user', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions('user-1', { text: 'Test' });

      const query = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(query).toContain('m.user_id');
    });
  });

  // ===================== error propagation =====================

  describe('error propagation', () => {
    it('should propagate embedding errors', async () => {
      mockEmbedding.generateForRecall.mockRejectedValue(
        new Error('Embedding service timeout'),
      );

      await expect(
        service.findContradictions('user-1', { text: 'Test' }),
      ).rejects.toThrow('Embedding service timeout');
    });

    it('should propagate database query errors', async () => {
      mockPrisma.$queryRawUnsafe.mockRejectedValue(
        new Error('Connection refused'),
      );

      await expect(
        service.findContradictions('user-1', { text: 'Test' }),
      ).rejects.toThrow('Connection refused');
    });

    it('should propagate findUnique errors', async () => {
      mockPrisma.memory.findUnique.mockRejectedValue(new Error('DB timeout'));

      await expect(
        service.findContradictions('user-1', { memoryId: 'mem-1' }),
      ).rejects.toThrow('DB timeout');
    });
  });
});
