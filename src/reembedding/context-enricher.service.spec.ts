import { Test, TestingModule } from '@nestjs/testing';
import {
  ContextEnricherService,
  MemoryWithRelations,
} from './context-enricher.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryLayer, MemorySource, SubjectType } from '@prisma/client';

describe('ContextEnricherService', () => {
  let service: ContextEnricherService;
  let prisma: jest.Mocked<PrismaService>;

  const mockPrisma = {
    memoryEntity: {
      findMany: jest.fn(),
    },
    memoryExtraction: {
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContextEnricherService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ContextEnricherService>(ContextEnricherService);
    prisma = module.get(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('ENRICHMENT_VERSION', () => {
    it('should have a version string', () => {
      expect(ContextEnricherService.ENRICHMENT_VERSION).toBe('1.0.0');
    });
  });

  describe('enrich', () => {
    const createMockMemory = (
      overrides: Partial<MemoryWithRelations> = {},
    ): MemoryWithRelations => ({
      id: 'mem_123',
      userId: 'user_123',
      raw: 'Test memory content',
      layer: MemoryLayer.IDENTITY,
      source: MemorySource.EXPLICIT_STATEMENT,
      importanceScore: 0.5,
      effectiveScore: 0.5,
      safetyCritical: false,
      createdAt: new Date('2025-10-15T10:00:00Z'),
      updatedAt: new Date('2025-10-15T10:00:00Z'),
      deletedAt: null,
      projectId: null,
      sessionId: null,
      memoryType: null,
      typeConfidence: null,
      priority: 3,
      promotedFrom: null,
      userPinned: false,
      userHidden: false,
      scoreComputedAt: null,
      subjectType: SubjectType.USER,
      subjectId: null,
      agentId: null,
      importanceHint: null,
      confidence: 1.0,
      sessionPosition: null,
      embeddingId: null,
      embeddingModel: null,
      retrievalCount: 0,
      lastRetrievedAt: null,
      usedCount: 0,
      lastUsedAt: null,
      consolidated: false,
      consolidatedAt: null,
      supersededById: null,
      supersededAt: null,
      consolidatedInto: null,
      version: 0,
      archivedReason: null,
      clusterId: null,
      embeddingStatus: 'PENDING' as any,
      visibility: 'PRIVATE' as any,
      createdBySession: null,
      lastDreamCycleAt: null,
      patternSourceIds: [],
      cloudSyncedAt: null,
      contentHash: null,
      metadata: null,
      extraction: null,
      entities: [],
      ...overrides,
    });

    it('should enrich a basic memory with temporal context', async () => {
      const memory = createMockMemory();
      mockPrisma.memoryEntity.findMany.mockResolvedValue([]);

      const result = await service.enrich(memory);

      expect(result.originalContent).toBe('Test memory content');
      expect(result.enrichedContent).toContain('[Time:');
      expect(result.enrichedContent).toContain('October 15, 2025');
      expect(result.enrichedContent).toContain('Test memory content');
      expect(result.metadata.temporalContext).toBeDefined();
      expect(result.metadata.enrichmentVersion).toBe('1.0.0');
    });

    it('should add entity context when entities are present', async () => {
      const memory = createMockMemory({
        entities: [
          {
            id: 'me_1',
            memoryId: 'mem_123',
            entityId: 'ent_1',
            entity: {
              id: 'ent_1',
              userId: 'user_123',
              name: 'Stella',
              type: 'PERSON',
              normalizedName: 'stella',
              createdAt: new Date(),
              updatedAt: new Date(),
            } as any,
          },
          {
            id: 'me_2',
            memoryId: 'mem_123',
            entityId: 'ent_2',
            entity: {
              id: 'ent_2',
              userId: 'user_123',
              name: 'Kindergarten',
              type: 'PLACE',
              normalizedName: 'kindergarten',
              createdAt: new Date(),
              updatedAt: new Date(),
            } as any,
          },
        ],
      });

      const result = await service.enrich(memory);

      expect(result.enrichedContent).toContain('[About: Stella, Kindergarten]');
      expect(result.metadata.entityContext).toBe(
        '[About: Stella, Kindergarten]',
      );
    });

    it('should fetch entities when not preloaded', async () => {
      const memory = createMockMemory();
      mockPrisma.memoryEntity.findMany.mockResolvedValue([
        {
          id: 'me_1',
          memoryId: 'mem_123',
          entityId: 'ent_1',
          entity: {
            id: 'ent_1',
            userId: 'user_123',
            name: 'Deanna',
            type: 'PERSON',
            normalizedName: 'deanna',
          },
        },
      ]);

      const result = await service.enrich(memory);

      expect(mockPrisma.memoryEntity.findMany).toHaveBeenCalledWith({
        where: { memoryId: 'mem_123' },
        include: { entity: true },
        take: 5,
      });
      expect(result.enrichedContent).toContain('[About: Deanna]');
    });

    it('should limit entities to 5', async () => {
      const entities = Array.from({ length: 7 }, (_, i) => ({
        id: `me_${i}`,
        memoryId: 'mem_123',
        entityId: `ent_${i}`,
        entity: {
          id: `ent_${i}`,
          userId: 'user_123',
          name: `Entity${i}`,
          type: 'CONCEPT',
          normalizedName: `entity${i}`,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      }));

      const memory = createMockMemory({ entities });
      const result = await service.enrich(memory);

      // Should only include first 5 entities
      expect(result.metadata.entityContext).toBe(
        '[About: Entity0, Entity1, Entity2, Entity3, Entity4]',
      );
    });

    it('should add high importance context for high-scoring memories', async () => {
      const memory = createMockMemory({
        effectiveScore: 0.8,
      });
      mockPrisma.memoryEntity.findMany.mockResolvedValue([]);

      const result = await service.enrich(memory);

      expect(result.enrichedContent).toContain('[High importance]');
      expect(result.metadata.importanceContext).toBe('[High importance]');
    });

    it('should add critical importance context for critical memories', async () => {
      const memory = createMockMemory({
        effectiveScore: 0.95,
      });
      mockPrisma.memoryEntity.findMany.mockResolvedValue([]);

      const result = await service.enrich(memory);

      expect(result.enrichedContent).toContain('[Critical importance]');
      expect(result.metadata.importanceContext).toBe('[Critical importance]');
    });

    it('should add critical importance for safety-critical memories', async () => {
      const memory = createMockMemory({
        effectiveScore: 0.3,
        safetyCritical: true,
      });
      mockPrisma.memoryEntity.findMany.mockResolvedValue([]);

      const result = await service.enrich(memory);

      expect(result.enrichedContent).toContain('[Critical importance]');
    });

    it('should not add importance context for normal memories', async () => {
      const memory = createMockMemory({
        effectiveScore: 0.5,
      });
      mockPrisma.memoryEntity.findMany.mockResolvedValue([]);

      const result = await service.enrich(memory);

      expect(result.enrichedContent).not.toContain('[High importance]');
      expect(result.enrichedContent).not.toContain('[Critical importance]');
      expect(result.metadata.importanceContext).toBeUndefined();
    });

    it('should combine all context types correctly', async () => {
      const memory = createMockMemory({
        effectiveScore: 0.8,
        entities: [
          {
            id: 'me_1',
            memoryId: 'mem_123',
            entityId: 'ent_1',
            entity: {
              id: 'ent_1',
              userId: 'user_123',
              name: 'Beaux',
              type: 'PERSON',
              normalizedName: 'beaux',
              createdAt: new Date(),
              updatedAt: new Date(),
            } as any,
          },
        ],
      });

      const result = await service.enrich(memory);

      // Check order: temporal, entity, importance
      const lines = result.enrichedContent.split('\n');
      const prefixLine = lines[0];

      expect(prefixLine).toContain('[Time:');
      expect(prefixLine).toContain('[About: Beaux]');
      expect(prefixLine).toContain('[High importance]');

      // Original content should be after prefix
      expect(result.enrichedContent).toContain('Test memory content');
    });

    it('should use importanceScore when effectiveScore is null', async () => {
      const memory = createMockMemory({
        effectiveScore: null as any,
        importanceScore: 0.85,
      });
      mockPrisma.memoryEntity.findMany.mockResolvedValue([]);

      const result = await service.enrich(memory);

      expect(result.enrichedContent).toContain('[High importance]');
    });
  });

  describe('getMemoriesForEnrichment', () => {
    const mockMemory = {
      id: 'mem_123',
      raw: 'Test',
      createdAt: new Date('2025-01-01'),
    };

    beforeEach(() => {
      // Mock the prisma.memory.findMany method
      (prisma as any).memory = {
        findMany: jest.fn().mockResolvedValue([mockMemory]),
        findUnique: jest.fn().mockResolvedValue(mockMemory),
      };
    });

    it('should fetch memories without filters', async () => {
      await service.getMemoriesForEnrichment();

      expect((prisma as any).memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null },
          take: 100,
        }),
      );
    });

    it('should filter by userId when specified', async () => {
      await service.getMemoriesForEnrichment({ userId: 'user_123' });

      expect((prisma as any).memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, userId: 'user_123' },
        }),
      );
    });

    it('should filter by staleDays when specified', async () => {
      await service.getMemoriesForEnrichment({ staleDays: 30 });

      const call = (prisma as any).memory.findMany.mock.calls[0][0];
      expect(call.where.createdAt).toBeDefined();
      expect(call.where.createdAt.lt).toBeInstanceOf(Date);
    });

    it('should respect limit parameter', async () => {
      await service.getMemoriesForEnrichment({ limit: 50 });

      expect((prisma as any).memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 50,
        }),
      );
    });
  });
});
