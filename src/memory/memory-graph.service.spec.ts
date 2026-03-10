import { Test, TestingModule } from '@nestjs/testing';
import { MemoryGraphService } from './memory-graph.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  memory: {
    findMany: jest.fn(),
  },
  graphEntityMention: {
    findMany: jest.fn(),
  },
  graphRelationship: {
    findMany: jest.fn(),
  },
  memoryChainLink: {
    findMany: jest.fn(),
  },
  agent: {
    findMany: jest.fn(),
  },
};

describe('MemoryGraphService', () => {
  let service: MemoryGraphService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryGraphService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<MemoryGraphService>(MemoryGraphService);
  });

  const baseMemory = (id: string, overrides: any = {}) => ({
    id,
    raw: `memory ${id}`,
    layer: 'SEMANTIC',
    source: 'EXPLICIT_STATEMENT',
    userId: 'user-1',
    importanceScore: 0.5,
    effectiveScore: 0.5,
    safetyCritical: false,
    consolidated: false,
    userPinned: false,
    confidence: 0.8,
    createdAt: new Date('2026-01-01'),
    extraction: null,
    ...overrides,
  });

  it('should return nodes, edges, and entities for a user', async () => {
    mockPrisma.memory.findMany.mockResolvedValue([
      baseMemory('m1'),
      baseMemory('m2'),
    ]);
    mockPrisma.graphEntityMention.findMany.mockResolvedValue([]);
    mockPrisma.graphRelationship.findMany.mockResolvedValue([]);
    mockPrisma.memoryChainLink.findMany.mockResolvedValue([]);

    const result = await service.getGraphData('user-1');

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toEqual([]);
    expect(result.entities).toEqual([]);
  });

  it('should create shared-entity edges between memories mentioning the same entity', async () => {
    mockPrisma.memory.findMany.mockResolvedValue([
      baseMemory('m1'),
      baseMemory('m2'),
    ]);
    mockPrisma.graphEntityMention.findMany.mockResolvedValue([
      {
        memoryId: 'm1',
        entity: { id: 'e1', name: 'Coffee', type: 'CONCEPT', mentionCount: 5 },
      },
      {
        memoryId: 'm2',
        entity: { id: 'e1', name: 'Coffee', type: 'CONCEPT', mentionCount: 5 },
      },
    ]);
    mockPrisma.graphRelationship.findMany.mockResolvedValue([]);
    mockPrisma.memoryChainLink.findMany.mockResolvedValue([]);

    const result = await service.getGraphData('user-1');

    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const sharedEdge = result.edges.find((e) =>
      e.linkType.startsWith('shared:'),
    );
    expect(sharedEdge).toBeDefined();
    expect(sharedEdge!.linkType).toBe('shared:Coffee');
  });

  it('should include chain link edges', async () => {
    mockPrisma.memory.findMany.mockResolvedValue([
      baseMemory('m1'),
      baseMemory('m2'),
    ]);
    mockPrisma.graphEntityMention.findMany.mockResolvedValue([]);
    mockPrisma.graphRelationship.findMany.mockResolvedValue([]);
    mockPrisma.memoryChainLink.findMany.mockResolvedValue([
      {
        id: 'chain-1',
        sourceId: 'm1',
        targetId: 'm2',
        linkType: 'FOLLOW_UP',
        confidence: 0.9,
        createdAt: new Date(),
      },
    ]);

    const result = await service.getGraphData('user-1');

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].linkType).toBe('FOLLOW_UP');
  });

  it('should include entity relationship edges', async () => {
    mockPrisma.memory.findMany.mockResolvedValue([baseMemory('m1')]);
    mockPrisma.graphEntityMention.findMany.mockResolvedValue([
      {
        memoryId: 'm1',
        entity: { id: 'e1', name: 'A', type: 'PERSON', mentionCount: 1 },
      },
      {
        memoryId: 'm1',
        entity: { id: 'e2', name: 'B', type: 'ORG', mentionCount: 1 },
      },
    ]);
    mockPrisma.graphRelationship.findMany.mockResolvedValue([
      {
        id: 'rel-1',
        sourceEntityId: 'e1',
        targetEntityId: 'e2',
        type: 'WORKS_AT',
        weight: 0.95,
        createdAt: new Date(),
      },
    ]);
    mockPrisma.memoryChainLink.findMany.mockResolvedValue([]);

    const result = await service.getGraphData('user-1');

    const relEdge = result.edges.find((e) => e.linkType === 'WORKS_AT');
    expect(relEdge).toBeDefined();
    expect(relEdge!.confidence).toBe(0.95);
  });

  it('should include agent memories when includeAgent is true', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      agentId: 'agent-1',
    });
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'agent-user-1' });
    mockPrisma.memory.findMany.mockResolvedValue([
      baseMemory('m1', { userId: 'user-1' }),
      baseMemory('m2', { userId: 'agent-user-1' }),
    ]);
    mockPrisma.graphEntityMention.findMany.mockResolvedValue([]);
    mockPrisma.graphRelationship.findMany.mockResolvedValue([]);
    mockPrisma.memoryChainLink.findMany.mockResolvedValue([]);

    const result = await service.getGraphData('user-1', 500, true);

    expect(result.stats).toEqual({ human: 1, agent: 1 });
    expect(result.nodes.find((n) => n.memorySource === 'agent')).toBeDefined();
  });

  it('should not include stats when includeAgent is false', async () => {
    mockPrisma.memory.findMany.mockResolvedValue([baseMemory('m1')]);
    mockPrisma.graphEntityMention.findMany.mockResolvedValue([]);
    mockPrisma.memoryChainLink.findMany.mockResolvedValue([]);

    const result = await service.getGraphData('user-1', 500, false);

    expect(result.stats).toBeUndefined();
  });

  it('should cap shared-entity edges at 10 memories per entity', async () => {
    // Create 12 memories all sharing an entity
    const memories = Array.from({ length: 12 }, (_, i) => baseMemory(`m${i}`));
    mockPrisma.memory.findMany.mockResolvedValue(memories);

    const mentions = memories.map((m) => ({
      memoryId: m.id,
      entity: { id: 'e1', name: 'Thing', type: 'CONCEPT', mentionCount: 12 },
    }));
    mockPrisma.graphEntityMention.findMany.mockResolvedValue(mentions);
    mockPrisma.graphRelationship.findMany.mockResolvedValue([]);
    mockPrisma.memoryChainLink.findMany.mockResolvedValue([]);

    const result = await service.getGraphData('user-1');

    // 10 choose 2 = 45 max edges
    expect(result.edges.length).toBeLessThanOrEqual(45);
  });

  it('should handle extraction data in nodes', async () => {
    const mem = baseMemory('m1', {
      extraction: {
        who: 'Beaux',
        what: 'drinks coffee',
        when: new Date('2026-01-01'),
        whereCtx: 'home',
        why: 'needs caffeine',
        how: 'drip',
        topics: ['coffee'],
        memoryType: 'PREFERENCE',
      },
    });
    mockPrisma.memory.findMany.mockResolvedValue([mem]);
    mockPrisma.graphEntityMention.findMany.mockResolvedValue([]);
    mockPrisma.memoryChainLink.findMany.mockResolvedValue([]);

    const result = await service.getGraphData('user-1');

    expect(result.nodes[0].extraction).toEqual({
      who: 'Beaux',
      what: 'drinks coffee',
      when: '2026-01-01T00:00:00.000Z',
      where: 'home',
      why: 'needs caffeine',
      how: 'drip',
      topics: ['coffee'],
      memoryType: 'PREFERENCE',
    });
  });

  it('should respect the limit parameter', async () => {
    mockPrisma.memory.findMany.mockResolvedValue([baseMemory('m1')]);
    mockPrisma.graphEntityMention.findMany.mockResolvedValue([]);
    mockPrisma.memoryChainLink.findMany.mockResolvedValue([]);

    await service.getGraphData('user-1', 10);

    expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    );
  });
});
