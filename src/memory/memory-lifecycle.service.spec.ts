import { MemoryLifecycleService } from './memory-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractionService } from './extraction.service';
import { EmbeddingService } from './embedding.service';
import { ImportanceService } from './importance.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { MemoryLayer, MemorySource, ImportanceHint } from '@prisma/client';

describe('MemoryLifecycleService', () => {
  let service: MemoryLifecycleService;
  let mockPrisma: any;
  let mockExtraction: any;
  let mockEmbedding: any;
  let mockImportance: any;
  let mockPipelineService: any;

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
    supersededById: null,
    extraction: null,
  };

  beforeEach(() => {
    mockPrisma = {
      memory: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      memoryExtraction: {
        update: jest.fn(),
      },
      memoryChainLink: {
        create: jest.fn(),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-456' }),
      },
    };

    mockExtraction = {
      extract: jest.fn().mockResolvedValue({
        who: null,
        what: 'Test',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
        memoryType: null,
        typeConfidence: null,
        confidence: {
          whoConfidence: null,
          whatConfidence: null,
          whenConfidence: null,
          whereConfidence: null,
          whyConfidence: null,
          howConfidence: null,
        },
      }),
      getPriorityForType: jest.fn().mockReturnValue(3),
      classifyLayer: jest.fn().mockReturnValue('SESSION'),
    };

    mockEmbedding = {
      generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      store: jest.fn().mockResolvedValue('embed-123'),
    };

    mockImportance = {
      calculate: jest.fn().mockReturnValue(0.5),
    };

    mockPipelineService = {
      extractAndEmbed: jest.fn().mockResolvedValue(undefined),
      storeEntities: jest.fn().mockResolvedValue(undefined),
      linkRelatedMemories: jest.fn().mockResolvedValue(undefined),
    };

    service = new MemoryLifecycleService(
      mockPrisma,
      mockExtraction,
      mockEmbedding,
      mockImportance,
      mockPipelineService,
    );
  });

  describe('markUsed', () => {
    it('should increment usedCount and update lastUsedAt', async () => {
      mockPrisma.memory.update.mockResolvedValue(mockMemory);

      await service.markUsed('mem-123');

      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        data: {
          usedCount: { increment: 1 },
          lastUsedAt: expect.any(Date),
        },
      });
    });

    it('should verify ownership when userId provided', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({ userId: 'user-456' });
      mockPrisma.memory.update.mockResolvedValue(mockMemory);

      await service.markUsed('mem-123', 'user-456');

      expect(mockPrisma.memory.findUnique).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        select: { userId: true },
      });
    });

    it('should throw when user does not own memory', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({ userId: 'other-user' });

      await expect(
        service.markUsed('mem-123', 'user-456'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getById', () => {
    it('should return memory with extraction', async () => {
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
      mockPrisma.memory.findUnique.mockResolvedValue(memoryWithExtraction);

      const result = await service.getById('mem-123');

      expect(mockPrisma.memory.findUnique).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        include: { extraction: true },
      });
      expect(result).toEqual(memoryWithExtraction);
    });

    it('should return null for non-existent memory', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue(null);

      const result = await service.getById('non-existent');
      expect(result).toBeNull();
    });

    it('should allow access with accountId context', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue(mockMemory);

      const result = await service.getById(
        'mem-123',
        'different-user',
        undefined,
        'account-1',
      );
      expect(result).toEqual(mockMemory);
    });

    it('should throw ForbiddenException for wrong user', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue(mockMemory);

      await expect(
        service.getById('mem-123', 'wrong-user'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('delete', () => {
    it('should soft delete by setting deletedAt', async () => {
      mockPrisma.memory.update.mockResolvedValue(mockMemory);

      await service.delete('mem-123');

      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('should verify ownership when userId provided', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({ userId: 'user-456' });
      mockPrisma.memory.update.mockResolvedValue(mockMemory);

      await service.delete('mem-123', 'user-456');

      expect(mockPrisma.memory.findUnique).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        select: { userId: true },
      });
    });

    it('should throw NotFoundException for non-existent memory', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue(null);

      await expect(
        service.delete('non-existent', 'user-456'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update memory fields', async () => {
      const memoryWithUser = {
        ...mockMemory,
        extraction: null,
        user: { id: 'user-456', externalId: 'TestUser', displayName: null },
      };
      mockPrisma.memory.findUnique.mockResolvedValue(memoryWithUser);
      mockPrisma.memory.update.mockResolvedValue({
        ...mockMemory,
        extraction: null,
      });

      await service.update('user-456', 'mem-123', {
        importanceHint: ImportanceHint.HIGH,
      });

      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        data: expect.objectContaining({
          importanceHint: ImportanceHint.HIGH,
        }),
        include: { extraction: true },
      });
    });

    it('should throw for non-existent memory', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue(null);

      await expect(
        service.update('user-456', 'non-existent', { raw: 'new' }),
      ).rejects.toThrow('Memory not found');
    });

    it('should throw for wrong user', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        ...mockMemory,
        userId: 'other-user',
      });

      await expect(
        service.update('user-456', 'mem-123', { raw: 'new' }),
      ).rejects.toThrow('Access denied');
    });

    it('should throw for deleted memory', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        ...mockMemory,
        deletedAt: new Date(),
      });

      await expect(
        service.update('user-456', 'mem-123', { raw: 'new' }),
      ).rejects.toThrow('Cannot update deleted memory');
    });
  });

  describe('correctMemory', () => {
    it('should create correction and supersede original', async () => {
      const original = {
        ...mockMemory,
        user: {
          id: 'user-456',
          externalId: 'TestUser',
          displayName: null,
          accountId: null,
        },
      };
      const correction = { ...mockMemory, id: 'correction-1' };

      mockPrisma.memory.findUnique.mockResolvedValue(original);
      mockPrisma.memory.create.mockResolvedValue(correction);
      mockPrisma.memory.update.mockResolvedValue(original);

      const result = await service.correctMemory('user-456', 'mem-123', {
        correctedContent: 'Corrected content',
      });

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          raw: 'Corrected content',
          source: 'CORRECTION',
        }),
      });
      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-123' },
        data: {
          supersededById: correction.id,
          supersededAt: expect.any(Date),
        },
      });
      expect(mockPrisma.memoryChainLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          linkType: 'CONTRADICTS',
          sourceId: correction.id,
          targetId: 'mem-123',
        }),
      });
    });

    it('should throw for already superseded memory', async () => {
      mockPrisma.memory.findUnique.mockResolvedValue({
        ...mockMemory,
        supersededById: 'other-correction',
        user: { id: 'user-456', accountId: null },
      });

      await expect(
        service.correctMemory('user-456', 'mem-123', {
          correctedContent: 'New',
        }),
      ).rejects.toThrow('Memory already superseded');
    });
  });

  describe('exportMemoriesFiltered', () => {
    it('should query memories with filters', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([]);

      await service.exportMemoriesFiltered(
        'user-456',
        { layer: 'IDENTITY' },
        100,
      );

      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'user-456',
            deletedAt: null,
            layer: 'IDENTITY',
          }),
        }),
      );
    });

    it('should support cursor-based pagination', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([]);

      await service.exportMemoriesFiltered('user-456', {}, 100, 'cursor-id');

      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 1,
          cursor: { id: 'cursor-id' },
        }),
      );
    });
  });
});
