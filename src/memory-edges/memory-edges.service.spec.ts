import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { MemoryEdgesService } from './memory-edges.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  memoryEdge: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    delete: jest.fn(),
  },
};

const agentId = 'agent-1';

const makeEdge = (id: string, sourceId: string, targetId: string, edgeType = 'related_to') => ({
  id,
  sourceId,
  targetId,
  edgeType,
  weight: 0.5,
  confidence: 0.5,
  agentId,
  source: { id: sourceId },
  target: { id: targetId },
  createdAt: new Date(),
});

describe('MemoryEdgesService', () => {
  let service: MemoryEdgesService;

  beforeEach(async () => {
    jest.resetAllMocks(); // resetAllMocks (not clearAllMocks) to drain mockResolvedValueOnce queues between tests

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryEdgesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<MemoryEdgesService>(MemoryEdgesService);
  });

  // ===================== createEdge =====================

  describe('createEdge', () => {
    const dto = {
      sourceId: 'mem-1',
      targetId: 'mem-2',
      edgeType: 'caused_by',
    };

    it('should create an edge with required fields', async () => {
      const expected = makeEdge('edge-1', 'mem-1', 'mem-2', 'caused_by');
      mockPrisma.memoryEdge.create.mockResolvedValue(expected);

      const result = await service.createEdge(dto, agentId);

      expect(result).toEqual(expected);
      expect(mockPrisma.memoryEdge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sourceId: 'mem-1',
          targetId: 'mem-2',
          edgeType: 'caused_by',
          agentId,
        }),
        include: { source: true, target: true },
      });
    });

    it('should apply default weight of 0.5 when not provided', async () => {
      mockPrisma.memoryEdge.create.mockResolvedValue(makeEdge('e1', 'mem-1', 'mem-2'));

      await service.createEdge(dto, agentId);

      expect(mockPrisma.memoryEdge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ weight: 0.5 }),
        include: { source: true, target: true },
      });
    });

    it('should apply default confidence of 0.5 when not provided', async () => {
      mockPrisma.memoryEdge.create.mockResolvedValue(makeEdge('e1', 'mem-1', 'mem-2'));

      await service.createEdge(dto, agentId);

      expect(mockPrisma.memoryEdge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ confidence: 0.5 }),
        include: { source: true, target: true },
      });
    });

    it('should use provided weight and confidence', async () => {
      mockPrisma.memoryEdge.create.mockResolvedValue(makeEdge('e1', 'mem-1', 'mem-2'));

      await service.createEdge({ ...dto, weight: 0.9, confidence: 0.85 }, agentId);

      expect(mockPrisma.memoryEdge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ weight: 0.9, confidence: 0.85 }),
        include: { source: true, target: true },
      });
    });

    it('should apply default empty metadata when not provided', async () => {
      mockPrisma.memoryEdge.create.mockResolvedValue(makeEdge('e1', 'mem-1', 'mem-2'));

      await service.createEdge(dto, agentId);

      expect(mockPrisma.memoryEdge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ metadata: {} }),
        include: { source: true, target: true },
      });
    });

    it('should convert temporalStart string to Date', async () => {
      mockPrisma.memoryEdge.create.mockResolvedValue(makeEdge('e1', 'mem-1', 'mem-2'));

      await service.createEdge({ ...dto, temporalStart: '2026-01-01T00:00:00Z' }, agentId);

      const callData = mockPrisma.memoryEdge.create.mock.calls[0][0].data;
      expect(callData.temporalStart).toBeInstanceOf(Date);
    });

    it('should convert temporalEnd string to Date', async () => {
      mockPrisma.memoryEdge.create.mockResolvedValue(makeEdge('e1', 'mem-1', 'mem-2'));

      await service.createEdge({ ...dto, temporalEnd: '2026-12-31T23:59:59Z' }, agentId);

      const callData = mockPrisma.memoryEdge.create.mock.calls[0][0].data;
      expect(callData.temporalEnd).toBeInstanceOf(Date);
    });

    it('should leave temporalStart undefined when not provided', async () => {
      mockPrisma.memoryEdge.create.mockResolvedValue(makeEdge('e1', 'mem-1', 'mem-2'));

      await service.createEdge(dto, agentId);

      const callData = mockPrisma.memoryEdge.create.mock.calls[0][0].data;
      expect(callData.temporalStart).toBeUndefined();
    });

    it('should propagate prisma create errors', async () => {
      mockPrisma.memoryEdge.create.mockRejectedValue(new Error('Foreign key constraint'));

      await expect(service.createEdge(dto, agentId)).rejects.toThrow('Foreign key constraint');
    });
  });

  // ===================== getEdgesForMemory =====================

  describe('getEdgesForMemory', () => {
    it('should get all edges (both directions) by default', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValue([]);

      await service.getEdgesForMemory('mem-1', agentId);

      expect(mockPrisma.memoryEdge.findMany).toHaveBeenCalledWith({
        where: {
          agentId,
          OR: [{ sourceId: 'mem-1' }, { targetId: 'mem-1' }],
        },
        include: { source: true, target: true },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should filter outgoing edges', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValue([]);

      await service.getEdgesForMemory('mem-1', agentId, 'outgoing');

      expect(mockPrisma.memoryEdge.findMany).toHaveBeenCalledWith({
        where: { agentId, sourceId: 'mem-1' },
        include: { source: true, target: true },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should filter incoming edges', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValue([]);

      await service.getEdgesForMemory('mem-1', agentId, 'incoming');

      expect(mockPrisma.memoryEdge.findMany).toHaveBeenCalledWith({
        where: { agentId, targetId: 'mem-1' },
        include: { source: true, target: true },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should filter by edge types when provided', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValue([]);

      await service.getEdgesForMemory('mem-1', agentId, 'both', ['caused_by', 'led_to']);

      expect(mockPrisma.memoryEdge.findMany).toHaveBeenCalledWith({
        where: {
          agentId,
          edgeType: { in: ['caused_by', 'led_to'] },
          OR: [{ sourceId: 'mem-1' }, { targetId: 'mem-1' }],
        },
        include: { source: true, target: true },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should not add edgeType filter for empty array', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValue([]);

      await service.getEdgesForMemory('mem-1', agentId, 'both', []);

      const callWhere = mockPrisma.memoryEdge.findMany.mock.calls[0][0].where;
      expect(callWhere.edgeType).toBeUndefined();
    });

    it('should return found edges', async () => {
      const edges = [makeEdge('e1', 'mem-1', 'mem-2')];
      mockPrisma.memoryEdge.findMany.mockResolvedValue(edges);

      const result = await service.getEdgesForMemory('mem-1', agentId);

      expect(result).toEqual(edges);
    });
  });

  // ===================== deleteEdge =====================

  describe('deleteEdge', () => {
    it('should delete an edge when found', async () => {
      const edge = makeEdge('edge-1', 'mem-1', 'mem-2');
      mockPrisma.memoryEdge.findFirst.mockResolvedValue(edge);
      mockPrisma.memoryEdge.delete.mockResolvedValue(edge);

      const result = await service.deleteEdge('edge-1', agentId);

      expect(result).toEqual(edge);
      expect(mockPrisma.memoryEdge.findFirst).toHaveBeenCalledWith({
        where: { id: 'edge-1', agentId },
      });
      expect(mockPrisma.memoryEdge.delete).toHaveBeenCalledWith({
        where: { id: 'edge-1' },
      });
    });

    it('should throw NotFoundException when edge not found', async () => {
      mockPrisma.memoryEdge.findFirst.mockResolvedValue(null);

      await expect(service.deleteEdge('nonexistent', agentId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException with correct message', async () => {
      mockPrisma.memoryEdge.findFirst.mockResolvedValue(null);

      await expect(service.deleteEdge('edge-999', agentId)).rejects.toThrow(
        'Edge edge-999 not found',
      );
    });

    it('should enforce agent isolation — not delete edges from another agent', async () => {
      // findFirst returns null because agentId doesn't match
      mockPrisma.memoryEdge.findFirst.mockResolvedValue(null);

      await expect(service.deleteEdge('edge-other', agentId)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.memoryEdge.delete).not.toHaveBeenCalled();
    });
  });

  // ===================== findRelated =====================

  describe('findRelated', () => {
    it('should return empty array when no edges found', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValue([]);

      const result = await service.findRelated('mem-1', 2, [], agentId);

      expect(result).toEqual([]);
    });

    it('should find direct neighbors at depth 1', async () => {
      mockPrisma.memoryEdge.findMany
        .mockResolvedValueOnce([makeEdge('e1', 'mem-1', 'mem-2', 'led_to')])
        .mockResolvedValueOnce([]); // no further edges from mem-2

      const result = await service.findRelated('mem-1', 1, [], agentId);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        memoryId: 'mem-2',
        depth: 1,
        path: ['mem-1', 'mem-2'],
        edgeType: 'led_to',
      });
    });

    it('should traverse multiple hops', async () => {
      mockPrisma.memoryEdge.findMany
        .mockResolvedValueOnce([makeEdge('e1', 'mem-1', 'mem-2', 'led_to')])
        .mockResolvedValueOnce([makeEdge('e2', 'mem-2', 'mem-3', 'led_to')]);

      const result = await service.findRelated('mem-1', 2, [], agentId);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(expect.objectContaining({ memoryId: 'mem-2', depth: 1 }));
      expect(result[1]).toEqual(expect.objectContaining({ memoryId: 'mem-3', depth: 2 }));
    });

    it('should not traverse beyond the specified depth', async () => {
      // Only go to depth 1 even if there are more edges
      mockPrisma.memoryEdge.findMany.mockResolvedValue([
        makeEdge('e1', 'mem-1', 'mem-2', 'led_to'),
      ]);

      const result = await service.findRelated('mem-1', 1, [], agentId);

      // At depth 1, we find mem-2. When processing mem-2, currentDepth=1 >= depth=1, skip.
      expect(result).toHaveLength(1);
      expect(mockPrisma.memoryEdge.findMany).toHaveBeenCalledTimes(1);
    });

    it('should handle cycles without infinite loops', async () => {
      // mem-1 -> mem-2 -> mem-1 (cycle)
      mockPrisma.memoryEdge.findMany
        .mockResolvedValueOnce([makeEdge('e1', 'mem-1', 'mem-2', 'related_to')])
        .mockResolvedValueOnce([makeEdge('e2', 'mem-2', 'mem-1', 'related_to')]);

      const result = await service.findRelated('mem-1', 3, [], agentId);

      // Should only visit mem-2 once
      expect(result).toHaveLength(1);
      expect(result[0].memoryId).toBe('mem-2');
    });

    it('should filter by edge types', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValue([]);

      await service.findRelated('mem-1', 1, ['caused_by', 'led_to'], agentId);

      expect(mockPrisma.memoryEdge.findMany).toHaveBeenCalledWith({
        where: {
          agentId,
          OR: [{ sourceId: 'mem-1' }, { targetId: 'mem-1' }],
          edgeType: { in: ['caused_by', 'led_to'] },
        },
        include: { source: true, target: true },
      });
    });

    it('should not apply edgeType filter for empty array', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValue([]);

      await service.findRelated('mem-1', 1, [], agentId);

      const callWhere = mockPrisma.memoryEdge.findMany.mock.calls[0][0].where;
      expect(callWhere.edgeType).toBeUndefined();
    });

    it('should include correct path in results', async () => {
      mockPrisma.memoryEdge.findMany
        .mockResolvedValueOnce([makeEdge('e1', 'mem-1', 'mem-2')])
        .mockResolvedValueOnce([makeEdge('e2', 'mem-2', 'mem-3')])
        .mockResolvedValueOnce([]);

      const result = await service.findRelated('mem-1', 2, [], agentId);

      expect(result[0].path).toEqual(['mem-1', 'mem-2']);
      expect(result[1].path).toEqual(['mem-1', 'mem-2', 'mem-3']);
    });

    it('should handle incoming edges (neighbor is sourceId)', async () => {
      // mem-3 -> mem-1 (mem-1 is the target, mem-3 is the neighbor)
      mockPrisma.memoryEdge.findMany
        .mockResolvedValueOnce([makeEdge('e1', 'mem-3', 'mem-1', 'caused_by')])
        .mockResolvedValueOnce([]);

      const result = await service.findRelated('mem-1', 1, [], agentId);

      expect(result).toHaveLength(1);
      expect(result[0].memoryId).toBe('mem-3');
    });
  });
});
