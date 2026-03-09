import { HierarchyController } from './hierarchy.controller';
import { HierarchyService } from './hierarchy.service';
import { QueryRouterService } from './query-router.service';

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockHierarchyService = {
  search: jest.fn(),
  getStats: jest.fn(),
  getUnitsForMemory: jest.fn(),
  reprocessUser: jest.fn(),
  isEnabled: jest.fn(),
};

const mockQueryRouter = {
  analyze: jest.fn(),
};

// ── Helpers ────────────────────────────────────────────────────────────────
function makeController(): HierarchyController {
  return new HierarchyController(
    mockHierarchyService as unknown as HierarchyService,
    mockQueryRouter as unknown as QueryRouterService,
  );
}

describe('HierarchyController', () => {
  let controller: HierarchyController;
  const USER_ID = 'user-abc-123';

  beforeEach(() => {
    jest.clearAllMocks();
    controller = makeController();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /v1/hierarchy/search
  // ──────────────────────────────────────────────────────────────────────────
  describe('search', () => {
    const searchResult = {
      results: [{ id: 'mem-1', text: 'hello', score: 0.9 }],
      totalFound: 1,
      levels: ['L0'],
    };

    it('returns search results for a valid query', async () => {
      mockHierarchyService.search.mockResolvedValue(searchResult);

      const result = await controller.search(USER_ID, {
        query: 'What is the user name?',
      });

      expect(result).toEqual(searchResult);
      expect(mockHierarchyService.search).toHaveBeenCalledWith(
        'What is the user name?',
        USER_ID,
        { levels: undefined, routing: undefined, topK: undefined },
      );
    });

    it('passes explicit levels and topK to service', async () => {
      mockHierarchyService.search.mockResolvedValue(searchResult);

      await controller.search(USER_ID, {
        query: 'test',
        levels: ['L0', 'L1'],
        routing: 'explicit',
        topK: 10,
      });

      expect(mockHierarchyService.search).toHaveBeenCalledWith('test', USER_ID, {
        levels: ['L0', 'L1'],
        routing: 'explicit',
        topK: 10,
      });
    });

    it('propagates service errors', async () => {
      mockHierarchyService.search.mockRejectedValue(new Error('DB error'));
      await expect(controller.search(USER_ID, { query: 'fail' })).rejects.toThrow('DB error');
    });

    it('handles empty results', async () => {
      const emptyResult = { results: [], totalFound: 0, levels: [] };
      mockHierarchyService.search.mockResolvedValue(emptyResult);
      const result = await controller.search(USER_ID, { query: 'nothing' });
      expect(result.results).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /v1/hierarchy/analyze
  // ──────────────────────────────────────────────────────────────────────────
  describe('analyzeQuery', () => {
    const analysis = {
      recommendedLevel: 'L0',
      reasoning: 'short query',
      confidence: 0.9,
    };

    it('returns query analysis from router', async () => {
      mockQueryRouter.analyze.mockResolvedValue(analysis);

      const result = await controller.analyzeQuery({ query: 'What happened today?' });

      expect(result).toEqual(analysis);
      expect(mockQueryRouter.analyze).toHaveBeenCalledWith('What happened today?');
    });

    it('handles empty query string', async () => {
      mockQueryRouter.analyze.mockResolvedValue({ recommendedLevel: 'L0', confidence: 0 });
      const result = await controller.analyzeQuery({ query: '' });
      expect(result).toBeDefined();
    });

    it('propagates router errors', async () => {
      mockQueryRouter.analyze.mockRejectedValue(new Error('router down'));
      await expect(controller.analyzeQuery({ query: 'test' })).rejects.toThrow('router down');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /v1/hierarchy/stats
  // ──────────────────────────────────────────────────────────────────────────
  describe('getStats', () => {
    it('merges service stats with enabled flag', async () => {
      mockHierarchyService.getStats.mockResolvedValue({
        totalUnits: 42,
        byLevel: { L0: 30, L1: 12 },
        lastUpdated: new Date('2026-01-01'),
      });
      mockHierarchyService.isEnabled.mockReturnValue(true);

      const result = await controller.getStats(USER_ID);

      expect(result.totalUnits).toBe(42);
      expect(result.byLevel).toEqual({ L0: 30, L1: 12 });
      expect(result.enabled).toBe(true);
    });

    it('returns enabled:false when module disabled', async () => {
      mockHierarchyService.getStats.mockResolvedValue({ totalUnits: 0, byLevel: {}, lastUpdated: null });
      mockHierarchyService.isEnabled.mockReturnValue(false);

      const result = await controller.getStats(USER_ID);
      expect(result.enabled).toBe(false);
    });

    it('returns null lastUpdated when no units exist', async () => {
      mockHierarchyService.getStats.mockResolvedValue({ totalUnits: 0, byLevel: {}, lastUpdated: null });
      mockHierarchyService.isEnabled.mockReturnValue(true);

      const result = await controller.getStats(USER_ID);
      expect(result.lastUpdated).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /v1/hierarchy/memory/:memoryId
  // ──────────────────────────────────────────────────────────────────────────
  describe('getUnitsForMemory', () => {
    it('returns shaped units for a memory', async () => {
      const rawUnits = [
        { id: 'unit-1', level: 'L0', text: 'Hello world', position: 0, charStart: 0, charEnd: 11 },
        { id: 'unit-2', level: 'L1', text: 'Greeting', position: null, charStart: null, charEnd: null },
      ];
      mockHierarchyService.getUnitsForMemory.mockResolvedValue(rawUnits);

      const result = await controller.getUnitsForMemory('mem-xyz');

      expect(result.memoryId).toBe('mem-xyz');
      expect(result.units).toHaveLength(2);
      expect(result.units[0]).toMatchObject({ id: 'unit-1', level: 'L0', position: 0 });
      expect(result.units[1]).toMatchObject({ id: 'unit-2', position: null });
    });

    it('returns empty units array when memory has no hierarchy units', async () => {
      mockHierarchyService.getUnitsForMemory.mockResolvedValue([]);
      const result = await controller.getUnitsForMemory('mem-no-units');
      expect(result.units).toHaveLength(0);
      expect(result.memoryId).toBe('mem-no-units');
    });

    it('propagates service errors', async () => {
      mockHierarchyService.getUnitsForMemory.mockRejectedValue(new Error('not found'));
      await expect(controller.getUnitsForMemory('bad-id')).rejects.toThrow('not found');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /v1/hierarchy/reprocess
  // ──────────────────────────────────────────────────────────────────────────
  describe('reprocessUser', () => {
    it('reprocesses with default batchSize when not provided', async () => {
      mockHierarchyService.reprocessUser.mockResolvedValue({ processed: 10, failed: 0 });

      const result = await controller.reprocessUser(USER_ID);

      expect(result).toEqual({ processed: 10, failed: 0 });
      expect(mockHierarchyService.reprocessUser).toHaveBeenCalledWith(USER_ID, {
        batchSize: undefined,
      });
    });

    it('parses and passes batchSize string as integer', async () => {
      mockHierarchyService.reprocessUser.mockResolvedValue({ processed: 5, failed: 1 });

      await controller.reprocessUser(USER_ID, '25');

      expect(mockHierarchyService.reprocessUser).toHaveBeenCalledWith(USER_ID, {
        batchSize: 25,
      });
    });

    it('reports failures from service', async () => {
      mockHierarchyService.reprocessUser.mockResolvedValue({ processed: 3, failed: 2 });

      const result = await controller.reprocessUser(USER_ID, '5');
      expect(result.failed).toBe(2);
    });

    it('propagates service errors', async () => {
      mockHierarchyService.reprocessUser.mockRejectedValue(new Error('timeout'));
      await expect(controller.reprocessUser(USER_ID)).rejects.toThrow('timeout');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /v1/hierarchy/status
  // ──────────────────────────────────────────────────────────────────────────
  describe('getStatus', () => {
    it('returns enabled status with MVP levels', async () => {
      mockHierarchyService.isEnabled.mockReturnValue(true);

      const result = await controller.getStatus();

      expect(result.enabled).toBe(true);
      expect(result.levels).toContain('L0');
      expect(result.levels).toContain('L1');
      expect(result.phase).toBe('MVP (Phase 1)');
    });

    it('returns disabled status correctly', async () => {
      mockHierarchyService.isEnabled.mockReturnValue(false);

      const result = await controller.getStatus();
      expect(result.enabled).toBe(false);
    });
  });
});
