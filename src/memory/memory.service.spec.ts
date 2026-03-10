import { Test, TestingModule } from '@nestjs/testing';
import { MemoryService, MemoryWithExtraction } from './memory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractionService } from './extraction.service';
import { EmbeddingService } from './embedding.service';
import { ImportanceService } from './importance.service';
import { TemporalParserService } from './temporal/temporal-parser.service';
import { HierarchyService } from '../hierarchy/hierarchy.service';
import { MemoryDedupService } from './memory-dedup.service';
import { EmbeddingQueueProducer } from './embedding-queue.producer';
import { MemoryQueryService } from './memory-query.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import { MemoryGraphService } from './memory-graph.service';
import { MemoryExportService } from './memory-export.service';
import { ImportanceHint, MemoryLayer, MemorySource } from '@prisma/client';

describe('MemoryService', () => {
  let service: MemoryService;
  let module: TestingModule;
  let mockPrisma: any;
  let mockExtraction: any;
  let mockEmbedding: any;
  let mockImportance: any;
  let mockTemporalParser: any;
  let mockHierarchyService: jest.Mocked<HierarchyService>;

  const mockMemory = {
    id: 'mem-123',
    userId: 'user-456',
    raw: 'Test memory content',
    layer: MemoryLayer.SESSION,
    source: MemorySource.EXPLICIT_STATEMENT,
    importanceHint: ImportanceHint.MEDIUM,
    importanceScore: 0.5,
    confidence: 1.0,
    retrievalCount: 0,
    usedCount: 0,
    consolidated: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    embeddingId: null,
    embeddingModel: null,
    lastRetrievedAt: null,
    lastUsedAt: null,
    consolidatedAt: null,
    supersededById: null,
    projectId: null,
    sessionId: null,
    sessionPosition: null,
  };

  beforeEach(async () => {
    mockPrisma = {
      memory: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      memoryExtraction: {
        create: jest.fn(),
      },
      session: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'user-456', externalId: 'TestUser' }),
      },
      entity: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      memoryEntity: {
        upsert: jest.fn(),
      },
      memoryChainLink: {
        upsert: jest.fn(),
      },
    };

    mockExtraction = {
      extract: jest.fn().mockResolvedValue({
        who: null,
        what: 'Test',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
        memoryType: null,
        typeConfidence: null,
        confidence: {
          whoConfidence: null,
          whatConfidence: null,
          whenConfidence: null,
          whereConfidence: null,
          whyConfidence: null,
          howConfidence: null,
        },
        lesson: null,
      }),
      getPriorityForType: jest.fn().mockReturnValue(3),
      classifyLayer: jest.fn().mockReturnValue('SESSION'),
    } as any;

    mockEmbedding = {
      generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      store: jest.fn().mockResolvedValue('embed-123'),
      search: jest.fn().mockResolvedValue([]), // Default: no duplicates found
      delete: jest.fn(),
      deleteAllForUser: jest.fn(),
      getDimensions: jest.fn(),
      getProviderName: jest.fn(),
    } as any;

    mockImportance = {
      calculate: jest.fn(),
      recalculate: jest.fn(),
      applyDecay: jest.fn(),
    } as any;

    mockTemporalParser = {
      parse: jest.fn().mockReturnValue({
        temporalFilter: null,
        semanticQuery: 'test query',
      }),
      blendScores: jest
        .fn()
        .mockImplementation(
          (semantic, temporal, importance) => semantic + importance,
        ),
      computeTemporalScore: jest.fn().mockReturnValue(0.5),
    } as any;

    mockHierarchyService = {
      isEnabled: jest.fn().mockReturnValue(false),
      processMemory: jest.fn().mockResolvedValue({
        memoryId: 'mem-123',
        unitsCreated: 0,
        levels: [],
        units: [],
      }),
    } as any;

    const mockDedupService = {
      findDuplicate: jest.fn().mockResolvedValue(null),
      findDuplicateV2: jest.fn().mockResolvedValue({ action: 'create' }),
      autoMergeMemory: jest.fn().mockResolvedValue(undefined),
      reinforceMemory: jest.fn().mockResolvedValue(undefined),
    };

    const mockQueryService = {
      recall: jest
        .fn()
        .mockResolvedValue({ memories: [], queryTokens: 0, latencyMs: 0 }),
      loadContext: jest.fn().mockResolvedValue({
        context: '',
        tokenCount: 0,
        memoriesIncluded: 0,
        layers: { identity: 0, project: 0, session: 0 },
      }),
      shouldUseMultiQuery: jest.fn().mockReturnValue(false),
      selectMemoriesForBudget: jest
        .fn()
        .mockReturnValue({ selected: [], evicted: [] }),
      buildSubjectTypeFilter: jest.fn().mockReturnValue({}),
      formatContext: jest.fn().mockReturnValue({ text: '', tokens: 0 }),
    };

    const mockPipelineService = {
      extractAndEmbed: jest.fn().mockResolvedValue(undefined),
      storeEntities: jest.fn().mockResolvedValue(undefined),
      linkRelatedMemories: jest.fn().mockResolvedValue(undefined),
      promoteToConstraint: jest.fn().mockResolvedValue(undefined),
    };

    const mockGraphService = {
      getGraphData: jest
        .fn()
        .mockResolvedValue({ nodes: [], edges: [], entities: [] }),
    };

    const mockEmbeddingQueue = {
      enqueueEmbedding: jest.fn().mockResolvedValue(undefined),
    };

    module = await Test.createTestingModule({
      providers: [
        MemoryService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ExtractionService, useValue: mockExtraction },
        { provide: EmbeddingService, useValue: mockEmbedding },
        { provide: ImportanceService, useValue: mockImportance },
        { provide: TemporalParserService, useValue: mockTemporalParser },
        { provide: HierarchyService, useValue: mockHierarchyService },
        { provide: MemoryDedupService, useValue: mockDedupService },
        { provide: MemoryQueryService, useValue: mockQueryService },
        { provide: MemoryPipelineService, useValue: mockPipelineService },
        { provide: MemoryGraphService, useValue: mockGraphService },
        { provide: EmbeddingQueueProducer, useValue: mockEmbeddingQueue },
        {
          provide: MemoryExportService,
          useValue: {
            exportMemories: jest.fn().mockResolvedValue([]),
            exportMemoriesBatch: jest.fn().mockResolvedValue([]),
            importMemories: jest
              .fn()
              .mockResolvedValue({ imported: 0, skipped: 0, errors: 0 }),
          },
        },
      ],
    }).compile();

    service = module.get<MemoryService>(MemoryService);
  });

  describe('remember', () => {
    it('should create a memory with calculated importance', async () => {
      mockImportance.calculate.mockReturnValue(0.6);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);
      mockExtraction.extract.mockResolvedValue({
        who: null,
        what: 'Test',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
        memoryType: null,
        typeConfidence: null,
        confidence: {
          whoConfidence: null,
          whatConfidence: null,
          whenConfidence: null,
          whereConfidence: null,
          whyConfidence: null,
          howConfidence: null,
        },
        lesson: null,
      });
      mockEmbedding.generate.mockResolvedValue([0.1, 0.2, 0.3]);
      mockEmbedding.store.mockResolvedValue('embed-123');

      const result = await service.remember('user-456', {
        raw: 'Test memory content',
        layer: MemoryLayer.SESSION,
        importanceHint: ImportanceHint.MEDIUM,
      });

      expect(mockImportance.calculate).toHaveBeenCalledWith({
        hint: ImportanceHint.MEDIUM,
        layer: MemoryLayer.SESSION,
      });
      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-456',
          raw: 'Test memory content',
          layer: MemoryLayer.SESSION,
          source: MemorySource.EXPLICIT_STATEMENT,
          importanceHint: ImportanceHint.MEDIUM,
          importanceScore: 0.6,
        }),
      });
      expect(result).toEqual(mockMemory);
    });

    it('should default to SESSION layer when not specified', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      await service.remember('user-456', { raw: 'Test' });

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          layer: MemoryLayer.SESSION,
        }),
      });
    });

    it('should include project and session context when provided', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);
      // Mock session resolution - sessionId exists in DB
      mockPrisma.session.findUnique.mockResolvedValue({ id: 'session-456' });

      await service.remember('user-456', {
        raw: 'Test',
        context: {
          projectId: 'project-123',
          sessionId: 'session-456',
        },
      });

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          projectId: 'project-123',
          sessionId: 'session-456',
        }),
      });
    });

    it('should enqueue embedding via EmbeddingQueueProducer (HEY-462: async dedup)', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      const result = await service.remember('user-456', { raw: 'Test' });

      // Result should be returned immediately without waiting for dedup
      expect(result).toEqual(mockMemory);

      // Embedding should be enqueued (dedup runs in the worker, not here)
      const embeddingQueue = module.get(EmbeddingQueueProducer);
      expect(embeddingQueue.enqueueEmbedding).toHaveBeenCalledWith({
        memoryId: mockMemory.id,
        userId: 'user-456',
        raw: 'Test',
        runDedup: true,
      });
    });

    it('should NOT call findDuplicateV2 synchronously (dedup moved to worker)', async () => {
      mockImportance.calculate.mockReturnValue(0.7);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      const dedupService = module.get(MemoryDedupService);

      await service.remember('user-456', {
        raw: 'Pattern detected: topic drift in sessions',
        layer: MemoryLayer.INSIGHT,
        source: MemorySource.PATTERN_DETECTED,
      });

      // Dedup must NOT run synchronously on the HTTP path (HEY-462)
      expect(dedupService.findDuplicateV2).not.toHaveBeenCalled();
    });

    it('should always create a new memory record regardless of duplicates', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      await service.remember('user-456', { raw: 'Regular memory' });

      // Memory is always created — dedup happens async in the worker
      expect(mockPrisma.memory.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('rememberAll', () => {
    it('should create multiple memories in batch', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      const result = await service.rememberAll('user-456', {
        memories: [
          { raw: 'Memory 1' },
          { raw: 'Memory 2' },
          { raw: 'Memory 3' },
        ],
      });

      expect(mockPrisma.memory.create).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ created: 3, failed: 0 });
    });

    it('should count failures without stopping batch', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create
        .mockResolvedValueOnce(mockMemory)
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce(mockMemory);

      const result = await service.rememberAll('user-456', {
        memories: [
          { raw: 'Memory 1' },
          { raw: 'Memory 2' },
          { raw: 'Memory 3' },
        ],
      });

      expect(result).toEqual({ created: 2, failed: 1 });
    });

    it('should respect individual memory settings', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      await service.rememberAll('user-456', {
        memories: [
          {
            raw: 'Memory 1',
            layer: MemoryLayer.IDENTITY,
            importanceHint: ImportanceHint.CRITICAL,
          },
        ],
        context: { projectId: 'project-123' },
      });

      expect(mockImportance.calculate).toHaveBeenCalledWith({
        hint: ImportanceHint.CRITICAL,
        layer: MemoryLayer.IDENTITY,
      });
    });
  });

  describe('recall', () => {
    it('should delegate to MemoryQueryService', async () => {
      const queryService = module.get(MemoryQueryService);
      const mockResult = {
        memories: [{ ...mockMemory, id: 'mem-1', score: 0.95 }],
        queryTokens: 2,
        latencyMs: 10,
      };
      (queryService.recall as jest.Mock).mockResolvedValue(mockResult);

      const result = await service.recall('user-456', {
        query: 'test query',
        limit: 10,
      });

      expect(queryService.recall).toHaveBeenCalledWith('user-456', {
        query: 'test query',
        limit: 10,
      });
      expect(result).toEqual(mockResult);
    });

    it('should pass through layers filter', async () => {
      const queryService = module.get(MemoryQueryService);

      await service.recall('user-456', {
        query: 'test',
        layers: [MemoryLayer.IDENTITY, MemoryLayer.PROJECT],
      });

      expect(queryService.recall).toHaveBeenCalledWith('user-456', {
        query: 'test',
        layers: [MemoryLayer.IDENTITY, MemoryLayer.PROJECT],
      });
    });

    it('should handle empty search results', async () => {
      const result = await service.recall('user-456', { query: 'test' });
      expect(result.memories).toEqual([]);
    });
  });

  describe('loadContext', () => {
    it('should delegate to MemoryQueryService', async () => {
      const queryService = module.get(MemoryQueryService);
      const mockResult = {
        context: '## User Identity\n- Identity fact',
        tokenCount: 5,
        memoriesIncluded: 3,
        layers: { identity: 1, project: 1, session: 1 },
      };
      (queryService.loadContext as jest.Mock).mockResolvedValue(mockResult);

      const result = await service.loadContext('user-456', {
        projectId: 'project-123',
      });

      expect(queryService.loadContext).toHaveBeenCalledWith('user-456', {
        projectId: 'project-123',
      });
      expect(result.layers.identity).toBe(1);
      expect(result.layers.project).toBe(1);
      expect(result.layers.session).toBe(1);
      expect(result.memoriesIncluded).toBe(3);
    });

    it('should pass through maxTokens', async () => {
      const queryService = module.get(MemoryQueryService);

      await service.loadContext('user-456', { maxTokens: 100 });

      expect(queryService.loadContext).toHaveBeenCalledWith('user-456', {
        maxTokens: 100,
      });
    });
  });

  describe('markUsed', () => {
    it('should increment usedCount and update lastUsedAt', async () => {
      mockPrisma.memory.update.mockResolvedValue(mockMemory);

      await service.markUsed('mem-123');

      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        data: {
          usedCount: { increment: 1 },
          lastUsedAt: expect.any(Date),
        },
      });
    });
  });

  describe('getById', () => {
    it('should return memory with extraction', async () => {
      const memoryWithExtraction = {
        ...mockMemory,
        extraction: {
          who: 'John',
          what: 'Test',
          when: null,
          whereCtx: null,
          why: null,
          how: null,
          topics: ['test'],
        },
      };
      mockPrisma.memory.findUnique.mockResolvedValue(memoryWithExtraction);

      const result = await service.getById('mem-123');

      expect(mockPrisma.memory.findUnique).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        include: { extraction: true },
      });
      expect(result).toEqual(memoryWithExtraction);
    });

    it('should return null for non-existent memory', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue(null);

      const result = await service.getById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should soft delete by setting deletedAt', async () => {
      mockPrisma.memory.update.mockResolvedValue(mockMemory);

      await service.delete('mem-123');

      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });
});
