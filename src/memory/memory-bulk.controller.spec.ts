import { MemoryBulkController } from './memory-bulk.controller';
import { MemoryService } from './memory.service';
import { MemoryJobQueueService } from './memory-job-queue.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockMemoryService = {
  bulkCreate: jest.fn(),
  bulkTextImport: jest.fn(),
  exportMemoriesFiltered: jest.fn(),
  exportMemoriesBatch: jest.fn(),
  importMemories: jest.fn(),
};

const mockMemoryJobQueue = {
  createBatch: jest.fn(),
};

const mockMemoryPipeline = {
  getEmbeddingStatus: jest.fn(),
  retryFailedEmbeddings: jest.fn(),
};

const mockRes = () => ({
  setHeader: jest.fn(),
  write: jest.fn(),
  end: jest.fn(),
  json: jest.fn(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAsyncIterable(chunks: (string | Buffer)[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () =>
          i < chunks.length
            ? { value: chunks[i++], done: false }
            : { value: undefined, done: true },
      };
    },
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('MemoryBulkController', () => {
  let controller: MemoryBulkController;
  const userId = 'user-abc';

  beforeEach(() => {
    jest.clearAllMocks();
    // mockResolvedValueOnce queues are NOT cleared by clearAllMocks — reset each mock
    // to drain leftover queued values between tests.
    Object.values(mockMemoryService).forEach((fn: any) => fn.mockReset?.());
    Object.values(mockMemoryPipeline).forEach((fn: any) => fn.mockReset?.());
    Object.values(mockMemoryJobQueue).forEach((fn: any) => fn.mockReset?.());
    controller = new MemoryBulkController(
      mockMemoryService as unknown as MemoryService,
      mockMemoryJobQueue as unknown as MemoryJobQueueService,
      mockMemoryPipeline as unknown as MemoryPipelineService,
    );
  });

  // ── Guard enforcement ──────────────────────────────────────────────────────

  describe('Guard enforcement', () => {
    it('should apply ApiKeyOrJwtGuard', () => {
      const guards: any[] = Reflect.getMetadata('__guards__', MemoryBulkController) ?? [];
      const names = guards.map((g) => (typeof g === 'function' ? g.name : g?.constructor?.name));
      expect(names).toContain(ApiKeyOrJwtGuard.name);
    });

    it('should apply RateLimitGuard', () => {
      const guards: any[] = Reflect.getMetadata('__guards__', MemoryBulkController) ?? [];
      const names = guards.map((g) => (typeof g === 'function' ? g.name : g?.constructor?.name));
      expect(names).toContain(RateLimitGuard.name);
    });
  });

  // ── bulkCreate ─────────────────────────────────────────────────────────────

  describe('bulkCreate', () => {
    const dto = { memories: [{ raw: 'memory 1' }, { raw: 'memory 2' }] } as any;
    const result = { created: 2, queued: 2 };

    it('should delegate to memoryService.bulkCreate', async () => {
      mockMemoryService.bulkCreate.mockResolvedValue(result);
      const out = await controller.bulkCreate(userId, dto);
      expect(out).toEqual(result);
      expect(mockMemoryService.bulkCreate).toHaveBeenCalledWith(userId, dto);
    });

    it('should propagate service errors', async () => {
      mockMemoryService.bulkCreate.mockRejectedValue(new Error('DB error'));
      await expect(controller.bulkCreate(userId, dto)).rejects.toThrow('DB error');
    });
  });

  // ── bulkTextImport ─────────────────────────────────────────────────────────

  describe('bulkTextImport', () => {
    const dto = { text: 'Long text content here...' } as any;
    const result = { chunks: 3, created: 3 };

    it('should delegate to memoryService.bulkTextImport', async () => {
      mockMemoryService.bulkTextImport.mockResolvedValue(result);
      const out = await controller.bulkTextImport(userId, dto);
      expect(out).toEqual(result);
      expect(mockMemoryService.bulkTextImport).toHaveBeenCalledWith(userId, dto);
    });

    it('should propagate service errors', async () => {
      mockMemoryService.bulkTextImport.mockRejectedValue(new Error('chunk error'));
      await expect(controller.bulkTextImport(userId, dto)).rejects.toThrow('chunk error');
    });
  });

  // ── exportMemoriesFiltered ─────────────────────────────────────────────────

  describe('exportMemoriesFiltered', () => {
    const memory = {
      id: 'm1',
      raw: 'test memory',
      layer: 'EPISODIC',
      importance: 0.8,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
    };

    it('should stream JSON format', async () => {
      mockMemoryService.exportMemoriesFiltered
        .mockResolvedValueOnce([memory])
        .mockResolvedValueOnce([]);
      const res = mockRes();
      const query = { format: 'json' } as any;
      await controller.exportMemoriesFiltered(userId, query, res as any);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(res.write).toHaveBeenCalledWith('[');
      expect(res.write).toHaveBeenCalledWith(JSON.stringify(memory));
      expect(res.write).toHaveBeenCalledWith(']');
      expect(res.end).toHaveBeenCalled();
    });

    it('should stream NDJSON format', async () => {
      mockMemoryService.exportMemoriesFiltered
        .mockResolvedValueOnce([memory])
        .mockResolvedValueOnce([]);
      const res = mockRes();
      const query = { format: 'ndjson' } as any;
      await controller.exportMemoriesFiltered(userId, query, res as any);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson');
      expect(res.write).toHaveBeenCalledWith(JSON.stringify(memory) + '\n');
      expect(res.end).toHaveBeenCalled();
    });

    it('should stream CSV format with header row', async () => {
      mockMemoryService.exportMemoriesFiltered
        .mockResolvedValueOnce([memory])
        .mockResolvedValueOnce([]);
      const res = mockRes();
      const query = { format: 'csv' } as any;
      await controller.exportMemoriesFiltered(userId, query, res as any);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
      expect(res.write).toHaveBeenCalledWith('id,raw,layer,importance,createdAt,updatedAt\n');
      expect(res.end).toHaveBeenCalled();
    });

    it('should handle CSV escaping of double-quotes in raw', async () => {
      const memWithQuotes = { ...memory, raw: 'say "hello"' };
      mockMemoryService.exportMemoriesFiltered
        .mockResolvedValueOnce([memWithQuotes])
        .mockResolvedValueOnce([]);
      const res = mockRes();
      await controller.exportMemoriesFiltered(userId, { format: 'csv' } as any, res as any);

      const writeCalls = (res.write as jest.Mock).mock.calls.map((c) => c[0]);
      const dataRow = writeCalls.find((s: string) => s.includes('say'));
      expect(dataRow).toContain('say ""hello""');
    });

    it('should write comma separator for second JSON item', async () => {
      mockMemoryService.exportMemoriesFiltered
        .mockResolvedValueOnce([memory, { ...memory, id: 'm2' }])
        .mockResolvedValueOnce([]);
      const res = mockRes();
      await controller.exportMemoriesFiltered(userId, { format: 'json' } as any, res as any);

      const writeCalls = (res.write as jest.Mock).mock.calls.map((c) => c[0]);
      expect(writeCalls).toContain(',');
    });

    it('should set Content-Disposition header', async () => {
      mockMemoryService.exportMemoriesFiltered.mockResolvedValueOnce([]);
      const res = mockRes();
      await controller.exportMemoriesFiltered(userId, { format: 'json' } as any, res as any);
      const [name, value] = (res.setHeader as jest.Mock).mock.calls.find(
        (c) => c[0] === 'Content-Disposition',
      );
      expect(name).toBe('Content-Disposition');
      expect(value).toMatch(/attachment; filename="engram-export-.+\.json"/);
    });

    it('should paginate using cursor when batch is full (500)', async () => {
      const bigBatch = Array.from({ length: 500 }, (_, i) => ({
        ...memory,
        id: `m${i}`,
      }));
      mockMemoryService.exportMemoriesFiltered
        .mockResolvedValueOnce(bigBatch)
        .mockResolvedValueOnce([]);
      const res = mockRes();
      await controller.exportMemoriesFiltered(userId, { format: 'ndjson' } as any, res as any);

      expect(mockMemoryService.exportMemoriesFiltered).toHaveBeenCalledTimes(2);
      const secondCall = mockMemoryService.exportMemoriesFiltered.mock.calls[1];
      expect(secondCall[3]).toBe('m499'); // cursor = last id
    });

    it('should pass filters from query', async () => {
      mockMemoryService.exportMemoriesFiltered.mockResolvedValueOnce([]);
      const res = mockRes();
      const query = {
        format: 'json',
        layer: 'SEMANTIC',
        projectId: 'proj-1',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      } as any;
      await controller.exportMemoriesFiltered(userId, query, res as any);

      expect(mockMemoryService.exportMemoriesFiltered).toHaveBeenCalledWith(
        userId,
        { layer: 'SEMANTIC', projectId: 'proj-1', startDate: '2026-01-01', endDate: '2026-12-31' },
        500,
        undefined,
      );
    });
  });

  // ── exportMemories ─────────────────────────────────────────────────────────

  describe('exportMemories', () => {
    const memory = { id: 'm1', raw: 'test', layer: 'EPISODIC' };

    it('should stream JSON by default', async () => {
      mockMemoryService.exportMemoriesBatch
        .mockResolvedValueOnce([memory])
        .mockResolvedValueOnce([]);
      const res = mockRes();
      await controller.exportMemories(userId, { format: 'json' } as any, res as any);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(res.write).toHaveBeenCalledWith('[');
      expect(res.write).toHaveBeenCalledWith(']');
      expect(res.end).toHaveBeenCalled();
    });

    it('should stream NDJSON format', async () => {
      mockMemoryService.exportMemoriesBatch
        .mockResolvedValueOnce([memory])
        .mockResolvedValueOnce([]);
      const res = mockRes();
      await controller.exportMemories(userId, { format: 'ndjson' } as any, res as any);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson');
      expect(res.write).toHaveBeenCalledWith(JSON.stringify(memory) + '\n');
      expect(res.end).toHaveBeenCalled();
    });

    it('should NOT write closing bracket for ndjson', async () => {
      mockMemoryService.exportMemoriesBatch.mockResolvedValueOnce([]);
      const res = mockRes();
      await controller.exportMemories(userId, { format: 'ndjson' } as any, res as any);

      const writeCalls = (res.write as jest.Mock).mock.calls.map((c) => c[0]);
      expect(writeCalls).not.toContain(']');
    });

    it('should use .ndjson extension in Content-Disposition', async () => {
      mockMemoryService.exportMemoriesBatch.mockResolvedValueOnce([]);
      const res = mockRes();
      await controller.exportMemories(userId, { format: 'ndjson' } as any, res as any);
      const cdCall = (res.setHeader as jest.Mock).mock.calls.find((c) => c[0] === 'Content-Disposition');
      expect(cdCall[1]).toMatch(/\.ndjson"/);
    });
  });

  // ── importMemories ─────────────────────────────────────────────────────────

  describe('importMemories', () => {
    const dto = {
      memories: [{ id: 'old-id', raw: 'memory text', metadata: {} }],
    } as any;
    const result = { imported: 1, skipped: 0, errors: 0 };

    it('should delegate to memoryService.importMemories', async () => {
      mockMemoryService.importMemories.mockResolvedValue(result);
      const out = await controller.importMemories(userId, dto);
      expect(out).toEqual(result);
      expect(mockMemoryService.importMemories).toHaveBeenCalledWith(userId, dto.memories);
    });

    it('should propagate service errors', async () => {
      mockMemoryService.importMemories.mockRejectedValue(new Error('plan limit'));
      await expect(controller.importMemories(userId, dto)).rejects.toThrow('plan limit');
    });
  });

  // ── importStream ───────────────────────────────────────────────────────────

  describe('importStream', () => {
    it('should process valid NDJSON lines', async () => {
      const mem1 = { raw: 'line 1' };
      const mem2 = { raw: 'line 2' };
      const ndjson = [JSON.stringify(mem1), JSON.stringify(mem2)].join('\n');
      const req = makeAsyncIterable([Buffer.from(ndjson)]);
      const res = mockRes();

      mockMemoryService.importMemories
        .mockResolvedValueOnce({ imported: 1, skipped: 0, errors: 0 })
        .mockResolvedValueOnce({ imported: 1, skipped: 0, errors: 0 });

      await controller.importStream(userId, req as any, res as any);

      expect(res.json).toHaveBeenCalledWith({
        imported: 2,
        skipped: 0,
        errors: 0,
        errorDetails: [],
      });
    });

    it('should count malformed lines as errors', async () => {
      const ndjson = 'NOT JSON\n{"raw":"ok"}';
      const req = makeAsyncIterable([Buffer.from(ndjson)]);
      const res = mockRes();

      mockMemoryService.importMemories.mockResolvedValueOnce({
        imported: 1,
        skipped: 0,
        errors: 0,
      });

      await controller.importStream(userId, req as any, res as any);

      const out = (res.json as jest.Mock).mock.calls[0][0];
      expect(out.errors).toBe(1);
      expect(out.errorDetails).toHaveLength(1);
    });

    it('should cap errorDetails at 10 entries', async () => {
      const badLines = Array.from({ length: 15 }, () => 'INVALID').join('\n');
      const req = makeAsyncIterable([Buffer.from(badLines)]);
      const res = mockRes();

      await controller.importStream(userId, req as any, res as any);

      const out = (res.json as jest.Mock).mock.calls[0][0];
      expect(out.errors).toBe(15);
      expect(out.errorDetails.length).toBeLessThanOrEqual(10);
    });

    it('should skip blank lines', async () => {
      const ndjson = '\n\n{"raw":"ok"}\n\n';
      const req = makeAsyncIterable([Buffer.from(ndjson)]);
      const res = mockRes();
      mockMemoryService.importMemories.mockResolvedValue({ imported: 1, skipped: 0, errors: 0 });

      await controller.importStream(userId, req as any, res as any);

      expect(mockMemoryService.importMemories).toHaveBeenCalledTimes(1);
    });

    it('should handle string chunks from req', async () => {
      const mem = { raw: 'string chunk' };
      const req = makeAsyncIterable([JSON.stringify(mem)]);
      const res = mockRes();
      mockMemoryService.importMemories.mockResolvedValue({ imported: 1, skipped: 0, errors: 0 });

      await controller.importStream(userId, req as any, res as any);

      const out = (res.json as jest.Mock).mock.calls[0][0];
      expect(out.imported).toBe(1);
    });
  });

  // ── importMemoriesAsync ────────────────────────────────────────────────────

  describe('importMemoriesAsync', () => {
    it('should enqueue job and return jobId + count', async () => {
      mockMemoryJobQueue.createBatch.mockReturnValue('job-xyz');
      const dto = {
        memories: [
          { id: 'mem-1', raw: 'first', metadata: { extractionContext: 'ctx' } },
          { raw: 'second', metadata: {} },
        ],
      } as any;

      const out = await controller.importMemoriesAsync(userId, dto);

      expect(out.jobId).toBe('job-xyz');
      expect(out.count).toBe(2);
      expect(out.status).toBe('processing');
      expect(mockMemoryJobQueue.createBatch).toHaveBeenCalledWith(
        userId,
        expect.arrayContaining([
          expect.objectContaining({ memoryId: 'mem-1', raw: 'first', extractionContext: 'ctx' }),
          expect.objectContaining({ raw: 'second' }),
        ]),
      );
    });

    it('should generate UUID for memories without id', async () => {
      mockMemoryJobQueue.createBatch.mockReturnValue('job-1');
      const dto = { memories: [{ raw: 'no id', metadata: {} }] } as any;

      await controller.importMemoriesAsync(userId, dto);

      const batchArg = mockMemoryJobQueue.createBatch.mock.calls[0][1];
      expect(batchArg[0].memoryId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('should handle empty memories array', async () => {
      mockMemoryJobQueue.createBatch.mockReturnValue('job-empty');
      const dto = { memories: [] } as any;

      const result = await controller.importMemoriesAsync(userId, dto);

      expect(result.count).toBe(0);
      expect(result.status).toBe('processing');
    });
  });

  // ── getEmbeddingStatus ─────────────────────────────────────────────────────

  describe('getEmbeddingStatus', () => {
    it('should return embedding status from pipeline', async () => {
      const status = {
        withEmbedding: 100,
        withoutEmbedding: 5,
        failedEmbedding: 2,
        pendingEmbedding: 3,
        retryQueueSize: 1,
        exhaustedRetries: 0,
      };
      mockMemoryPipeline.getEmbeddingStatus.mockResolvedValue(status);

      const out = await controller.getEmbeddingStatus(userId);
      expect(out).toEqual(status);
      expect(mockMemoryPipeline.getEmbeddingStatus).toHaveBeenCalledWith(userId);
    });

    it('should propagate service errors', async () => {
      mockMemoryPipeline.getEmbeddingStatus.mockRejectedValue(new Error('pipeline down'));
      await expect(controller.getEmbeddingStatus(userId)).rejects.toThrow('pipeline down');
    });
  });

  // ── retryFailedEmbeddings ──────────────────────────────────────────────────

  describe('retryFailedEmbeddings', () => {
    it('should trigger retry and return counts', async () => {
      const result = { retried: 5, succeeded: 4, failed: 1, discovered: 6 };
      mockMemoryPipeline.retryFailedEmbeddings.mockResolvedValue(result);

      const out = await controller.retryFailedEmbeddings();
      expect(out).toEqual(result);
      expect(mockMemoryPipeline.retryFailedEmbeddings).toHaveBeenCalled();
    });

    it('should propagate errors', async () => {
      mockMemoryPipeline.retryFailedEmbeddings.mockRejectedValue(new Error('embed fail'));
      await expect(controller.retryFailedEmbeddings()).rejects.toThrow('embed fail');
    });
  });
});
