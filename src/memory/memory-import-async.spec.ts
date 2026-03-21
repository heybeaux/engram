import { MemoryBulkController } from './memory-bulk.controller';

describe('MemoryBulkController — Async Import (HEY-353)', () => {
  let controller: MemoryBulkController;
  let mockJobQueue: any;

  beforeEach(() => {
    mockJobQueue = {
      createBatch: jest.fn().mockReturnValue('batch-abc'),
      getBatchStatus: jest.fn(),
    };

    controller = new MemoryBulkController(
      {} as any, // memoryService
      mockJobQueue,
      {} as any, // memoryPipeline
    );
  });

  describe('POST /v1/memories/import/async', () => {
    it('should enqueue memories and return 202 with jobId', async () => {
      const dto = {
        memories: [
          { raw: 'Memory one', id: 'existing-id' },
          { raw: 'Memory two' },
        ],
      };

      const result = await controller.importMemoriesAsync('user-1', dto as any);

      expect(result.status).toBe('processing');
      expect(result.jobId).toBe('batch-abc');
      expect(result.count).toBe(2);
      expect(mockJobQueue.createBatch).toHaveBeenCalledWith(
        'user-1',
        [
          { memoryId: 'existing-id', raw: 'Memory one', extractionContext: undefined },
          expect.objectContaining({ raw: 'Memory two', extractionContext: undefined }),
        ],
      );
    });

  });
});
