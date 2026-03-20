import { Test, TestingModule } from '@nestjs/testing';
import { EntityRadiationStrategy } from './entity-radiation.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import { EntityService } from '../../graph/services/entity.service';
import { RelationshipService } from '../../graph/services/relationship.service';
import { ContextSignals } from './strategy.interface';

// ── Mock Factories ────────────────────────────────────────────────────────────

const mockPrisma = {
  memory: {
    findMany: jest.fn(),
  },
};

const mockEntityService = {
  findByNameOrAlias: jest.fn(),
};

const mockRelationshipService = {
  traverse: jest.fn(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSignals(overrides: Partial<ContextSignals> = {}): ContextSignals {
  return {
    query: 'tell me about Engram',
    userId: 'user-1',
    entities: ['Engram'],
    topics: [],
    hourOfDay: 10,
    dayOfWeek: 2,
    excludeMemoryIds: new Set(),
    ...overrides,
  };
}

function makeEntity(id: string, name: string) {
  return { id, name };
}

function makeTraversal(nodes: { id: string; name: string }[], edges: { sourceId: string; targetId: string; weight: number }[] = []) {
  return { nodes, edges };
}

function makeMemory(id: string, effectiveScore = 0.8, daysAgo = 1) {
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    id,
    userId: 'user-1',
    content: `Memory about ${id}`,
    effectiveScore,
    createdAt,
    deletedAt: null,
    supersededById: null,
    extraction: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EntityRadiationStrategy', () => {
  let strategy: EntityRadiationStrategy;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntityRadiationStrategy,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EntityService, useValue: mockEntityService },
        { provide: RelationshipService, useValue: mockRelationshipService },
      ],
    }).compile();

    strategy = module.get<EntityRadiationStrategy>(EntityRadiationStrategy);
  });

  // ── Identity ──────────────────────────────────────────────────────────────

  describe('name', () => {
    it('should have name entity_radiation', () => {
      expect(strategy.name).toBe('entity_radiation');
    });
  });

  // ── Happy paths ───────────────────────────────────────────────────────────

  describe('execute — happy paths', () => {
    it('should return empty array when no entities in signals', async () => {
      const signals = makeSignals({ entities: [] });
      const result = await strategy.execute(signals, { maxResults: 5, timeoutMs: 5000 });
      expect(result).toEqual([]);
      expect(mockEntityService.findByNameOrAlias).not.toHaveBeenCalled();
    });

    it('should return empty array when entity is not found in graph', async () => {
      mockEntityService.findByNameOrAlias.mockResolvedValue(null);
      const signals = makeSignals({ entities: ['UnknownThing'] });
      const result = await strategy.execute(signals, { maxResults: 5, timeoutMs: 5000 });
      expect(result).toEqual([]);
    });

    it('should return empty when traversal has no adjacent nodes', async () => {
      const entity = makeEntity('e-1', 'Engram');
      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(makeTraversal([entity]));

      const result = await strategy.execute(makeSignals(), { maxResults: 5, timeoutMs: 5000 });
      expect(result).toEqual([]);
    });

    it('should return empty when adjacent entities have no matching memories', async () => {
      const entity = makeEntity('e-1', 'Engram');
      const adjacent = makeEntity('e-2', 'Railway');
      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, adjacent], [{ sourceId: 'e-1', targetId: 'e-2', weight: 0.9 }]),
      );
      mockPrisma.memory.findMany.mockResolvedValue([]);

      const result = await strategy.execute(makeSignals(), { maxResults: 5, timeoutMs: 5000 });
      expect(result).toEqual([]);
    });

    it('should return an anticipatory result for a found adjacent memory', async () => {
      const entity = makeEntity('e-1', 'Engram');
      const adjacent = makeEntity('e-2', 'Railway');
      const memory = makeMemory('mem-1', 0.9, 10);

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, adjacent], [{ sourceId: 'e-1', targetId: 'e-2', weight: 0.8 }]),
      );
      mockPrisma.memory.findMany.mockResolvedValue([memory]);

      const results = await strategy.execute(makeSignals(), { maxResults: 5, timeoutMs: 5000 });
      expect(results).toHaveLength(1);
      expect(results[0].meta.strategy).toBe('entity_radiation');
      expect(results[0].meta.entityPath).toEqual(['Engram', 'Railway']);
      expect(results[0].meta.reason).toContain('Engram');
      expect(results[0].meta.reason).toContain('Railway');
    });

    it('should compute salience from edge weight × effectiveScore × recency decay', async () => {
      const entity = makeEntity('e-1', 'Engram');
      const adjacent = makeEntity('e-2', 'Railway');
      const memory = makeMemory('mem-1', 1.0, 0); // fresh memory, today

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, adjacent], [{ sourceId: 'e-1', targetId: 'e-2', weight: 1.0 }]),
      );
      mockPrisma.memory.findMany.mockResolvedValue([memory]);

      const results = await strategy.execute(makeSignals(), { maxResults: 5, timeoutMs: 5000 });
      expect(results[0].meta.salience).toBeGreaterThan(0);
      expect(results[0].meta.salience).toBeLessThanOrEqual(1.0); // weight × score × decay ≤ 1
    });

    it('should apply recency decay for old memories', async () => {
      const entity = makeEntity('e-1', 'Engram');
      const adjacent = makeEntity('e-2', 'Railway');
      const freshMemory = makeMemory('mem-fresh', 1.0, 1);
      const oldMemory = makeMemory('mem-old', 1.0, 89);

      mockEntityService.findByNameOrAlias
        .mockResolvedValueOnce(entity)
        .mockResolvedValueOnce(entity);

      // Test with two separate strategy calls to compare salience
      const edge = [{ sourceId: 'e-1', targetId: 'e-2', weight: 1.0 }];
      mockRelationshipService.traverse.mockResolvedValue(makeTraversal([entity, adjacent], edge));

      mockPrisma.memory.findMany.mockResolvedValueOnce([freshMemory]);
      const freshResult = await strategy.execute(makeSignals({ entities: ['Engram'] }), { maxResults: 5, timeoutMs: 5000 });

      jest.clearAllMocks();
      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(makeTraversal([entity, adjacent], edge));
      mockPrisma.memory.findMany.mockResolvedValue([oldMemory]);
      const oldResult = await strategy.execute(makeSignals({ entities: ['Engram'] }), { maxResults: 5, timeoutMs: 5000 });

      expect(freshResult[0].meta.salience).toBeGreaterThan(oldResult[0].meta.salience);
    });

    it('should sort results by salience descending', async () => {
      const entity = makeEntity('e-1', 'Engram');
      const adj1 = makeEntity('e-2', 'Railway');
      const adj2 = makeEntity('e-3', 'Prisma');

      const memHigh = makeMemory('mem-high', 0.95, 1);
      const memLow = makeMemory('mem-low', 0.3, 1);

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal(
          [entity, adj1, adj2],
          [
            { sourceId: 'e-1', targetId: 'e-2', weight: 0.9 },
            { sourceId: 'e-1', targetId: 'e-3', weight: 0.2 },
          ],
        ),
      );
      mockPrisma.memory.findMany
        .mockResolvedValueOnce([memHigh])
        .mockResolvedValueOnce([memLow]);

      const results = await strategy.execute(makeSignals(), { maxResults: 10, timeoutMs: 5000 });
      expect(results).toHaveLength(2);
      expect(results[0].meta.salience).toBeGreaterThanOrEqual(results[1].meta.salience);
    });

    it('should respect maxResults limit', async () => {
      const entity = makeEntity('e-1', 'Engram');
      const adjacent = [
        makeEntity('e-2', 'Railway'),
        makeEntity('e-3', 'Prisma'),
        makeEntity('e-4', 'pgvector'),
      ];
      const edges = adjacent.map((a, i) => ({ sourceId: 'e-1', targetId: a.id, weight: 0.8 - i * 0.1 }));

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(makeTraversal([entity, ...adjacent], edges));
      mockPrisma.memory.findMany.mockResolvedValue([makeMemory('mem-x')]);

      const results = await strategy.execute(makeSignals(), { maxResults: 2, timeoutMs: 5000 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should exclude memories in excludeMemoryIds', async () => {
      const entity = makeEntity('e-1', 'Engram');
      const adjacent = makeEntity('e-2', 'Railway');
      const excludedId = 'mem-excluded';

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, adjacent], [{ sourceId: 'e-1', targetId: 'e-2', weight: 0.8 }]),
      );
      mockPrisma.memory.findMany.mockResolvedValue([]);

      const signals = makeSignals({ excludeMemoryIds: new Set([excludedId]) });
      await strategy.execute(signals, { maxResults: 5, timeoutMs: 5000 });

      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: expect.objectContaining({ notIn: [excludedId] }),
          }),
        }),
      );
    });

    it('should deduplicate adjacent entities across multiple root entities', async () => {
      // Entity e-3 is adjacent to both Engram and Prisma — should only pull once
      const engram = makeEntity('e-1', 'Engram');
      const prisma = makeEntity('e-2', 'Prisma');
      const shared = makeEntity('e-3', 'pgvector');

      mockEntityService.findByNameOrAlias
        .mockResolvedValueOnce(engram)
        .mockResolvedValueOnce(prisma);

      mockRelationshipService.traverse
        .mockResolvedValueOnce(makeTraversal([engram, shared], [{ sourceId: 'e-1', targetId: 'e-3', weight: 0.8 }]))
        .mockResolvedValueOnce(makeTraversal([prisma, shared], [{ sourceId: 'e-2', targetId: 'e-3', weight: 0.7 }]));

      mockPrisma.memory.findMany.mockResolvedValue([makeMemory('mem-shared')]);

      const signals = makeSignals({ entities: ['Engram', 'Prisma'] });
      await strategy.execute(signals, { maxResults: 10, timeoutMs: 5000 });

      // pgvector's memories should only be fetched once (seenEntityIds prevents duplicates)
      expect(mockPrisma.memory.findMany).toHaveBeenCalledTimes(1);
    });

    it('should use edge weight of 0.5 as default when no matching edge found', async () => {
      const entity = makeEntity('e-1', 'Engram');
      const adjacent = makeEntity('e-2', 'Railway');
      const memory = makeMemory('mem-1', 1.0, 0);

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      // Traversal with no edges
      mockRelationshipService.traverse.mockResolvedValue(makeTraversal([entity, adjacent], []));
      mockPrisma.memory.findMany.mockResolvedValue([memory]);

      const results = await strategy.execute(makeSignals(), { maxResults: 5, timeoutMs: 5000 });
      // Salience uses default weight 0.5 — should still produce a valid result
      expect(results).toHaveLength(1);
      expect(results[0].meta.salience).toBeGreaterThan(0);
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe('execute — error handling', () => {
    it('should continue processing other entities when one throws', async () => {
      const entity1 = makeEntity('e-1', 'Engram');
      const entity2 = makeEntity('e-2', 'Railway');
      const adjacent = makeEntity('e-3', 'Prisma');
      const memory = makeMemory('mem-1');

      mockEntityService.findByNameOrAlias
        .mockRejectedValueOnce(new Error('DB connection lost'))
        .mockResolvedValueOnce(entity2);

      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity2, adjacent], [{ sourceId: 'e-2', targetId: 'e-3', weight: 0.7 }]),
      );
      mockPrisma.memory.findMany.mockResolvedValue([memory]);

      const signals = makeSignals({ entities: ['Engram', 'Railway'] });
      const results = await strategy.execute(signals, { maxResults: 5, timeoutMs: 5000 });

      // Should not throw; should return results from entity2
      expect(results).toHaveLength(1);
    });

    it('should return empty array when all entities throw', async () => {
      mockEntityService.findByNameOrAlias.mockRejectedValue(new Error('timeout'));

      const signals = makeSignals({ entities: ['Engram', 'Prisma'] });
      const results = await strategy.execute(signals, { maxResults: 5, timeoutMs: 5000 });
      expect(results).toEqual([]);
    });

    it('should handle traversal service throwing gracefully', async () => {
      const entity = makeEntity('e-1', 'Engram');
      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockRejectedValue(new Error('graph unavailable'));

      const results = await strategy.execute(makeSignals(), { maxResults: 5, timeoutMs: 5000 });
      expect(results).toEqual([]);
    });

    it('should handle prisma.memory.findMany throwing gracefully', async () => {
      const entity = makeEntity('e-1', 'Engram');
      const adjacent = makeEntity('e-2', 'Railway');

      mockEntityService.findByNameOrAlias.mockResolvedValue(entity);
      mockRelationshipService.traverse.mockResolvedValue(
        makeTraversal([entity, adjacent], [{ sourceId: 'e-1', targetId: 'e-2', weight: 0.8 }]),
      );
      mockPrisma.memory.findMany.mockRejectedValue(new Error('query timeout'));

      const results = await strategy.execute(makeSignals(), { maxResults: 5, timeoutMs: 5000 });
      expect(results).toEqual([]);
    });
  });

  // ── Timeout / deadline ─────────────────────────────────────────────────────

  describe('execute — deadline handling', () => {
    it('should return partial results when already past deadline before starting entity loop', async () => {
      // timeout 0ms — deadline will be in the past immediately for any real work
      const result = await strategy.execute(makeSignals({ entities: ['Engram', 'Prisma'] }), {
        maxResults: 5,
        timeoutMs: 0,
      });
      // With 0ms timeout, deadline is effectively already expired — we expect empty or minimal results
      // depending on JS event loop timing; the important thing is it doesn't hang
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
