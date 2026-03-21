import { MemoryQueryController } from './memory-query.controller';
import { MemoryService } from './memory.service';
import { ContextualRecallService } from './contextual-recall.service';

describe('MemoryQueryController', () => {
  let controller: MemoryQueryController;
  let memoryService: jest.Mocked<MemoryService>;
  let contextualRecallService: jest.Mocked<ContextualRecallService>;

  const userId = 'user-123';

  beforeEach(() => {
    memoryService = {
      recall: jest.fn(),
      getGraphData: jest.fn(),
      loadContext: jest.fn(),
    } as any;

    contextualRecallService = {
      recall: jest.fn(),
    } as any;

    const prismaService = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;

    const retrievalSignals = {
      logQuery: jest.fn().mockResolvedValue('query-id'),
    } as any;

    controller = new MemoryQueryController(
      memoryService,
      contextualRecallService,
      prismaService,
      retrievalSignals,
    );
  });

  describe('recall', () => {
    it('should search memories', async () => {
      const dto = { query: 'test' } as any;
      const expected = { memories: [], total: 0 };
      memoryService.recall.mockResolvedValue(expected as any);

      const req = { isInstanceKey: false };
      const res = { set: jest.fn() } as any;
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

  describe('loadContext', () => {
    it('should load context', async () => {
      const dto = { sessionHint: 'test' } as any;
      const expected = { memories: [], summary: '' };
      memoryService.loadContext.mockResolvedValue(expected as any);

      const result = await controller.loadContext(userId, dto);

      expect(result).toEqual(expected);
    });
  });
});
