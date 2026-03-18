import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';
import { BackfillService } from './backfill.service';
import { ConsolidationService } from './consolidation.service';
import { ContextualRecallService } from './contextual-recall.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MemoryController', () => {
  let controller: MemoryController;
  let memoryService: jest.Mocked<MemoryService>;
  let backfillService: jest.Mocked<BackfillService>;
  let consolidationService: jest.Mocked<ConsolidationService>;
  let contextualRecallService: jest.Mocked<ContextualRecallService>;

  const userId = 'user-123';

  beforeEach(() => {
    memoryService = {
      remember: jest.fn(),
      rememberAll: jest.fn(),
      recall: jest.fn(),
      getGraphData: jest.fn(),
      getById: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      markUsed: jest.fn(),
      loadContext: jest.fn(),
      bulkCreate: jest.fn(),
      bulkTextImport: jest.fn(),
      exportMemoriesFiltered: jest.fn(),
    } as any;

    backfillService = {
      findMemoriesNeedingBackfill: jest.fn(),
      backfillExtractions: jest.fn(),
      backfillUserIdentity: jest.fn(),
      findUserByExternalIdPattern: jest.fn(),
    } as any;

    consolidationService = {
      promoteRecurringPatterns: jest.fn(),
      getStats: jest.fn(),
    } as any;

    contextualRecallService = {
      recall: jest.fn(),
    } as any;

    const prismaService = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;

    controller = new MemoryController(
      memoryService,
      backfillService,
      consolidationService,
      contextualRecallService,
      prismaService,
      {
        enqueue: jest.fn().mockReturnValue('job-123'),
        getStatus: jest.fn(),
      } as any,
      {
        createBatch: jest.fn().mockReturnValue('batch-123'),
        getBatchStatus: jest.fn(),
      } as any,
      {
        getEmbeddingStatus: jest.fn().mockResolvedValue({
          withEmbedding: 10,
          withoutEmbedding: 2,
          retryQueueSize: 1,
          exhaustedRetries: 0,
        }),
        retryFailedEmbeddings: jest.fn().mockResolvedValue({
          retried: 2,
          succeeded: 1,
          failed: 1,
          discovered: 0,
        }),
      } as any,
      { logQuery: jest.fn().mockResolvedValue('query-id') } as any, // retrievalSignals
    );
  });

  // === MEMORY CRUD ===

  describe('remember', () => {
    it('should create a memory', async () => {
      const dto = { raw: 'test memory' } as any;
      const expected = { id: '1', raw: 'test memory' };
      memoryService.remember.mockResolvedValue(expected as any);

      const result = await controller.remember(userId, dto);

      expect(result).toEqual(expected);
      expect(memoryService.remember).toHaveBeenCalledWith(userId, dto);
    });
  });

  describe('rememberAll', () => {
    it('should create memories in batch', async () => {
      const dto = { memories: [{ raw: 'a' }, { raw: 'b' }] } as any;
      memoryService.rememberAll.mockResolvedValue({ created: 2, failed: 0 });

      const result = await controller.rememberAll(userId, dto);

      expect(result).toEqual({ created: 2, failed: 0 });
    });
  });

  describe('recall', () => {
    it('should search memories', async () => {
      const dto = { query: 'test' } as any;
      const expected = { memories: [], total: 0 };
      memoryService.recall.mockResolvedValue(expected as any);

      const req = { isInstanceKey: false };
      const res = { setHeader: jest.fn() } as any;
      const result = await controller.recall(userId, dto, req, res);

      expect(result).toEqual(expected);
      expect(memoryService.recall).toHaveBeenCalledWith(userId, dto);
    });
  });

  describe('contextualRecall', () => {
    it('should delegate to contextualRecallService', async () => {
      const dto = { messages: [] } as any;
      const expected = { triggered: false, memories: [] };
      contextualRecallService.recall.mockResolvedValue(expected as any);

      const req = { isInstanceKey: false };
      const result = await controller.contextualRecall(userId, dto, req);

      expect(result).toEqual(expected);
    });
  });

  describe('getGraph', () => {
    it('should return graph data with defaults', async () => {
      const expected = { nodes: [], edges: [], entities: [] };
      memoryService.getGraphData.mockResolvedValue(expected as any);

      const mockReq = { user: { id: userId } } as any;
      const result = await controller.getGraph(userId, mockReq);

      expect(memoryService.getGraphData).toHaveBeenCalledWith(
        userId,
        500,
        false,
      );
      expect(result).toEqual(expected);
    });

    it('should parse limit and includeAgent params', async () => {
      memoryService.getGraphData.mockResolvedValue({
        nodes: [],
        edges: [],
        entities: [],
      } as any);

      const mockReq = { user: { id: userId } } as any;
      await controller.getGraph(userId, mockReq, '100', 'true');

      expect(memoryService.getGraphData).toHaveBeenCalledWith(
        userId,
        100,
        true,
      );
    });
  });

  describe('getMemory', () => {
    it('should get memory by id', async () => {
      const expected = { id: 'mem-1', raw: 'test' };
      memoryService.getById.mockResolvedValue(expected as any);

      const req = { accountId: 'acc-1', isInstanceKey: true };
      const result = await controller.getMemory(req, userId, 'mem-1');

      expect(result).toEqual(expected);
      expect(memoryService.getById).toHaveBeenCalledWith(
        'mem-1',
        userId,
        undefined,
        'acc-1',
      );
    });
  });

  describe('updateMemory', () => {
    it('should update a memory', async () => {
      const dto = { raw: 'updated' } as any;
      const expected = { id: 'mem-1', raw: 'updated' };
      memoryService.update.mockResolvedValue(expected as any);

      const result = await controller.updateMemory(userId, 'mem-1', dto);

      expect(result).toEqual(expected);
      expect(memoryService.update).toHaveBeenCalledWith(userId, 'mem-1', dto);
    });
  });

  describe('deleteMemory', () => {
    it('should soft delete a memory', async () => {
      memoryService.delete.mockResolvedValue(undefined);

      const req = { accountId: 'acc-1' };
      await controller.deleteMemory(userId, 'mem-1', req);

      expect(memoryService.delete).toHaveBeenCalledWith(
        'mem-1',
        userId,
        undefined,
      );
    });
  });

  // === FEEDBACK ===

  describe('markUsed', () => {
    it('should mark memory as used', async () => {
      memoryService.markUsed.mockResolvedValue(undefined);

      await controller.markUsed(userId, 'mem-1');

      expect(memoryService.markUsed).toHaveBeenCalledWith('mem-1', userId);
    });
  });

  // === CONTEXT ===

  describe('loadContext', () => {
    it('should load context', async () => {
      const dto = { sessionHint: 'test' } as any;
      const expected = { memories: [], summary: '' };
      memoryService.loadContext.mockResolvedValue(expected as any);

      const result = await controller.loadContext(userId, dto);

      expect(result).toEqual(expected);
    });
  });

  // === BACKFILL ===

  describe('getBackfillStatus', () => {
    it('should return count of memories needing backfill', async () => {
      backfillService.findMemoriesNeedingBackfill.mockResolvedValue([
        {},
        {},
        {},
      ] as any);

      const result = await controller.getBackfillStatus();

      expect(result).toEqual({ needsBackfill: 3 });
    });
  });

  describe('runBackfill', () => {
    it('should run backfill with defaults', async () => {
      const expected = { processed: 10, failed: 0 };
      backfillService.backfillExtractions.mockResolvedValue(expected as any);

      const result = await controller.runBackfill();

      expect(backfillService.backfillExtractions).toHaveBeenCalledWith({
        dryRun: false,
        batchSize: 50,
        delayMs: 500,
      });
    });

    it('should pass dryRun and batchSize params', async () => {
      backfillService.backfillExtractions.mockResolvedValue({} as any);

      await controller.runBackfill('true', '25');

      expect(backfillService.backfillExtractions).toHaveBeenCalledWith({
        dryRun: true,
        batchSize: 25,
        delayMs: 500,
      });
    });
  });

  describe('backfillUserIdentity', () => {
    it('should call backfill with body params', async () => {
      backfillService.backfillUserIdentity.mockResolvedValue({} as any);

      await controller.backfillUserIdentity({
        userId: 'u1',
        actualName: 'Alice',
        dryRun: true,
        batchSize: 500,
      });

      expect(backfillService.backfillUserIdentity).toHaveBeenCalledWith(
        'u1',
        'Alice',
        { dryRun: true, batchSize: 500 },
      );
    });
  });

  describe('lookupUserForBackfill', () => {
    it('should return empty array for empty pattern', async () => {
      const result = await controller.lookupUserForBackfill('');
      expect(result).toEqual([]);
    });

    it('should search by pattern', async () => {
      const expected = [{ id: 'u1', externalId: 'beaux' }];
      backfillService.findUserByExternalIdPattern.mockResolvedValue(expected);

      const result = await controller.lookupUserForBackfill('beaux');

      expect(result).toEqual(expected);
    });
  });

  // === CONSOLIDATION ===

  describe('consolidate', () => {
    it('should run consolidation with defaults', async () => {
      consolidationService.promoteRecurringPatterns.mockResolvedValue(
        {} as any,
      );

      await controller.consolidate(userId);

      expect(
        consolidationService.promoteRecurringPatterns,
      ).toHaveBeenCalledWith(userId, {
        dryRun: false,
        minOccurrences: undefined,
        similarityThreshold: undefined,
      });
    });

    it('should parse query params', async () => {
      consolidationService.promoteRecurringPatterns.mockResolvedValue(
        {} as any,
      );

      await controller.consolidate(userId, 'true', '5', '0.9');

      expect(
        consolidationService.promoteRecurringPatterns,
      ).toHaveBeenCalledWith(userId, {
        dryRun: true,
        minOccurrences: 5,
        similarityThreshold: 0.9,
      });
    });
  });

  describe('getConsolidationStats', () => {
    it('should return stats for user', async () => {
      const expected = {
        totalMemories: 100,
        sessionMemories: 60,
        identityMemories: 20,
        projectMemories: 15,
        consolidatedCount: 5,
        potentialClusters: 3,
      };
      consolidationService.getStats.mockResolvedValue(expected);

      const result = await controller.getConsolidationStats(userId);

      expect(result).toEqual(expected);
    });
  });
});
