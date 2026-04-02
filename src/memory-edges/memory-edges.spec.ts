import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { MemoryEdgesController } from './memory-edges.controller';
import { MemoryEdgesService } from './memory-edges.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

const mockGuard = { canActivate: jest.fn().mockReturnValue(true) };

describe('MemoryEdges', () => {
  let controller: MemoryEdgesController;
  let _service: MemoryEdgesService;
  let _prisma: any;

  const mockPrisma = {
    memoryEdge: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
  };

  const agentId = 'agent-1';
  const mockReq = { agent: { id: agentId } };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MemoryEdgesController],
      providers: [
        MemoryEdgesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue(mockGuard)
      .compile();

    controller = module.get<MemoryEdgesController>(MemoryEdgesController);
    _service = module.get<MemoryEdgesService>(MemoryEdgesService);
    _prisma = module.get<PrismaService>(PrismaService);
  });

  // ==================== CRUD ====================

  describe('createEdge', () => {
    it('should create an edge between two memories', async () => {
      const dto = {
        sourceId: 'mem-1',
        targetId: 'mem-2',
        edgeType: 'caused_by',
        weight: 0.8,
      };
      const expected = { id: 'edge-1', ...dto, agentId };
      mockPrisma.memoryEdge.create.mockResolvedValue(expected);

      const result = await controller.createEdge(dto, mockReq);
      expect(result).toEqual(expected);
      expect(mockPrisma.memoryEdge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sourceId: 'mem-1',
          targetId: 'mem-2',
          edgeType: 'caused_by',
          weight: 0.8,
          agentId,
        }),
        include: { source: true, target: true },
      });
    });

    it('should use default weight and confidence', async () => {
      const dto = {
        sourceId: 'mem-1',
        targetId: 'mem-2',
        edgeType: 'related_to',
      };
      mockPrisma.memoryEdge.create.mockResolvedValue({
        id: 'edge-2',
        ...dto,
        weight: 0.5,
        confidence: 0.5,
        agentId,
      });

      await controller.createEdge(dto, mockReq);
      expect(mockPrisma.memoryEdge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          weight: 0.5,
          confidence: 0.5,
        }),
        include: { source: true, target: true },
      });
    });
  });

  describe('getEdgesForMemory', () => {
    it('should get all edges for a memory (both directions)', async () => {
      const edges = [
        { id: 'e1', sourceId: 'mem-1', targetId: 'mem-2', edgeType: 'led_to' },
        {
          id: 'e2',
          sourceId: 'mem-3',
          targetId: 'mem-1',
          edgeType: 'caused_by',
        },
      ];
      mockPrisma.memoryEdge.findMany.mockResolvedValue(edges);

      const result = await controller.getEdgesForMemory('mem-1', {}, mockReq);
      expect(result).toEqual(edges);
      expect(mockPrisma.memoryEdge.findMany).toHaveBeenCalledWith({
        where: {
          agentId,
          OR: [{ sourceId: 'mem-1' }, { targetId: 'mem-1' }],
        },
        include: { source: true, target: true },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should filter by direction=outgoing', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValue([]);

      await controller.getEdgesForMemory(
        'mem-1',
        { direction: 'outgoing' },
        mockReq,
      );
      expect(mockPrisma.memoryEdge.findMany).toHaveBeenCalledWith({
        where: { agentId, sourceId: 'mem-1' },
        include: { source: true, target: true },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should filter by direction=incoming', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValue([]);

      await controller.getEdgesForMemory(
        'mem-1',
        { direction: 'incoming' },
        mockReq,
      );
      expect(mockPrisma.memoryEdge.findMany).toHaveBeenCalledWith({
        where: { agentId, targetId: 'mem-1' },
        include: { source: true, target: true },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should filter by edge types', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValue([]);

      await controller.getEdgesForMemory(
        'mem-1',
        { edgeTypes: ['caused_by', 'led_to'] },
        mockReq,
      );
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
  });

  describe('deleteEdge', () => {
    it('should delete an edge', async () => {
      const edge = { id: 'edge-1', agentId };
      mockPrisma.memoryEdge.findFirst.mockResolvedValue(edge);
      mockPrisma.memoryEdge.delete.mockResolvedValue(edge);

      const result = await controller.deleteEdge('edge-1', mockReq);
      expect(result).toEqual(edge);
      expect(mockPrisma.memoryEdge.findFirst).toHaveBeenCalledWith({
        where: { id: 'edge-1', agentId },
      });
    });

    it('should throw NotFoundException for missing edge', async () => {
      mockPrisma.memoryEdge.findFirst.mockResolvedValue(null);

      await expect(
        controller.deleteEdge('nonexistent', mockReq),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ==================== Agent isolation ====================

  describe('agent isolation', () => {
    it('should require agent context', async () => {
      const reqNoAgent = {};
      await expect(
        controller.createEdge(
          { sourceId: 'a', targetId: 'b', edgeType: 'related_to' },
          reqNoAgent,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should not delete edges belonging to another agent', async () => {
      mockPrisma.memoryEdge.findFirst.mockResolvedValue(null);

      await expect(
        controller.deleteEdge('edge-other-agent', mockReq),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ==================== Graph Traversal ====================

  describe('findRelated', () => {
    it('should find related memories at depth 1', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValueOnce([
        {
          id: 'e1',
          sourceId: 'mem-1',
          targetId: 'mem-2',
          edgeType: 'led_to',
          source: { id: 'mem-1' },
          target: { id: 'mem-2' },
        },
        {
          id: 'e2',
          sourceId: 'mem-1',
          targetId: 'mem-3',
          edgeType: 'caused_by',
          source: { id: 'mem-1' },
          target: { id: 'mem-3' },
        },
      ]);

      const result = await controller.findRelated(
        { nodeId: 'mem-1', depth: 1, edgeTypes: ['led_to', 'caused_by'] },
        mockReq,
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({ memoryId: 'mem-2', depth: 1 }),
      );
      expect(result[1]).toEqual(
        expect.objectContaining({ memoryId: 'mem-3', depth: 1 }),
      );
    });

    it('should traverse multiple hops (depth 2)', async () => {
      // First hop from mem-1
      mockPrisma.memoryEdge.findMany.mockResolvedValueOnce([
        {
          id: 'e1',
          sourceId: 'mem-1',
          targetId: 'mem-2',
          edgeType: 'led_to',
          source: { id: 'mem-1' },
          target: { id: 'mem-2' },
        },
      ]);
      // Second hop from mem-2
      mockPrisma.memoryEdge.findMany.mockResolvedValueOnce([
        {
          id: 'e2',
          sourceId: 'mem-2',
          targetId: 'mem-3',
          edgeType: 'led_to',
          source: { id: 'mem-2' },
          target: { id: 'mem-3' },
        },
      ]);

      const result = await controller.findRelated(
        { nodeId: 'mem-1', depth: 2, edgeTypes: ['led_to'] },
        mockReq,
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({ memoryId: 'mem-2', depth: 1 }),
      );
      expect(result[1]).toEqual(
        expect.objectContaining({
          memoryId: 'mem-3',
          depth: 2,
          path: ['mem-1', 'mem-2', 'mem-3'],
        }),
      );
    });

    it('should not revisit nodes (cycle handling)', async () => {
      // mem-1 -> mem-2, mem-2 -> mem-1 (cycle)
      mockPrisma.memoryEdge.findMany.mockResolvedValueOnce([
        {
          id: 'e1',
          sourceId: 'mem-1',
          targetId: 'mem-2',
          edgeType: 'related_to',
          source: { id: 'mem-1' },
          target: { id: 'mem-2' },
        },
      ]);
      mockPrisma.memoryEdge.findMany.mockResolvedValueOnce([
        {
          id: 'e2',
          sourceId: 'mem-2',
          targetId: 'mem-1',
          edgeType: 'related_to',
          source: { id: 'mem-2' },
          target: { id: 'mem-1' },
        },
      ]);

      const result = await controller.findRelated(
        { nodeId: 'mem-1', depth: 3, edgeTypes: [] },
        mockReq,
      );

      // Should only visit mem-2 once, not loop back to mem-1
      expect(result).toHaveLength(1);
      expect(result[0].memoryId).toBe('mem-2');
    });

    it('should filter by edge types in traversal', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValueOnce([]);

      await controller.findRelated(
        { nodeId: 'mem-1', depth: 1, edgeTypes: ['contradicts'] },
        mockReq,
      );

      expect(mockPrisma.memoryEdge.findMany).toHaveBeenCalledWith({
        where: {
          agentId,
          OR: [{ sourceId: 'mem-1' }, { targetId: 'mem-1' }],
          edgeType: { in: ['contradicts'] },
        },
        include: { source: true, target: true },
      });
    });

    it('should use default depth 1 and empty edgeTypes', async () => {
      mockPrisma.memoryEdge.findMany.mockResolvedValueOnce([]);

      await controller.findRelated({ nodeId: 'mem-1' }, mockReq);

      expect(mockPrisma.memoryEdge.findMany).toHaveBeenCalledWith({
        where: {
          agentId,
          OR: [{ sourceId: 'mem-1' }, { targetId: 'mem-1' }],
        },
        include: { source: true, target: true },
      });
    });

    it('should traverse depth 3', async () => {
      // mem-1 -> mem-2 -> mem-3 -> mem-4
      mockPrisma.memoryEdge.findMany
        .mockResolvedValueOnce([
          {
            id: 'e1',
            sourceId: 'mem-1',
            targetId: 'mem-2',
            edgeType: 'led_to',
            source: { id: 'mem-1' },
            target: { id: 'mem-2' },
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'e2',
            sourceId: 'mem-2',
            targetId: 'mem-3',
            edgeType: 'led_to',
            source: { id: 'mem-2' },
            target: { id: 'mem-3' },
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'e3',
            sourceId: 'mem-3',
            targetId: 'mem-4',
            edgeType: 'led_to',
            source: { id: 'mem-3' },
            target: { id: 'mem-4' },
          },
        ]);

      const result = await controller.findRelated(
        { nodeId: 'mem-1', depth: 3, edgeTypes: [] },
        mockReq,
      );

      expect(result).toHaveLength(3);
      expect(result[0].memoryId).toBe('mem-2');
      expect(result[0].depth).toBe(1);
      expect(result[1].memoryId).toBe('mem-3');
      expect(result[1].depth).toBe(2);
      expect(result[2].memoryId).toBe('mem-4');
      expect(result[2].depth).toBe(3);
    });
  });
});
