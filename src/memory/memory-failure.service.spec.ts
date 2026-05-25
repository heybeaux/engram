import { Test, TestingModule } from '@nestjs/testing';
import { MemoryFailureService } from './memory-failure.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';

const mockPrisma = {
  $queryRawUnsafe: jest.fn(),
  memoryChainLink: {
    findMany: jest.fn(),
  },
};

const mockEmbedding = {
  generate: jest.fn(),
  generateForRecall: jest.fn(),
};

const MOCK_EMBEDDING = Array.from({ length: 1536 }, (_, i) => i * 0.001);

describe('MemoryFailureService', () => {
  let service: MemoryFailureService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryFailureService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbeddingService, useValue: mockEmbedding },
      ],
    }).compile();

    service = module.get<MemoryFailureService>(MemoryFailureService);
    mockEmbedding.generate.mockResolvedValue(MOCK_EMBEDDING);
    mockEmbedding.generateForRecall.mockResolvedValue(MOCK_EMBEDDING);
  });

  // ===================== findFailures =====================

  describe('findFailures', () => {
    const baseDto = { goal: 'deploy the API' };
    const mockRow = {
      id: 'mem-1',
      raw: 'The deployment failed due to a crash',
      layer: 'SESSION',
      created_at: new Date('2026-01-01'),
      metadata: { outcome: 'failure' },
      tags: ['deploy'],
      similarity: 0.85,
    };

    it('should return failures with userId and agentId filters', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([mockRow]);

      const result = await service.findFailures('user-1', {
        ...baseDto,
        agentId: 'agent-1',
      });

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toEqual({
        id: 'mem-1',
        raw: 'The deployment failed due to a crash',
        layer: 'SESSION',
        similarity: 0.85,
        createdAt: mockRow.created_at,
        metadata: { outcome: 'failure' },
        tags: ['deploy'],
      });
      expect(result.goal).toBe('deploy the API');
      expect(result.total).toBe(1);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should work with userId only (no agentId)', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([mockRow]);

      const result = await service.findFailures('user-1', baseDto);

      expect(result.failures).toHaveLength(1);
      expect(mockEmbedding.generateForRecall).toHaveBeenCalledWith(
        'deploy the API',
      );
    });

    it('should work with no userId (account-wide search)', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([mockRow]);

      const result = await service.findFailures(null, baseDto);

      expect(result.failures).toHaveLength(1);
    });

    it('should handle array userId', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.findFailures(['user-1', 'user-2'], baseDto);

      expect(result.failures).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should apply default limit of 10 and minSimilarity of 0.7', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findFailures('user-1', { goal: 'something' });

      // Default limit 10 and minSimilarity 0.7 should be in query params
      const callArgs = mockPrisma.$queryRawUnsafe.mock.calls[0];
      const params = callArgs.slice(1);
      expect(params).toContain(10); // limit
      expect(params).toContain(0.7); // minSimilarity
    });

    it('should respect custom limit and minSimilarity', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findFailures('user-1', {
        goal: 'test',
        limit: 5,
        minSimilarity: 0.9,
      });

      const callArgs = mockPrisma.$queryRawUnsafe.mock.calls[0];
      const params = callArgs.slice(1);
      expect(params).toContain(5);
      expect(params).toContain(0.9);
    });

    it('should include extra keywords in filter patterns', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.findFailures('user-1', {
        goal: 'test',
        extraKeywords: ['timeout', 'disconnect'],
      });

      // The query string (first arg) should have been called
      const queryArg = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
      expect(queryArg).toContain('ILIKE ANY');
    });

    it('should convert similarity to Number from raw query result', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { ...mockRow, similarity: '0.92' }, // Postgres returns numeric as string
      ]);

      const result = await service.findFailures('user-1', baseDto);

      expect(typeof result.failures[0].similarity).toBe('number');
      expect(result.failures[0].similarity).toBeCloseTo(0.92);
    });

    it('should return empty failures when no rows match', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.findFailures('user-1', {
        goal: 'no failures here',
      });

      expect(result.failures).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should propagate embedding errors', async () => {
      mockEmbedding.generateForRecall.mockRejectedValue(
        new Error('Embedding service unavailable'),
      );

      await expect(service.findFailures('user-1', baseDto)).rejects.toThrow(
        'Embedding service unavailable',
      );
    });

    it('should propagate database errors', async () => {
      mockPrisma.$queryRawUnsafe.mockRejectedValue(
        new Error('DB connection error'),
      );

      await expect(service.findFailures('user-1', baseDto)).rejects.toThrow(
        'DB connection error',
      );
    });

    it('should reject invalid query embeddings before raw SQL', async () => {
      mockEmbedding.generateForRecall.mockResolvedValue([
        0.1,
        Number.NaN,
        0.3,
      ]);

      await expect(service.findFailures('user-1', baseDto)).rejects.toThrow(
        'Invalid embedding for MemoryFailureService.findFailures',
      );
      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('should include latencyMs in result', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.findFailures('user-1', baseDto);

      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ===================== attachChains =====================

  describe('attachChains', () => {
    const baseMemory = (id: string) => ({
      id,
      raw: `memory ${id}`,
      layer: 'SESSION',
      source: 'AGENT_OBSERVATION' as any,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      userId: 'user-1',
      agentId: 'agent-1',
      importanceScore: 0.5,
      memoryType: null,
      metadata: {},
      tags: [],
      searchable: true,
      supersededById: null,
    });

    it('should return memories unchanged if no chain links found', async () => {
      mockPrisma.memoryChainLink.findMany.mockResolvedValue([]);

      const memories = [baseMemory('mem-1'), baseMemory('mem-2')];
      const result = (await service.attachChains(memories as any)) as any[];

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(memories[0]);
      expect(result[1]).toEqual(memories[1]);
    });

    it('should return empty array immediately if given empty memories', async () => {
      const result = await service.attachChains([]);

      expect(result).toEqual([]);
      expect(mockPrisma.memoryChainLink.findMany).not.toHaveBeenCalled();
    });

    it('should attach chain links where memory is the source', async () => {
      const linkedMemory = { id: 'mem-linked', raw: 'linked' };
      mockPrisma.memoryChainLink.findMany.mockResolvedValue([
        {
          id: 'link-1',
          sourceId: 'mem-1',
          targetId: 'mem-linked',
          linkType: 'caused_by',
          confidence: 0.9,
          source: { id: 'mem-1' },
          target: linkedMemory,
        },
      ]);

      const memories = [baseMemory('mem-1')];
      const result = (await service.attachChains(memories as any)) as any[];

      expect(result[0].chainedMemories).toHaveLength(1);
      expect(result[0].chainedMemories[0]).toEqual({
        memory: linkedMemory,
        linkType: 'caused_by',
        confidence: 0.9,
      });
    });

    it('should attach chain links where memory is the target', async () => {
      const sourceMemory = { id: 'mem-source', raw: 'source' };
      mockPrisma.memoryChainLink.findMany.mockResolvedValue([
        {
          id: 'link-2',
          sourceId: 'mem-source',
          targetId: 'mem-1',
          linkType: 'led_to',
          confidence: 0.75,
          source: sourceMemory,
          target: { id: 'mem-1' },
        },
      ]);

      const memories = [baseMemory('mem-1')];
      const result = (await service.attachChains(memories as any)) as any[];

      expect(result[0].chainedMemories).toHaveLength(1);
      expect(result[0].chainedMemories[0]).toEqual({
        memory: sourceMemory,
        linkType: 'led_to',
        confidence: 0.75,
      });
    });

    it('should attach empty chainedMemories for memories with no links', async () => {
      mockPrisma.memoryChainLink.findMany.mockResolvedValue([
        {
          id: 'link-1',
          sourceId: 'mem-1',
          targetId: 'mem-other',
          linkType: 'caused_by',
          confidence: 0.8,
          source: { id: 'mem-1' },
          target: { id: 'mem-other' },
        },
      ]);

      const memories = [baseMemory('mem-1'), baseMemory('mem-2')];
      const result = (await service.attachChains(memories as any)) as any[];

      expect(result[0].chainedMemories).toHaveLength(1);
      expect(result[1].chainedMemories).toEqual([]);
    });

    it('should query with the correct memory IDs', async () => {
      mockPrisma.memoryChainLink.findMany.mockResolvedValue([]);

      const memories = [
        baseMemory('mem-a'),
        baseMemory('mem-b'),
        baseMemory('mem-c'),
      ];
      (await service.attachChains(memories as any)) as any[];

      expect(mockPrisma.memoryChainLink.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { sourceId: { in: ['mem-a', 'mem-b', 'mem-c'] } },
            { targetId: { in: ['mem-a', 'mem-b', 'mem-c'] } },
          ],
        },
        include: { source: true, target: true },
      });
    });

    it('should handle maxDepth parameter (passed through)', async () => {
      mockPrisma.memoryChainLink.findMany.mockResolvedValue([]);

      const memories = [baseMemory('mem-1')];
      const result = (await service.attachChains(memories as any, 5)) as any[];

      expect(result).toHaveLength(1);
    });
  });
});
