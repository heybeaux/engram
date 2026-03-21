import { MemoryCoreController } from './memory-core.controller';
import { MemoryService } from './memory.service';

describe('MemoryCoreController', () => {
  let controller: MemoryCoreController;
  let memoryService: jest.Mocked<MemoryService>;

  const userId = 'user-123';

  beforeEach(() => {
    memoryService = {
      remember: jest.fn(),
      rememberAll: jest.fn(),
      getById: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      markUsed: jest.fn(),
    } as any;

    const prismaService = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    } as any;

    const memoryJobQueue = {
      createBatch: jest.fn().mockReturnValue('batch-123'),
      getBatchStatus: jest.fn(),
    } as any;

    controller = new MemoryCoreController(
      memoryService,
      prismaService,
      memoryJobQueue,
    );
  });

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

  describe('markUsed', () => {
    it('should mark memory as used', async () => {
      memoryService.markUsed.mockResolvedValue(undefined);

      await controller.markUsed(userId, 'mem-1');

      expect(memoryService.markUsed).toHaveBeenCalledWith('mem-1', userId);
    });
  });
});
