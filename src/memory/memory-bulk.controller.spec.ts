import { MemoryBulkController } from './memory-bulk.controller';
import { MemoryService } from './memory.service';
import { MemoryJobQueueService } from './memory-job-queue.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import type { Response } from 'express';

describe('MemoryBulkController', () => {
  let controller: MemoryBulkController;
  let memoryService: jest.Mocked<MemoryService>;
  let memoryJobQueue: jest.Mocked<MemoryJobQueueService>;
  let memoryPipeline: jest.Mocked<MemoryPipelineService>;

  const userId = 'user-test-123';

  beforeEach(() => {
    jest.clearAllMocks();

    memoryService = {
      bulkCreate: jest.fn(),
      bulkTextImport: jest.fn(),
      exportMemoriesFiltered: jest.fn(),
      exportMemoriesBatch: jest.fn(),
      importMemories: jest.fn(),
    } as any;

    memoryJobQueue = {
      createBatch: jest.fn(),
    } as any;

    memoryPipeline = {
      getEmbeddingStatus: jest.fn(),
      retryFailedEmbeddings: jest.fn(),
    } as any;

    controller = new MemoryBulkController(
      memoryService,
      memoryJobQueue,
      memoryPipeline,
    );
  });

  // =========================================================================
  // bulkCreate
  // =========================================================================
  describe('bulkCreate', () => {
    it('should create multiple memories and return result', async () => {
      const dto = {
        memories: [
          { raw: 'memory one' },
          { raw: 'memory two' },
        ],
      } as any;
      const expected = { created: 2, failed: 0, memoryIds: ['id1', 'id2'] };
      memoryService.bulkCreate.mockResolvedValue(expected as any);

      const result = await controller.bulkCreate(userId, dto);

      expect(result).toEqual(expected);
      expect(memoryService.bulkCreate).toHaveBeenCalledWith(userId, dto);
    });

    it('should propagate errors from memoryService.bulkCreate', async () => {
      const dto = { memories: [{ raw: 'test' }] } as any;
      memoryService.bulkCreate.mockRejectedValue(new Error('DB write error'));

      await expect(controller.bulkCreate(userId, dto)).rejects.toThrow('DB write error');
    });

    it('should handle large batches up to 1000', async () => {
      const memories = Array.from({ length: 1000 }, (_, i) => ({ raw: `memory ${i}` }));
      const dto = { memories } as any;
      const expected = { created: 1000, failed: 0, memoryIds: [] };
      memoryService.bulkCreate.mockResolvedValue(expected as any);

      const result = await controller.bulkCreate(userId, dto);

      expect(result.created).toBe(1000);
      expect(memoryService.bulkCreate).toHaveBeenCalledWith(userId, dto);
    });
  });

  // =========================================================================
  // bulkTextImport
  // =========================================================================
  describe('bulkTextImport', () => {
    it('should auto-chunk text and return result', async () => {
      const dto = { text: 'A long text that should be chunked.' } as any;
      const expected = { chunks: 3, created: 3, failed: 0 };
      memoryService.bulkTextImport.mockResolvedValue(expected as any);

      const result = await controller.bulkTextImport(userId, dto);

      expect(result).toEqual(expected);
      expect(memoryService.bulkTextImport).toHaveBeenCalledWith(userId, dto);
    });

    it('should propagate errors from bulkTextImport', async () => {
      const dto = { text: 'some text' } as any;
      memoryService.bulkTextImport.mockRejectedValue(new Error('Chunking failed'));

      await expect(controller.bulkTextImport(userId, dto)).rejects.toThrow('Chunking failed');
    });
  });

  // =========================================================================
  // exportMemoriesFiltered
  // =========================================================================
  describe('exportMemoriesFiltered', () => {
    let mockRes: jest.Mocked<Partial<Response>>;

    beforeEach(() => {
      mockRes = {
        setHeader: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      } as any;
    });

    const baseMemory = {
      id: 'mem-1',
      raw: 'test memory',
      layer: 'SESSION',
      importance: 0.5,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    };

    it('should export as JSON (default)', async () => {
      memoryService.exportMemoriesFiltered.mockResolvedValueOnce([baseMemory] as any);
      memoryService.exportMemoriesFiltered.mockResolvedValueOnce([] as any); // terminate loop

      const query = { format: 'json' } as any;
      await controller.exportMemoriesFiltered(userId, query, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(mockRes.write).toHaveBeenCalledWith('[');
      expect(mockRes.write).toHaveBeenCalledWith(JSON.stringify(baseMemory));
      expect(mockRes.write).toHaveBeenCalledWith(']');
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should export as CSV with proper escaping', async () => {
      const memoryWithQuotes = { ...baseMemory, raw: 'text with "quotes"' };
      memoryService.exportMemoriesFiltered.mockResolvedValueOnce([memoryWithQuotes] as any);
      memoryService.exportMemoriesFiltered.mockResolvedValueOnce([] as any);

      const query = { format: 'csv' } as any;
      await controller.exportMemoriesFiltered(userId, query, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
      expect(mockRes.write).toHaveBeenCalledWith('id,raw,layer,importance,createdAt,updatedAt\n');
      // Should escape double quotes
      const writeCalls = (mockRes.write as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      const csvLine = writeCalls.find((c: string) => c.includes('text with'));
      expect(csvLine).toContain('""quotes""');
    });

    it('should export as NDJSON', async () => {
      memoryService.exportMemoriesFiltered.mockResolvedValueOnce([baseMemory] as any);
      memoryService.exportMemoriesFiltered.mockResolvedValueOnce([] as any);

      const query = { format: 'ndjson' } as any;
      await controller.exportMemoriesFiltered(userId, query, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson');
      expect(mockRes.write).toHaveBeenCalledWith(JSON.stringify(baseMemory) + '\n');
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should use cursor-based pagination across multiple batches', async () => {
      // Return 500 items twice, then empty to stop
      const batch1 = Array.from({ length: 500 }, (_, i) => ({ ...baseMemory, id: `mem-${i}` }));
      memoryService.exportMemoriesFiltered
        .mockResolvedValueOnce(batch1 as any)
        .mockResolvedValueOnce([]) as any;

      const query = { format: 'json' } as any;
      await controller.exportMemoriesFiltered(userId, query, mockRes as any);

      // Should have called with cursor from last item in first batch
      expect(memoryService.exportMemoriesFiltered).toHaveBeenCalledTimes(2);
      const secondCall = (memoryService.exportMemoriesFiltered as jest.Mock).mock.calls[1];
      expect(secondCall[2]).toBe(500); // BATCH_SIZE
      expect(secondCall[3]).toBe('mem-499'); // cursor = last id
    });

    it('should set Content-Disposition with correct filename for json', async () => {
      memoryService.exportMemoriesFiltered.mockResolvedValue([] as any);

      const query = { format: 'json' } as any;
      await controller.exportMemoriesFiltered(userId, query, mockRes as any);

      const dispositionCalls = (mockRes.setHeader as jest.Mock).mock.calls;
      const dispositionCall = dispositionCalls.find((c: any[]) => c[0] === 'Content-Disposition');
      expect(dispositionCall[1]).toMatch(/attachment; filename="engram-export-.*\.json"/);
    });

    it('should set Content-Disposition with ndjson extension for ndjson format', async () => {
      memoryService.exportMemoriesFiltered.mockResolvedValue([] as any);

      const query = { format: 'ndjson' } as any;
      await controller.exportMemoriesFiltered(userId, query, mockRes as any);

      const dispositionCalls = (mockRes.setHeader as jest.Mock).mock.calls;
      const dispositionCall = dispositionCalls.find((c: any[]) => c[0] === 'Content-Disposition');
      expect(dispositionCall[1]).toMatch(/\.ndjson"/);
    });

    it('should handle empty result set', async () => {
      memoryService.exportMemoriesFiltered.mockResolvedValue([] as any);

      const query = { format: 'json' } as any;
      await controller.exportMemoriesFiltered(userId, query, mockRes as any);

      expect(mockRes.write).toHaveBeenCalledWith('[');
      expect(mockRes.write).toHaveBeenCalledWith(']');
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should add comma separator between JSON items', async () => {
      const memories = [
        { ...baseMemory, id: 'mem-1' },
        { ...baseMemory, id: 'mem-2' },
      ];
      memoryService.exportMemoriesFiltered
        .mockResolvedValueOnce(memories as any)
        .mockResolvedValueOnce([]);

      const query = { format: 'json' } as any;
      await controller.exportMemoriesFiltered(userId, query, mockRes as any);

      const writeCalls = (mockRes.write as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(writeCalls).toContain(',');
    });
  });

  // =========================================================================
  // exportMemories (all)
  // =========================================================================
  describe('exportMemories', () => {
    let mockRes: jest.Mocked<Partial<Response>>;

    beforeEach(() => {
      mockRes = {
        setHeader: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      } as any;
    });

    const baseMemory = {
      id: 'mem-1',
      raw: 'test',
      layer: 'SESSION',
      createdAt: new Date(),
    };

    it('should export all memories as JSON', async () => {
      memoryService.exportMemoriesBatch
        .mockResolvedValueOnce([baseMemory] as any)
        .mockResolvedValueOnce([]);

      const query = { format: 'json' } as any;
      await controller.exportMemories(userId, query, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(mockRes.write).toHaveBeenCalledWith('[');
      expect(mockRes.write).toHaveBeenCalledWith(']');
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should export as NDJSON without brackets', async () => {
      memoryService.exportMemoriesBatch
        .mockResolvedValueOnce([baseMemory] as any)
        .mockResolvedValueOnce([]);

      const query = { format: 'ndjson' } as any;
      await controller.exportMemories(userId, query, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson');
      expect(mockRes.write).toHaveBeenCalledWith(JSON.stringify(baseMemory) + '\n');
      // Should NOT write brackets
      const writeCalls = (mockRes.write as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(writeCalls).not.toContain('[');
      expect(writeCalls).not.toContain(']');
    });

    it('should use cursor-based pagination for all-export', async () => {
      const batch1 = Array.from({ length: 500 }, (_, i) => ({ ...baseMemory, id: `m${i}` }));
      memoryService.exportMemoriesBatch
        .mockResolvedValueOnce(batch1 as any)
        .mockResolvedValueOnce([]);

      const query = { format: 'json' } as any;
      await controller.exportMemories(userId, query, mockRes as any);

      expect(memoryService.exportMemoriesBatch).toHaveBeenCalledTimes(2);
      const secondCall = (memoryService.exportMemoriesBatch as jest.Mock).mock.calls[1];
      expect(secondCall[2]).toBe('m499'); // cursor = last id
    });
  });

  // =========================================================================
  // importMemories
  // =========================================================================
  describe('importMemories', () => {
    it('should import memories and return result', async () => {
      const dto = {
        memories: [{ raw: 'imported memory' }],
      } as any;
      const expected = { imported: 1, skipped: 0, errors: 0 };
      memoryService.importMemories.mockResolvedValue(expected as any);

      const result = await controller.importMemories(userId, dto);

      expect(result).toEqual(expected);
      expect(memoryService.importMemories).toHaveBeenCalledWith(userId, dto.memories);
    });

    it('should handle import with duplicates (skipped)', async () => {
      const dto = { memories: [{ raw: 'dupe' }, { raw: 'dupe' }] } as any;
      memoryService.importMemories.mockResolvedValue({ imported: 1, skipped: 1, errors: 0 } as any);

      const result = await controller.importMemories(userId, dto);

      expect(result.skipped).toBe(1);
    });

    it('should propagate import errors', async () => {
      const dto = { memories: [] } as any;
      memoryService.importMemories.mockRejectedValue(new Error('Import failed'));

      await expect(controller.importMemories(userId, dto)).rejects.toThrow('Import failed');
    });
  });

  // =========================================================================
  // importStream
  // =========================================================================
  describe('importStream', () => {
    let mockRes: jest.Mocked<Partial<Response>>;

    beforeEach(() => {
      mockRes = {
        json: jest.fn(),
      } as any;
    });

    function makeReq(lines: string[]) {
      const body = lines.join('\n');
      const buf = Buffer.from(body);

      // Async iterable that yields buffer chunks
      return {
        async *[Symbol.asyncIterator]() {
          yield buf;
        },
      };
    }

    it('should process valid NDJSON lines and accumulate counts', async () => {
      const lines = [
        JSON.stringify({ raw: 'line 1' }),
        JSON.stringify({ raw: 'line 2' }),
      ];
      const req = makeReq(lines);

      memoryService.importMemories
        .mockResolvedValueOnce({ imported: 1, skipped: 0, errors: 0 } as any)
        .mockResolvedValueOnce({ imported: 1, skipped: 0, errors: 0 } as any);

      await controller.importStream(userId, req, mockRes as any);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ imported: 2, skipped: 0, errors: 0 }),
      );
    });

    it('should skip blank lines', async () => {
      const lines = [
        JSON.stringify({ raw: 'line 1' }),
        '',
        '   ',
        JSON.stringify({ raw: 'line 2' }),
      ];
      const req = makeReq(lines);

      memoryService.importMemories
        .mockResolvedValue({ imported: 1, skipped: 0, errors: 0 } as any);

      await controller.importStream(userId, req, mockRes as any);

      // Only 2 non-blank lines
      expect(memoryService.importMemories).toHaveBeenCalledTimes(2);
    });

    it('should count invalid JSON lines as errors', async () => {
      const req = makeReq(['NOT_VALID_JSON']);

      await controller.importStream(userId, req, mockRes as any);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ errors: 1, imported: 0 }),
      );
    });

    it('should collect up to 10 error details', async () => {
      const badLines = Array.from({ length: 15 }, () => 'BAD_JSON');
      const req = makeReq(badLines);

      await controller.importStream(userId, req, mockRes as any);

      const result = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(result.errors).toBe(15);
      expect(result.errorDetails.length).toBeLessThanOrEqual(10);
    });

    it('should handle import service errors gracefully', async () => {
      const lines = [JSON.stringify({ raw: 'valid' })];
      const req = makeReq(lines);

      memoryService.importMemories.mockRejectedValue(new Error('Service down'));

      await controller.importStream(userId, req, mockRes as any);

      const result = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(result.errors).toBe(1);
      expect(result.errorDetails[0]).toBe('Service down');
    });
  });

  // =========================================================================
  // importMemoriesAsync
  // =========================================================================
  describe('importMemoriesAsync', () => {
    it('should enqueue import job and return job details', async () => {
      const dto = {
        memories: [
          { raw: 'async memory 1' },
          { raw: 'async memory 2', id: 'existing-id', metadata: { extractionContext: 'some context' } },
        ],
      } as any;
      memoryJobQueue.createBatch.mockReturnValue('job-abc-123');

      const result = await controller.importMemoriesAsync(userId, dto);

      expect(result.jobId).toBe('job-abc-123');
      expect(result.count).toBe(2);
      expect(result.status).toBe('processing');
      expect(memoryJobQueue.createBatch).toHaveBeenCalledWith(
        userId,
        expect.arrayContaining([
          expect.objectContaining({ raw: 'async memory 1' }),
          expect.objectContaining({ raw: 'async memory 2', memoryId: 'existing-id', extractionContext: 'some context' }),
        ]),
      );
    });

    it('should generate UUIDs for memories without IDs', async () => {
      const dto = {
        memories: [{ raw: 'no id memory' }],
      } as any;
      memoryJobQueue.createBatch.mockReturnValue('job-xyz');

      await controller.importMemoriesAsync(userId, dto);

      const batchArg = (memoryJobQueue.createBatch as jest.Mock).mock.calls[0][1];
      expect(batchArg[0].memoryId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('should handle empty memories array', async () => {
      const dto = { memories: [] } as any;
      memoryJobQueue.createBatch.mockReturnValue('job-empty');

      const result = await controller.importMemoriesAsync(userId, dto);

      expect(result.count).toBe(0);
      expect(result.status).toBe('processing');
    });
  });

  // =========================================================================
  // getEmbeddingStatus
  // =========================================================================
  describe('getEmbeddingStatus', () => {
    it('should return embedding status for user', async () => {
      const expected = {
        withEmbedding: 100,
        withoutEmbedding: 5,
        failedEmbedding: 2,
        pendingEmbedding: 3,
        retryQueueSize: 1,
        exhaustedRetries: 0,
      };
      memoryPipeline.getEmbeddingStatus.mockResolvedValue(expected);

      const result = await controller.getEmbeddingStatus(userId);

      expect(result).toEqual(expected);
      expect(memoryPipeline.getEmbeddingStatus).toHaveBeenCalledWith(userId);
    });

    it('should propagate errors from pipeline service', async () => {
      memoryPipeline.getEmbeddingStatus.mockRejectedValue(new Error('Pipeline error'));

      await expect(controller.getEmbeddingStatus(userId)).rejects.toThrow('Pipeline error');
    });
  });

  // =========================================================================
  // retryFailedEmbeddings
  // =========================================================================
  describe('retryFailedEmbeddings', () => {
    it('should retry failed embeddings and return counts', async () => {
      const expected = { retried: 10, succeeded: 8, failed: 2, discovered: 3 };
      memoryPipeline.retryFailedEmbeddings.mockResolvedValue(expected);

      const result = await controller.retryFailedEmbeddings();

      expect(result).toEqual(expected);
      expect(memoryPipeline.retryFailedEmbeddings).toHaveBeenCalled();
    });

    it('should handle zero failed embeddings gracefully', async () => {
      memoryPipeline.retryFailedEmbeddings.mockResolvedValue({
        retried: 0,
        succeeded: 0,
        failed: 0,
        discovered: 0,
      });

      const result = await controller.retryFailedEmbeddings();

      expect(result.retried).toBe(0);
    });
  });
});
