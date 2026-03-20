import { MemoryController } from './memory.controller';

describe('MemoryController — Async Import (HEY-353)', () => {
  let controller: MemoryController;
  let mockJobQueue: any;

  beforeEach(() => {
    mockJobQueue = {
      createBatch: jest.fn().mockReturnValue('batch-abc'),
      getBatchStatus: jest.fn(),
    };

    controller = new MemoryController(
      {} as any, // memoryService
      {} as any, // backfillService
      {} as any, // consolidationService
      {} as any, // contextualRecallService
      { user: { findMany: jest.fn().mockResolvedValue([]) } } as any, // prisma
      {} as any, // queueService
      mockJobQueue,
      {} as any, // memoryPipeline
      {} as any, // retrievalSignals
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
        expect.arrayContaining([
          expect.objectContaining({ raw: 'Memory one' }),
          expect.objectContaining({ raw: 'Memory two' }),
        ]),
      );
    });

    it('should generate memoryIds when not provided', async () => {
      const dto = {
        memories: [{ raw: 'No ID memory' }],
      };

      await controller.importMemoriesAsync('user-1', dto as any);

      const call = mockJobQueue.createBatch.mock.calls[0];
      expect(call[1][0].memoryId).toBeDefined();
      expect(typeof call[1][0].memoryId).toBe('string');
      expect(call[1][0].memoryId.length).toBeGreaterThan(0);
    });

    it('should use provided id as memoryId', async () => {
      const dto = {
        memories: [{ raw: 'With ID', id: 'my-custom-id' }],
      };

      await controller.importMemoriesAsync('user-1', dto as any);

      const call = mockJobQueue.createBatch.mock.calls[0];
      expect(call[1][0].memoryId).toBe('my-custom-id');
    });
  });
});
