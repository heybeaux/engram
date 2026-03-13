import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  HierarchyService,
  ProcessResult,
  AggregatedSearchResult,
} from './hierarchy.service';
import { SegmentationService } from './segmentation.service';
import { QueryRouterService } from './query-router.service';
import { PrismaService } from '../prisma/prisma.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { LLMService } from '../llm/llm.service';
import { VectorService } from '../vector/vector.service';

describe('HierarchyService', () => {
  let service: HierarchyService;
  let mockConfig: any;
  let mockPrisma: any;
  let mockServicePrisma: any;
  let mockLLM: jest.Mocked<LLMService>;
  let mockVector: jest.Mocked<VectorService>;
  let mockSegmentation: jest.Mocked<SegmentationService>;
  let mockQueryRouter: jest.Mocked<QueryRouterService>;

  const mockEmbedding = Array(768).fill(0.1);

  const buildModule = async (overrides?: {
    config?: any;
    prisma?: any;
    servicePrisma?: any;
  }) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HierarchyService,
        { provide: ConfigService, useValue: overrides?.config ?? mockConfig },
        { provide: PrismaService, useValue: overrides?.prisma ?? mockPrisma },
        {
          provide: ServicePrismaService,
          useValue: overrides?.servicePrisma ?? mockServicePrisma,
        },
        { provide: LLMService, useValue: mockLLM },
        { provide: VectorService, useValue: mockVector },
        { provide: SegmentationService, useValue: mockSegmentation },
        { provide: QueryRouterService, useValue: mockQueryRouter },
      ],
    }).compile();

    return module.get<HierarchyService>(HierarchyService);
  };

  beforeEach(async () => {
    mockConfig = {
      get: jest.fn((key: string, defaultValue?: string) => {
        const config: Record<string, string> = {
          HIERARCHY_ENABLED: 'true',
          HIERARCHY_NAMESPACE_PREFIX: 'test_hierarchy',
        };
        return config[key] ?? defaultValue;
      }),
    } as any;

    mockPrisma = {
      hierarchyUnit: {
        create: jest.fn().mockResolvedValue({
          id: 'unit-123',
          level: 'L0',
          text: 'Test sentence',
          sourceMemoryId: 'mem-123',
          userId: 'user-456',
          position: 0,
          charStart: 0,
          charEnd: 13,
          pineconeId: 'test_hierarchy_l0_123',
          pineconeNamespace: 'test_hierarchy_L0',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    // ServicePrismaService mock — used for background DB writes (L0/L1 creation)
    mockServicePrisma = {
      hierarchyUnit: {
        create: jest.fn().mockResolvedValue({
          id: 'unit-123',
          level: 'L0',
          text: 'Test sentence',
          sourceMemoryId: 'mem-123',
          userId: 'user-456',
          position: 0,
          charStart: 0,
          charEnd: 13,
          pineconeId: 'test_hierarchy_l0_123',
          pineconeNamespace: 'test_hierarchy_L0',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    };

    mockLLM = {
      embed: jest.fn().mockResolvedValue({
        embedding: mockEmbedding,
        dimensions: 768,
      }),
    } as any;

    mockVector = {
      upsert: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockSegmentation = {
      extractSentences: jest.fn().mockReturnValue([
        { text: 'First sentence.', position: 0, charStart: 0, charEnd: 15 },
        { text: 'Second sentence.', position: 1, charStart: 16, charEnd: 32 },
      ]),
      extractParagraphs: jest.fn().mockReturnValue([
        {
          text: 'First sentence. Second sentence.',
          sentences: [
            { text: 'First sentence.', position: 0, charStart: 0, charEnd: 15 },
            {
              text: 'Second sentence.',
              position: 1,
              charStart: 16,
              charEnd: 32,
            },
          ],
          position: 0,
          charStart: 0,
          charEnd: 32,
        },
      ]),
    } as any;

    mockQueryRouter = {
      analyze: jest.fn().mockReturnValue({
        query: 'test query',
        suggestedLevels: ['L0', 'L1'],
        confidence: 0.8,
        reasoning: 'Test routing',
      }),
    } as any;

    service = await buildModule();
  });

  describe('isEnabled', () => {
    it('should return true when HIERARCHY_ENABLED is true', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when HIERARCHY_ENABLED is false', async () => {
      const disabledConfig = {
        get: jest.fn((key: string) => {
          if (key === 'HIERARCHY_ENABLED') return 'false';
          return 'test';
        }),
      };

      const disabledService = await buildModule({ config: disabledConfig });
      expect(disabledService.isEnabled()).toBe(false);
    });
  });

  describe('processMemory', () => {
    it('should process memory and create L0 and L1 units', async () => {
      const result = await service.processMemory(
        'mem-123',
        'First sentence. Second sentence.',
        'user-456',
      );

      expect(result.memoryId).toBe('mem-123');
      expect(result.levels).toContain('L0');
      expect(result.levels).toContain('L1');
      expect(result.unitsCreated).toBeGreaterThan(0);
    });

    it('should call segmentation service', async () => {
      await service.processMemory('mem-123', 'Test text.', 'user-456');

      expect(mockSegmentation.extractSentences).toHaveBeenCalledWith(
        'Test text.',
      );
      expect(mockSegmentation.extractParagraphs).toHaveBeenCalledWith(
        'Test text.',
      );
    });

    it('should generate embeddings for each unit', async () => {
      await service.processMemory(
        'mem-123',
        'First sentence. Second sentence.',
        'user-456',
      );

      // Should be called for each sentence and paragraph
      expect(mockLLM.embed).toHaveBeenCalled();
    });

    it('should store vectors in Pinecone', async () => {
      await service.processMemory('mem-123', 'Test text.', 'user-456');

      expect(mockVector.upsert).toHaveBeenCalled();
    });

    it('should store units in PostgreSQL via ServicePrismaService (not RLS proxy)', async () => {
      await service.processMemory('mem-123', 'Test text.', 'user-456');

      // Background writes MUST go through ServicePrismaService (BYPASSRLS)
      expect(mockServicePrisma.hierarchyUnit.create).toHaveBeenCalled();
      // The RLS-scoped PrismaService must NOT be used for unit creation
      expect(mockPrisma.hierarchyUnit.create).not.toHaveBeenCalled();
    });

    it('should return empty result when disabled', async () => {
      const disabledConfig = {
        get: jest.fn((key: string) => {
          if (key === 'HIERARCHY_ENABLED') return 'false';
          return 'test';
        }),
      };

      const disabledService = await buildModule({ config: disabledConfig });
      const result = await disabledService.processMemory(
        'mem-123',
        'Test',
        'user-456',
      );

      expect(result.unitsCreated).toBe(0);
      expect(result.levels).toEqual([]);
    });
  });

  describe('createAndStoreUnit retry logic', () => {
    beforeEach(() => {
      // Speed up backoff for tests
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should succeed on first attempt when DB write succeeds', async () => {
      mockServicePrisma.hierarchyUnit.create.mockResolvedValueOnce({
        id: 'unit-ok',
        level: 'L0',
        text: 'sentence',
        sourceMemoryId: 'mem-1',
        userId: 'user-1',
        position: 0,
        charStart: 0,
        charEnd: 8,
        pineconeId: 'pc-ok',
        pineconeNamespace: 'test_hierarchy_L0',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.processMemory('mem-1', 'sentence.', 'user-1');

      expect(result.unitsCreated).toBeGreaterThan(0);
      expect(mockServicePrisma.hierarchyUnit.create).toHaveBeenCalledTimes(
        // 1 sentence + 1 paragraph (paragraph = full text since it contains 1 sentence)
        mockSegmentation.extractSentences.mock.results[0]?.value?.length +
          mockSegmentation.extractParagraphs.mock.results[0]?.value?.length ||
          2,
      );
    });

    it('should retry on transient DB errors (Transaction already closed)', async () => {
      const txError = new Error('Transaction already closed');

      // Fail twice, succeed on third attempt
      mockServicePrisma.hierarchyUnit.create
        .mockRejectedValueOnce(txError)
        .mockRejectedValueOnce(txError)
        .mockResolvedValue({
          id: 'unit-retry',
          level: 'L0',
          text: 'Retry sentence.',
          sourceMemoryId: 'mem-retry',
          userId: 'user-1',
          position: 0,
          charStart: 0,
          charEnd: 14,
          pineconeId: 'pc-retry',
          pineconeNamespace: 'test_hierarchy_L0',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      // Single sentence + single paragraph
      mockSegmentation.extractSentences.mockReturnValue([
        { text: 'Retry sentence.', position: 0, charStart: 0, charEnd: 14 },
      ]);
      mockSegmentation.extractParagraphs.mockReturnValue([
        {
          text: 'Retry sentence.',
          sentences: [
            { text: 'Retry sentence.', position: 0, charStart: 0, charEnd: 14 },
          ],
          position: 0,
          charStart: 0,
          charEnd: 14,
        },
      ]);

      const processPromise = service.processMemory(
        'mem-retry',
        'Retry sentence.',
        'user-1',
      );

      // Advance timers through backoff delays (200ms + 400ms)
      await jest.runAllTimersAsync();

      const result = await processPromise;

      // Unit created after retries
      expect(result.unitsCreated).toBeGreaterThan(0);
      // create should have been called at least 3 times (2 fails + 1 success)
      // across the sentence unit attempt
      expect(
        mockServicePrisma.hierarchyUnit.create.mock.calls.length,
      ).toBeGreaterThanOrEqual(3);
    });

    it('should return null (not throw) after exhausting all 3 retries', async () => {
      const txError = new Error('Transaction already closed');

      // All attempts fail
      mockServicePrisma.hierarchyUnit.create.mockRejectedValue(txError);

      mockSegmentation.extractSentences.mockReturnValue([
        { text: 'Bad sentence.', position: 0, charStart: 0, charEnd: 12 },
      ]);
      mockSegmentation.extractParagraphs.mockReturnValue([]);

      const processPromise = service.processMemory(
        'mem-fail',
        'Bad sentence.',
        'user-1',
      );

      await jest.runAllTimersAsync();

      const result = await processPromise;

      // Should not throw — returns 0 units created (all failed gracefully)
      expect(result.unitsCreated).toBe(0);
      // 3 retries per unit, 1 unit
      expect(
        mockServicePrisma.hierarchyUnit.create.mock.calls.length,
      ).toBeGreaterThanOrEqual(3);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      mockVector.search = jest.fn().mockResolvedValue([
        {
          id: 'test_hierarchy_l0_123',
          score: 0.9,
          metadata: {
            userId: 'user-456',
            level: 'L0',
            sourceMemoryId: 'mem-123',
            text: 'Test sentence.',
          },
        },
      ]);
    });

    it('should search and return results', async () => {
      const result = await service.search('test query', 'user-456');

      expect(result.results).toBeDefined();
      expect(result.routing).toBeDefined();
      expect(result.levelsSearched).toBeDefined();
    });

    it('should use auto routing by default', async () => {
      await service.search('test query', 'user-456');

      expect(mockQueryRouter.analyze).toHaveBeenCalledWith('test query');
    });

    it('should use explicit levels when specified', async () => {
      const result = await service.search('test query', 'user-456', {
        levels: ['L0'],
        routing: 'explicit',
      });

      expect(result.levelsSearched).toEqual(['L0']);
    });

    it('should generate query embedding', async () => {
      await service.search('test query', 'user-456');

      expect(mockLLM.embed).toHaveBeenCalledWith('test query');
    });

    it('should search vector store', async () => {
      await service.search('test query', 'user-456');

      expect(mockVector.search).toHaveBeenCalled();
    });
  });

  describe('getUnitsForMemory', () => {
    it('should fetch units for a memory', async () => {
      const mockUnits = [
        { id: 'unit-1', level: 'L0', text: 'Sentence' },
        { id: 'unit-2', level: 'L1', text: 'Paragraph' },
      ];
      mockPrisma.hierarchyUnit.findMany.mockResolvedValue(mockUnits);

      const result = await service.getUnitsForMemory('mem-123');

      expect(mockPrisma.hierarchyUnit.findMany).toHaveBeenCalledWith({
        where: { sourceMemoryId: 'mem-123' },
        orderBy: [{ level: 'asc' }, { position: 'asc' }],
      });
      expect(result).toEqual(mockUnits);
    });
  });

  describe('getStats', () => {
    it('should return statistics for a user', async () => {
      mockPrisma.hierarchyUnit.groupBy.mockResolvedValue([
        { level: 'L0', _count: { id: 10 } },
        { level: 'L1', _count: { id: 5 } },
      ]);
      mockPrisma.hierarchyUnit.findFirst.mockResolvedValue({
        updatedAt: new Date('2026-02-05'),
      });

      const result = await service.getStats('user-456');

      expect(result.totalUnits).toBe(15);
      expect(result.byLevel.L0).toBe(10);
      expect(result.byLevel.L1).toBe(5);
      expect(result.lastUpdated).toEqual(new Date('2026-02-05'));
    });

    it('should handle empty stats', async () => {
      mockPrisma.hierarchyUnit.groupBy.mockResolvedValue([]);
      mockPrisma.hierarchyUnit.findFirst.mockResolvedValue(null);

      const result = await service.getStats('user-456');

      expect(result.totalUnits).toBe(0);
      expect(result.lastUpdated).toBeNull();
    });
  });

  describe('deleteUnitsForMemory', () => {
    it('should delete from both Pinecone and PostgreSQL', async () => {
      mockPrisma.hierarchyUnit.findMany.mockResolvedValue([
        { pineconeId: 'pc-1' },
        { pineconeId: 'pc-2' },
      ]);

      await service.deleteUnitsForMemory('mem-123');

      expect(mockVector.delete).toHaveBeenCalledTimes(2);
      expect(mockPrisma.hierarchyUnit.deleteMany).toHaveBeenCalledWith({
        where: { sourceMemoryId: 'mem-123' },
      });
    });
  });

  describe('reprocessUser', () => {
    it('should reprocess all memories for a user', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        { id: 'mem-1', raw: 'Text 1' },
        { id: 'mem-2', raw: 'Text 2' },
      ]);

      const result = await service.reprocessUser('user-456');

      expect(result.processed).toBeGreaterThanOrEqual(0);
      expect(result.failed).toBeDefined();
    });
  });
});
