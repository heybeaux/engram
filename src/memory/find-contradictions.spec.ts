import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MemoryQueryService } from './memory-query.service';

describe('MemoryQueryService.findContradictions', () => {
  let service: MemoryQueryService;
  let mockPrisma: any;
  let mockEmbedding: any;

  const userId = 'user-123';
  const fakeEmbedding = [0.1, 0.2, 0.3];

  beforeEach(() => {
    jest.clearAllMocks();

    mockPrisma = {
      memory: {
        findUnique: jest.fn(),
      },
      $queryRawUnsafe: jest.fn(),
    };

    mockEmbedding = {
      generateForRecall: jest.fn().mockResolvedValue(fakeEmbedding),
    };

    // Instantiate with minimal deps — only prisma + embedding are needed
    service = new MemoryQueryService(
      mockPrisma,
      mockEmbedding,
      null as any, // temporalParser
      null as any, // recallWeightService
      null as any, // rankingService
      null as any, // contextService
    );
  });

  describe('input validation', () => {
    it('should throw BadRequestException when neither memoryId nor text provided', async () => {
      await expect(
        service.findContradictions(userId, {}),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('by memoryId', () => {
    it('should find contradictions for an existing memory', async () => {
      const sourceMemory = {
        id: 'mem-1',
        raw: 'The sky is blue',
        userId,
      };
      mockPrisma.memory.findUnique.mockResolvedValue(sourceMemory);
      mockPrisma.$queryRawUnsafe
        // First call: get embedding
        .mockResolvedValueOnce([{ embedding: '[0.1,0.2,0.3]' }])
        // Second call: vector search
        .mockResolvedValueOnce([
          {
            id: 'mem-2',
            raw: 'The sky is green',
            memory_type: 'FACT',
            importance_score: 0.7,
            similarity: 0.85,
            created_at: new Date('2026-01-01'),
          },
        ]);

      const result = await service.findContradictions(userId, {
        memoryId: 'mem-1',
      });

      expect(result.sourceId).toBe('mem-1');
      expect(result.sourceText).toBe('The sky is blue');
      expect(result.contradictions).toHaveLength(1);
      expect(result.contradictions[0]).toEqual(
        expect.objectContaining({
          id: 'mem-2',
          raw: 'The sky is green',
          memoryType: 'FACT',
          similarity: 0.85,
        }),
      );
      expect(result.total).toBe(1);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should throw NotFoundException when memoryId not found', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue(null);

      await expect(
        service.findContradictions(userId, { memoryId: 'nonexistent' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should generate embedding when memory has no stored embedding', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        id: 'mem-1',
        raw: 'test',
        userId,
      });
      // No embedding in DB
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.findContradictions(userId, { memoryId: 'mem-1' });

      expect(mockEmbedding.generateForRecall).toHaveBeenCalledWith('test');
    });
  });

  describe('by text', () => {
    it('should find contradictions for text input', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        {
          id: 'mem-3',
          raw: 'Coffee is bad for health',
          memory_type: 'PREFERENCE',
          importance_score: 0.6,
          similarity: 0.82,
          created_at: new Date('2026-02-01'),
        },
      ]);

      const result = await service.findContradictions(userId, {
        text: 'Coffee is great for health',
      });

      expect(result.sourceId).toBeNull();
      expect(result.sourceText).toBe('Coffee is great for health');
      expect(result.contradictions).toHaveLength(1);
      expect(result.contradictions[0].id).toBe('mem-3');
      expect(mockEmbedding.generateForRecall).toHaveBeenCalledWith(
        'Coffee is great for health',
      );
    });
  });

  describe('empty results', () => {
    it('should return empty array when no contradictions found', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.findContradictions(userId, {
        text: 'Something unique',
      });

      expect(result.contradictions).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('agentId isolation', () => {
    it('should include agentId filter in query when provided', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions(userId, {
        text: 'test',
        agentId: 'agent-42',
      });

      const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).toContain('m.agent_id');
      // agentId should be passed as a parameter
      const params = mockPrisma.$queryRawUnsafe.mock.calls[0];
      expect(params).toContain('agent-42');
    });

    it('should not include agentId filter when not provided', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions(userId, { text: 'test' });

      const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).not.toContain('m.agent_id');
    });
  });

  describe('userId filtering', () => {
    it('should filter by single userId', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions('user-1', { text: 'test' });

      const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).toContain('m.user_id');
    });

    it('should filter by array of userIds', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions(['user-1', 'user-2'], {
        text: 'test',
      });

      const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).toContain('m.user_id = ANY');
    });

    it('should omit userId filter when null', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions(null, { text: 'test' });

      const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).not.toContain('m.user_id');
    });
  });

  describe('threshold and limit', () => {
    it('should use default threshold of 0.8', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions(userId, { text: 'test' });

      const params = mockPrisma.$queryRawUnsafe.mock.calls[0];
      expect(params).toContain(0.8);
    });

    it('should use custom threshold', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions(userId, {
        text: 'test',
        threshold: 0.9,
      });

      const params = mockPrisma.$queryRawUnsafe.mock.calls[0];
      expect(params).toContain(0.9);
    });

    it('should use custom limit', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions(userId, {
        text: 'test',
        limit: 5,
      });

      const params = mockPrisma.$queryRawUnsafe.mock.calls[0];
      expect(params).toContain(5);
    });
  });

  describe('SQL correctness', () => {
    it('should query only contradictable memory types', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions(userId, { text: 'test' });

      const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).toContain('FACT');
      expect(sql).toContain('PREFERENCE');
      expect(sql).toContain('CONSTRAINT');
      expect(sql).toContain('LESSON');
    });

    it('should filter deleted and non-searchable memories', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions(userId, { text: 'test' });

      const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).toContain('m.deleted_at IS NULL');
      expect(sql).toContain('m.searchable = true');
    });

    it('should use cosine distance operator', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findContradictions(userId, { text: 'test' });

      const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(sql).toContain('<=>');
    });

    it('should exclude source memory when memoryId provided', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        id: 'mem-1',
        raw: 'test',
        userId,
      });
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([{ embedding: '[0.1,0.2]' }])
        .mockResolvedValueOnce([]);

      await service.findContradictions(userId, { memoryId: 'mem-1' });

      const searchSql = mockPrisma.$queryRawUnsafe.mock.calls[1][0];
      expect(searchSql).toContain('m.id !=');
      const searchParams = mockPrisma.$queryRawUnsafe.mock.calls[1];
      expect(searchParams).toContain('mem-1');
    });
  });
});
