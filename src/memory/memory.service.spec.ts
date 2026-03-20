import { Test, TestingModule } from '@nestjs/testing';
import { MemoryService, MemoryWithExtraction } from './memory.service';
import { MemoryQueryService } from './memory-query.service';
import { MemoryGraphService } from './memory-graph.service';
import { MemoryExportService } from './memory-export.service';
import { MemoryWriteService } from './memory-write.service';
import { MemoryLifecycleService } from './memory-lifecycle.service';
import { ImportanceHint, MemoryLayer, MemorySource } from '@prisma/client';

describe('MemoryService', () => {
  let service: MemoryService;
  let module: TestingModule;

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

  let mockWriteService: any;
  let mockLifecycleService: any;
  let mockQueryService: any;
  let mockGraphService: any;
  let mockExportService: any;

  beforeEach(async () => {
    mockWriteService = {
      remember: jest.fn().mockResolvedValue(mockMemory),
      rememberAll: jest.fn().mockResolvedValue({ created: 0, failed: 0 }),
      bulkCreate: jest
        .fn()
        .mockResolvedValue({ created: 0, memoryIds: [] }),
      bulkTextImport: jest
        .fn()
        .mockResolvedValue({ created: 0, chunks: 0, memoryIds: [] }),
    };

    mockLifecycleService = {
      getById: jest.fn().mockResolvedValue(null),
      markUsed: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(mockMemory),
      correctMemory: jest.fn().mockResolvedValue(mockMemory),
      exportMemoriesFiltered: jest.fn().mockResolvedValue([]),
    };

    mockQueryService = {
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

    mockGraphService = {
      getGraphData: jest
        .fn()
        .mockResolvedValue({ nodes: [], edges: [], entities: [] }),
    };

    mockExportService = {
      exportMemories: jest.fn().mockResolvedValue([]),
      exportMemoriesBatch: jest.fn().mockResolvedValue([]),
      importMemories: jest
        .fn()
        .mockResolvedValue({ imported: 0, skipped: 0, errors: 0 }),
    };

    module = await Test.createTestingModule({
      providers: [
        MemoryService,
        { provide: MemoryQueryService, useValue: mockQueryService },
        { provide: MemoryGraphService, useValue: mockGraphService },
        { provide: MemoryExportService, useValue: mockExportService },
        { provide: MemoryWriteService, useValue: mockWriteService },
        { provide: MemoryLifecycleService, useValue: mockLifecycleService },
      ],
    }).compile();

    service = module.get<MemoryService>(MemoryService);
  });

  describe('remember', () => {
    it('should delegate to MemoryWriteService', async () => {
      mockWriteService.remember.mockResolvedValue(mockMemory);

      const result = await service.remember('user-456', {
        raw: 'Test memory content',
        layer: MemoryLayer.SESSION,
        importanceHint: ImportanceHint.MEDIUM,
      });

      expect(mockWriteService.remember).toHaveBeenCalledWith('user-456', {
        raw: 'Test memory content',
        layer: MemoryLayer.SESSION,
        importanceHint: ImportanceHint.MEDIUM,
      });
      expect(result).toEqual(mockMemory);
    });

    it('should default to SESSION layer when not specified', async () => {
      mockWriteService.remember.mockResolvedValue(mockMemory);

      await service.remember('user-456', { raw: 'Test' });

      expect(mockWriteService.remember).toHaveBeenCalledWith('user-456', {
        raw: 'Test',
      });
    });

    it('should include project and session context when provided', async () => {
      mockWriteService.remember.mockResolvedValue(mockMemory);

      await service.remember('user-456', {
        raw: 'Test',
        context: {
          projectId: 'project-123',
          sessionId: 'session-456',
        },
      });

      expect(mockWriteService.remember).toHaveBeenCalledWith('user-456', {
        raw: 'Test',
        context: {
          projectId: 'project-123',
          sessionId: 'session-456',
        },
      });
    });

    it('should pass through to write service (HEY-462: async dedup)', async () => {
      mockWriteService.remember.mockResolvedValue(mockMemory);

      const result = await service.remember('user-456', { raw: 'Test' });

      expect(result).toEqual(mockMemory);
      expect(mockWriteService.remember).toHaveBeenCalledTimes(1);
    });

    it('should always create a new memory record regardless of duplicates', async () => {
      mockWriteService.remember.mockResolvedValue(mockMemory);

      await service.remember('user-456', { raw: 'Regular memory' });

      expect(mockWriteService.remember).toHaveBeenCalledTimes(1);
    });
  });

  describe('rememberAll', () => {
    it('should delegate to MemoryWriteService', async () => {
      mockWriteService.rememberAll.mockResolvedValue({
        created: 3,
        failed: 0,
      });

      const result = await service.rememberAll('user-456', {
        memories: [
          { raw: 'Memory 1' },
          { raw: 'Memory 2' },
          { raw: 'Memory 3' },
        ],
      });

      expect(mockWriteService.rememberAll).toHaveBeenCalledWith('user-456', {
        memories: [
          { raw: 'Memory 1' },
          { raw: 'Memory 2' },
          { raw: 'Memory 3' },
        ],
      });
      expect(result).toEqual({ created: 3, failed: 0 });
    });

    it('should count failures without stopping batch', async () => {
      mockWriteService.rememberAll.mockResolvedValue({
        created: 2,
        failed: 1,
      });

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
      mockWriteService.rememberAll.mockResolvedValue({
        created: 1,
        failed: 0,
      });

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

      expect(mockWriteService.rememberAll).toHaveBeenCalledWith('user-456', {
        memories: [
          {
            raw: 'Memory 1',
            layer: MemoryLayer.IDENTITY,
            importanceHint: ImportanceHint.CRITICAL,
          },
        ],
        context: { projectId: 'project-123' },
      });
    });
  });

  describe('recall', () => {
    it('should delegate to MemoryQueryService', async () => {
      const mockResult = {
        memories: [{ ...mockMemory, id: 'mem-1', score: 0.95 }],
        queryTokens: 2,
        latencyMs: 10,
      };
      mockQueryService.recall.mockResolvedValue(mockResult);

      const result = await service.recall('user-456', {
        query: 'test query',
        limit: 10,
      });

      expect(mockQueryService.recall).toHaveBeenCalledWith('user-456', {
        query: 'test query',
        limit: 10,
      });
      expect(result).toEqual(mockResult);
    });

    it('should pass through layers filter', async () => {
      await service.recall('user-456', {
        query: 'test',
        layers: [MemoryLayer.IDENTITY, MemoryLayer.PROJECT],
      });

      expect(mockQueryService.recall).toHaveBeenCalledWith('user-456', {
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
      const mockResult = {
        context: '## User Identity\n- Identity fact',
        tokenCount: 5,
        memoriesIncluded: 3,
        layers: { identity: 1, project: 1, session: 1 },
      };
      mockQueryService.loadContext.mockResolvedValue(mockResult);

      const result = await service.loadContext('user-456', {
        projectId: 'project-123',
      });

      expect(mockQueryService.loadContext).toHaveBeenCalledWith('user-456', {
        projectId: 'project-123',
      });
      expect(result.layers.identity).toBe(1);
      expect(result.layers.project).toBe(1);
      expect(result.layers.session).toBe(1);
      expect(result.memoriesIncluded).toBe(3);
    });

    it('should pass through maxTokens', async () => {
      await service.loadContext('user-456', { maxTokens: 100 });

      expect(mockQueryService.loadContext).toHaveBeenCalledWith('user-456', {
        maxTokens: 100,
      });
    });
  });

  describe('markUsed', () => {
    it('should delegate to MemoryLifecycleService', async () => {
      await service.markUsed('mem-123');

      expect(mockLifecycleService.markUsed).toHaveBeenCalledWith(
        'mem-123',
        undefined,
      );
    });
  });

  describe('getById', () => {
    it('should delegate to MemoryLifecycleService', async () => {
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
      mockLifecycleService.getById.mockResolvedValue(memoryWithExtraction);

      const result = await service.getById('mem-123');

      expect(mockLifecycleService.getById).toHaveBeenCalledWith(
        'mem-123',
        undefined,
        undefined,
        undefined,
      );
      expect(result).toEqual(memoryWithExtraction);
    });

    it('should return null for non-existent memory', async () => {
      mockLifecycleService.getById.mockResolvedValue(null);

      const result = await service.getById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delegate to MemoryLifecycleService', async () => {
      await service.delete('mem-123');

      expect(mockLifecycleService.delete).toHaveBeenCalledWith(
        'mem-123',
        undefined,
        undefined,
      );
    });
  });
});
