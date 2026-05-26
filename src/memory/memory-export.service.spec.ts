import { MemoryExportService } from './memory-export.service';
import {
  MemoryLayer,
  MemorySource,
  TemporalAnchorSource,
} from '@prisma/client';

describe('MemoryExportService', () => {
  let service: MemoryExportService;
  let prisma: any;
  let extraction: any;
  let importance: any;
  let dedupService: any;
  let pipelineService: any;
  let eventEmitter: any;

  beforeEach(() => {
    prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
      memoryEmbedding: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      account: {
        update: jest.fn(),
      },
      $transaction: jest.fn((fn: any) => fn(prisma)),
      $executeRawUnsafe: jest.fn(),
    };
    extraction = {
      classifyLayer: jest.fn().mockReturnValue(MemoryLayer.SESSION),
    };
    importance = {
      calculate: jest.fn().mockReturnValue(0.5),
    };
    dedupService = {
      findDuplicateV2: jest.fn().mockResolvedValue({ action: 'create' }),
    };
    pipelineService = {
      extractAndEmbed: jest.fn().mockResolvedValue(undefined),
    };
    eventEmitter = {
      emit: jest.fn(),
    };

    service = new MemoryExportService(
      prisma,
      extraction,
      importance,
      dedupService,
      pipelineService,
      eventEmitter,
    );
  });

  describe('exportMemories', () => {
    it('should return empty array when no memories', async () => {
      const result = await service.exportMemories('user-1');
      expect(result).toEqual([]);
      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', deletedAt: null },
        }),
      );
    });

    it('should map memories to exported format', async () => {
      const mockMemory = {
        id: 'mem-1',
        raw: 'test memory',
        layer: MemoryLayer.SESSION,
        source: MemorySource.EXPLICIT_STATEMENT,
        importanceScore: 0.7,
        confidence: 1.0,
        subjectType: null,
        subjectId: null,
        projectId: null,
        sessionId: null,
        extraction: {
          topics: ['test'],
          who: 'user',
          what: 'testing',
          when: null,
          whereCtx: null,
          why: null,
          how: null,
        },
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      };
      prisma.memory.findMany.mockResolvedValue([mockMemory]);
      prisma.memoryEmbedding.findMany.mockResolvedValue([]);

      const result = await service.exportMemories('user-1');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('mem-1');
      expect(result[0].raw).toBe('test memory');
      expect(result[0].tags).toEqual(['test']);
    });

    it('should include ensemble embeddings when present', async () => {
      const mockMemory = {
        id: 'mem-1',
        raw: 'test',
        layer: MemoryLayer.SESSION,
        source: MemorySource.EXPLICIT_STATEMENT,
        importanceScore: 0.5,
        confidence: 1.0,
        extraction: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      prisma.memory.findMany.mockResolvedValue([mockMemory]);
      prisma.memoryEmbedding.findMany.mockResolvedValue([
        { memoryId: 'mem-1', modelId: 'model-a' },
        { memoryId: 'mem-1', modelId: 'model-b' },
      ]);

      const result = await service.exportMemories('user-1');
      expect(result[0].ensembleEmbeddings).toEqual({
        'model-a': true,
        'model-b': true,
      });
    });
  });

  describe('exportMemoriesBatch', () => {
    it('should support cursor-based pagination', async () => {
      prisma.memory.findMany.mockResolvedValue([]);
      await service.exportMemoriesBatch('user-1', 10, 'cursor-id');
      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 1,
          cursor: { id: 'cursor-id' },
        }),
      );
    });

    it('should work without cursor', async () => {
      prisma.memory.findMany.mockResolvedValue([]);
      await service.exportMemoriesBatch('user-1', 10);
      const call = prisma.memory.findMany.mock.calls[0][0];
      expect(call.take).toBe(10);
      expect(call.cursor).toBeUndefined();
    });
  });

  describe('importMemories', () => {
    const mockUser = {
      id: 'user-1',
      externalId: 'ext-1',
      displayName: 'Test User',
      agent: { accountId: null, account: null },
    };

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(mockUser);
      prisma.memory.create.mockResolvedValue({
        id: 'new-mem-1',
        layer: MemoryLayer.SESSION,
      });
    });

    it('should import a single memory', async () => {
      const result = await service.importMemories('user-1', [
        { raw: 'imported memory' },
      ]);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('should skip duplicates', async () => {
      dedupService.findDuplicateV2.mockResolvedValue({ action: 'skip' });
      const result = await service.importMemories('user-1', [
        { raw: 'duplicate memory' },
      ]);
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('should clamp importance to [0, 1]', async () => {
      await service.importMemories('user-1', [
        { raw: 'test', importance: 1.5 },
      ]);
      const createCall = prisma.memory.create.mock.calls[0][0];
      expect(createCall.data.importanceScore).toBe(1);
    });

    it('should clamp negative importance to 0', async () => {
      await service.importMemories('user-1', [
        { raw: 'test', importance: -0.5 },
      ]);
      const createCall = prisma.memory.create.mock.calls[0][0];
      expect(createCall.data.importanceScore).toBe(0);
    });

    it('should handle errors gracefully', async () => {
      prisma.memory.create.mockRejectedValue(new Error('DB error'));
      const result = await service.importMemories('user-1', [
        { raw: 'will fail' },
      ]);
      expect(result.errors).toBe(1);
      expect(result.imported).toBe(0);
    });

    it('should handle user with no agent/account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        externalId: 'ext-1',
        displayName: null,
        agent: null,
      });
      const result = await service.importMemories('user-1', [
        { raw: 'memory 1' },
        { raw: 'memory 2' },
      ]);
      expect(result.imported).toBe(2);
    });

    it('should use provided layer if valid', async () => {
      await service.importMemories('user-1', [
        { raw: 'identity memory', layer: 'IDENTITY' },
      ]);
      const createCall = prisma.memory.create.mock.calls[0][0];
      expect(createCall.data.layer).toBe(MemoryLayer.IDENTITY);
    });

    it('should classify layer when not provided', async () => {
      await service.importMemories('user-1', [{ raw: 'auto classify' }]);
      expect(extraction.classifyLayer).toHaveBeenCalledWith('auto classify');
    });

    it('should emit memory.created event', async () => {
      await service.importMemories('user-1', [{ raw: 'test' }]);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'memory.created',
        expect.anything(),
      );
    });

    // T5a: temporal anchoring forwarding
    it('persists observedAt + EXPLICIT_CALLER when item has observedAt', async () => {
      await service.importMemories('user-1', [
        { raw: 'Old event', observedAt: '2024-01-15T14:00:00Z' },
      ]);

      const createCall = prisma.memory.create.mock.calls[0][0];
      expect(createCall.data.observedAt).toBeInstanceOf(Date);
      expect(createCall.data.observedAt.toISOString()).toBe(
        '2024-01-15T14:00:00.000Z',
      );
      expect(createCall.data.temporalAnchorSource).toBe(
        TemporalAnchorSource.EXPLICIT_CALLER,
      );
    });

    it('persists observedAt=null + FALLBACK_RECORDED_AT when item has no observedAt', async () => {
      await service.importMemories('user-1', [{ raw: 'Plain import' }]);

      const createCall = prisma.memory.create.mock.calls[0][0];
      expect(createCall.data.observedAt).toBeNull();
      expect(createCall.data.temporalAnchorSource).toBe(
        TemporalAnchorSource.FALLBACK_RECORDED_AT,
      );
    });
  });
});
