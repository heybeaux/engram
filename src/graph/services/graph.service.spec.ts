import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GraphService } from './graph.service';
import { EntityService } from './entity.service';
import { RelationshipService } from './relationship.service';
import { GraphExtractionService } from './graph-extraction.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GraphEntityType, GraphRelationshipType } from '@prisma/client';

describe('GraphService', () => {
  let service: GraphService;
  let entityService: EntityService;
  let relationshipService: RelationshipService;
  let extractionService: GraphExtractionService;
  let prisma: PrismaService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'GRAPH_ENABLED') return 'true';
      return null;
    }),
  };

  const mockEntityService = {
    findById: jest.fn(),
    findByNameOrAlias: jest.fn(),
    getWithRelationships: jest.fn(),
    list: jest.fn(),
    findByName: jest.fn(),
    findByAlias: jest.fn(),
    getStats: jest.fn(),
    getTopEntities: jest.fn(),
  };

  const mockRelationshipService = {
    findById: jest.fn(),
    traverse: jest.fn(),
    findPath: jest.fn(),
  };

  const mockExtractionService = {
    processMemory: jest.fn(),
    isEnabled: jest.fn().mockReturnValue(true),
  };

  const mockPrismaService = {
    graphEntityMention: {
      findMany: jest.fn(),
    },
    graphRelationship: {
      findMany: jest.fn(),
    },
    graphEntity: {
      findMany: jest.fn(),
    },
    memory: {
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: EntityService, useValue: mockEntityService },
        { provide: RelationshipService, useValue: mockRelationshipService },
        { provide: GraphExtractionService, useValue: mockExtractionService },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<GraphService>(GraphService);
    entityService = module.get<EntityService>(EntityService);
    relationshipService = module.get<RelationshipService>(RelationshipService);
    extractionService = module.get<GraphExtractionService>(
      GraphExtractionService,
    );
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('isEnabled', () => {
    it('should return true when GRAPH_ENABLED is true', () => {
      expect(service.isEnabled()).toBe(true);
    });
  });

  it('excludes hidden memories from direct entity lookup', async () => {
    mockPrismaService.graphEntityMention.findMany.mockImplementation(
      async ({ where }: any) => {
        expect(where.memory.userHidden).toBe(false);
        return [];
      },
    );
    expect(await service.getMemoriesForEntity('entity-1')).toEqual([]);
  });

  describe('getEntityProfile', () => {
    it('should get entity profile with relationships and memories', async () => {
      const mockEntity = {
        id: 'entity-1',
        userId: 'user-1',
        name: 'Beaux',
        type: GraphEntityType.PERSON,
        aliases: [],
        description: null,
        metadata: {},
        mentionCount: 10,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockEntityWithRels = {
        entity: mockEntity,
        outgoingRelationships: [
          {
            id: 'rel-1',
            type: 'SPOUSE_OF',
            weight: 1.0,
            target: { id: 'e2', name: 'Deanna', type: 'PERSON' },
          },
        ],
        incomingRelationships: [],
      };

      mockEntityService.findById.mockResolvedValue(mockEntity);
      mockEntityService.getWithRelationships.mockResolvedValue(
        mockEntityWithRels,
      );

      const mockMentions = [
        { memory: { id: 'mem-1', raw: 'Beaux is awesome' } },
      ];
      mockPrismaService.graphEntityMention.findMany.mockResolvedValue(
        mockMentions,
      );

      const result = await service.getEntityProfile('user-1', 'entity-1');

      expect(result).not.toBeNull();
      expect(result!.entity).toEqual(mockEntityWithRels);
      expect(result!.recentMemories).toHaveLength(1);
      expect(
        mockPrismaService.graphEntityMention.findMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            memory: { userHidden: false, deletedAt: null },
          }),
        }),
      );
    });

    it('should find entity by name if not found by ID', async () => {
      const mockEntity = {
        id: 'entity-1',
        name: 'Beaux',
        type: GraphEntityType.PERSON,
      };

      mockEntityService.findById.mockResolvedValue(null);
      mockEntityService.findByNameOrAlias.mockResolvedValue(mockEntity);
      mockEntityService.getWithRelationships.mockResolvedValue({
        entity: mockEntity,
        outgoingRelationships: [],
        incomingRelationships: [],
      });
      mockPrismaService.graphEntityMention.findMany.mockResolvedValue([]);

      const result = await service.getEntityProfile('user-1', 'Beaux');

      expect(result).not.toBeNull();
      expect(mockEntityService.findByNameOrAlias).toHaveBeenCalledWith(
        'user-1',
        'Beaux',
      );
    });

    it('should return null if entity not found', async () => {
      mockEntityService.findById.mockResolvedValue(null);
      mockEntityService.findByNameOrAlias.mockResolvedValue(null);

      const result = await service.getEntityProfile('user-1', 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findPath', () => {
    it('should find path between two entities', async () => {
      const mockEntity1 = {
        id: 'entity-1',
        name: 'Beaux',
        type: GraphEntityType.PERSON,
      };
      const mockEntity2 = {
        id: 'entity-2',
        name: 'Deanna',
        type: GraphEntityType.PERSON,
      };

      mockEntityService.findByNameOrAlias
        .mockResolvedValueOnce(mockEntity1)
        .mockResolvedValueOnce(mockEntity2);

      mockRelationshipService.findPath.mockResolvedValue([
        { entityId: 'entity-1', relationshipId: null },
        { entityId: 'entity-2', relationshipId: 'rel-1' },
      ]);

      mockEntityService.findById
        .mockResolvedValueOnce(mockEntity1)
        .mockResolvedValueOnce(mockEntity2);

      mockRelationshipService.findById.mockResolvedValue({
        id: 'rel-1',
        type: 'SPOUSE_OF',
      });

      const result = await service.findPath('user-1', 'Beaux', 'Deanna');

      expect(result.found).toBe(true);
      expect(result.path).toHaveLength(2);
      expect(result.path[0].entity.name).toBe('Beaux');
      expect(result.path[1].entity.name).toBe('Deanna');
    });

    it('should return not found if entities not found', async () => {
      mockEntityService.findByNameOrAlias.mockResolvedValue(null);

      const result = await service.findPath('user-1', 'Beaux', 'Unknown');

      expect(result.found).toBe(false);
      expect(result.path).toHaveLength(0);
    });

    it('should return not found if no path exists', async () => {
      mockEntityService.findByNameOrAlias
        .mockResolvedValueOnce({ id: 'entity-1' })
        .mockResolvedValueOnce({ id: 'entity-99' });

      mockRelationshipService.findPath.mockResolvedValue([]);

      const result = await service.findPath('user-1', 'Beaux', 'Disconnected');

      expect(result.found).toBe(false);
    });
  });

  describe('findByRelationship', () => {
    it('should find entities by relationship type to target', async () => {
      const mockTarget = { id: 'entity-2', name: 'Powell River' };
      mockEntityService.findByNameOrAlias.mockResolvedValue(mockTarget);

      const mockRelationships = [
        { sourceEntity: { id: 'entity-1', name: 'Beaux' } },
        { sourceEntity: { id: 'entity-3', name: 'Deanna' } },
      ];
      mockPrismaService.graphRelationship.findMany.mockResolvedValue(
        mockRelationships,
      );

      const result = await service.findByRelationship(
        'user-1',
        'LIVES_IN',
        'Powell River',
      );

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Beaux');
      expect(result[1].name).toBe('Deanna');
    });

    it('should return empty array if target not found', async () => {
      mockEntityService.findByNameOrAlias.mockResolvedValue(null);

      const result = await service.findByRelationship(
        'user-1',
        'LIVES_IN',
        'Unknown',
      );

      expect(result).toEqual([]);
    });
  });

  describe('searchEntities', () => {
    it('should search entities and return with match type', async () => {
      const mockExactMatch = {
        id: 'entity-1',
        name: 'Beaux',
        type: GraphEntityType.PERSON,
      };

      mockEntityService.findByName.mockResolvedValue(mockExactMatch);
      mockEntityService.findByAlias.mockResolvedValue(null);
      mockEntityService.list.mockResolvedValue({ entities: [], total: 0 });

      const result = await service.searchEntities('user-1', 'Beaux');

      expect(result).toHaveLength(1);
      expect(result[0].matchType).toBe('exact');
    });

    it('should include alias matches', async () => {
      mockEntityService.findByName.mockResolvedValue(null);
      mockEntityService.findByAlias.mockResolvedValue({
        id: 'entity-1',
        name: 'Beaux Walton',
      });
      mockEntityService.list.mockResolvedValue({ entities: [], total: 0 });

      const result = await service.searchEntities('user-1', 'BW');

      expect(result).toHaveLength(1);
      expect(result[0].matchType).toBe('alias');
    });

    it('should include description matches', async () => {
      mockEntityService.findByName.mockResolvedValue(null);
      mockEntityService.findByAlias.mockResolvedValue(null);
      mockEntityService.list.mockResolvedValue({
        entities: [{ id: 'entity-1', name: 'Powell River' }],
        total: 1,
      });

      const result = await service.searchEntities('user-1', 'river');

      expect(result).toHaveLength(1);
      expect(result[0].matchType).toBe('description');
    });
  });

  describe('getStats', () => {
    it('should return graph statistics', async () => {
      mockEntityService.getStats.mockResolvedValue({
        totalEntities: 10,
        byType: { PERSON: 5, PLACE: 3, ORGANIZATION: 2 },
        totalRelationships: 25,
        totalMentions: 50,
      });

      mockEntityService.getTopEntities.mockResolvedValue([
        { name: 'Beaux', type: 'PERSON', mentionCount: 20 },
        { name: 'Powell River', type: 'PLACE', mentionCount: 15 },
      ]);

      const result = await service.getStats('user-1');

      expect(result.enabled).toBe(true);
      expect(result.totalEntities).toBe(10);
      expect(result.topEntities).toHaveLength(2);
    });
  });

  describe('backfill', () => {
    it('should process memories without graph data', async () => {
      const mockMemories = [
        { id: 'mem-1', raw: 'Test memory 1' },
        { id: 'mem-2', raw: 'Test memory 2' },
      ];

      mockPrismaService.memory.findMany.mockResolvedValue(mockMemories);
      mockExtractionService.processMemory
        .mockResolvedValueOnce({ entitiesCreated: 1, entitiesUpdated: 0 })
        .mockResolvedValueOnce({ entitiesCreated: 0, entitiesUpdated: 0 });

      const result = await service.backfill('user-1', { limit: 10 });

      expect(result.processed).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('should handle extraction failures gracefully', async () => {
      mockPrismaService.memory.findMany.mockResolvedValue([
        { id: 'mem-1', raw: 'Test memory' },
      ]);
      mockExtractionService.processMemory.mockRejectedValue(
        new Error('Extraction failed'),
      );

      const result = await service.backfill('user-1');

      expect(result.failed).toBe(1);
    });
  });
});
