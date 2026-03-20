import { GraphRecallService } from './graph-recall.service';
import { ConfigService } from '@nestjs/config';
import { GraphService } from '../graph/services/graph.service';

describe('GraphRecallService', () => {
  let service: GraphRecallService;
  let graphService: jest.Mocked<GraphService>;
  let configService: jest.Mocked<ConfigService>;

  const userId = 'user-123';

  const makeMockMemory = (id: string) => ({
    id,
    userId,
    raw: `Memory ${id}`,
    layer: 'SESSION',
    createdAt: new Date(),
    updatedAt: new Date(),
    importanceScore: 0.5,
    effectiveScore: 0.5,
    confidence: 0.8,
    priority: 5,
    userPinned: false,
    userHidden: false,
    safetyCritical: false,
    deletedAt: null,
    supersededById: null,
    subjectType: 'USER',
    visibility: 'PRIVATE',
    projectId: null,
    agentId: null,
    sessionId: null,
    source: null,
    retrievalCount: 0,
    usedCount: 0,
    lastRetrievedAt: null,
    lastUsedAt: null,
    embedding: null,
    contentHash: null,
    chainId: null,
    durability: null,
    durabilityScore: null,
  });

  beforeEach(() => {
    jest.clearAllMocks();

    graphService = {
      searchEntities: jest.fn().mockResolvedValue([]),
      getMemoriesForEntity: jest.fn().mockResolvedValue([]),
      getRelatedEntities: jest.fn().mockResolvedValue([]),
    } as any;

    configService = {
      get: jest.fn().mockReturnValue('true'),
    } as any;

    service = new GraphRecallService(configService, graphService);
  });

  describe('extractEntities', () => {
    it('should extract capitalized words not at sentence start', () => {
      const result = service.extractEntities(
        'What does Alice think about Bob?',
      );
      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
    });

    it('should extract "my X" possessive pattern', () => {
      const result = service.extractEntities('Tell me about my dog Kali');
      expect(result).toContain('dog');
      expect(result).toContain('Kali');
    });

    it('should return empty for empty/short query', () => {
      expect(service.extractEntities('')).toEqual([]);
      expect(service.extractEntities('a')).toEqual([]);
      expect(service.extractEntities('  ')).toEqual([]);
    });

    it('should not extract common stop words', () => {
      const result = service.extractEntities('What is The best way to go');
      // "What" is at sentence start so excluded, "The" is a stop word
      for (const word of result) {
        expect(
          ['the', 'and', 'i', 'what', 'is', 'to', 'go'].includes(
            word.toLowerCase(),
          ),
        ).toBe(false);
      }
    });

    it('should extract quoted terms', () => {
      const result = service.extractEntities(
        'Tell me about "machine learning" and "NLP"',
      );
      expect(result).toContain('machine learning');
      expect(result).toContain('NLP');
    });

    it('should limit to max 5 entities', () => {
      const result = service.extractEntities(
        'I saw Alice with Bob near Charlie and David met Eve with Frank and Grace',
      );
      expect(result.length).toBeLessThanOrEqual(5);
    });

    it('should handle mixed patterns together', () => {
      const result = service.extractEntities(
        'What does Alice think about my coffee at "Blue Bottle"?',
      );
      expect(result).toContain('Alice');
      expect(result).toContain('coffee');
      expect(result).toContain('Blue Bottle');
    });

    it('should not extract single-character words', () => {
      const result = service.extractEntities('I know a lot about my I');
      // "I" is a stop word and single char
      expect(result).not.toContain('I');
    });
  });

  describe('recallViaGraph', () => {
    it('should return [] when GRAPH_RETRIEVAL_ENABLED=false', async () => {
      configService.get.mockReturnValue('false');
      service = new GraphRecallService(configService, graphService);

      const result = await service.recallViaGraph(
        'What does Alice think?',
        userId,
        10,
      );
      expect(result).toEqual([]);
      expect(graphService.searchEntities).not.toHaveBeenCalled();
    });

    it('should return [] when no entities extracted', async () => {
      const result = await service.recallViaGraph('hello world', userId, 10);
      expect(result).toEqual([]);
    });

    it('should return memories for matched graph entities', async () => {
      const mockEntity = { id: 'entity-1', name: 'Alice', userId };
      const mockMemory = makeMockMemory('mem-1');

      graphService.searchEntities.mockResolvedValue([
        { ...mockEntity, matchType: 'exact' } as any,
      ]);
      graphService.getMemoriesForEntity.mockResolvedValue([mockMemory as any]);
      graphService.getRelatedEntities.mockResolvedValue([]);

      const result = await service.recallViaGraph(
        'What does Alice think?',
        userId,
        10,
      );

      expect(result.length).toBe(1);
      expect(result[0].id).toBe('mem-1');
      expect(result[0].score).toBeGreaterThanOrEqual(0.7);
      expect(result[0].recallSource).toBe('graph');
    });

    it('should boost score when multiple entities match the same memory', async () => {
      const mockMemory = makeMockMemory('mem-shared');

      graphService.searchEntities.mockResolvedValue([
        { id: 'entity-1', name: 'Alice', userId, matchType: 'exact' } as any,
      ]);
      graphService.getMemoriesForEntity.mockResolvedValue([
        mockMemory as any,
        mockMemory as any, // simulating duplicate from different entity match
      ]);
      graphService.getRelatedEntities.mockResolvedValue([]);

      const result = await service.recallViaGraph(
        'What does Alice think?',
        userId,
        10,
      );

      // Memory appeared twice, so entityHits=2 → score > 0.7
      expect(result.length).toBe(1);
      expect(result[0].score).toBeGreaterThan(0.7);
    });

    it('should include memories from related entities (1-hop)', async () => {
      const mainEntity = { id: 'entity-1', name: 'Alice', userId };
      const relatedEntity = { id: 'entity-2', name: 'Bob', userId };
      const mainMemory = makeMockMemory('mem-1');
      const relatedMemory = makeMockMemory('mem-2');

      graphService.searchEntities.mockResolvedValue([
        { ...mainEntity, matchType: 'exact' } as any,
      ]);
      graphService.getMemoriesForEntity
        .mockResolvedValueOnce([mainMemory as any]) // direct
        .mockResolvedValueOnce([relatedMemory as any]); // from related entity
      graphService.getRelatedEntities.mockResolvedValue([relatedEntity as any]);

      const result = await service.recallViaGraph(
        'What does Alice think?',
        userId,
        10,
      );

      expect(result.length).toBe(2);
      const ids = result.map((m) => m.id);
      expect(ids).toContain('mem-1');
      expect(ids).toContain('mem-2');
    });

    it('should return [] gracefully when graph service throws', async () => {
      graphService.searchEntities.mockRejectedValue(
        new Error('Graph unavailable'),
      );

      const result = await service.recallViaGraph(
        'What does Alice think?',
        userId,
        10,
      );
      expect(result).toEqual([]);
    });

    it('should respect the limit parameter', async () => {
      const memories = Array.from({ length: 10 }, (_, i) =>
        makeMockMemory(`mem-${i}`),
      );

      graphService.searchEntities.mockResolvedValue([
        { id: 'entity-1', name: 'Alice', userId, matchType: 'exact' } as any,
      ]);
      graphService.getMemoriesForEntity.mockResolvedValue(memories as any[]);
      graphService.getRelatedEntities.mockResolvedValue([]);

      const result = await service.recallViaGraph(
        'What does Alice think?',
        userId,
        3,
      );
      expect(result.length).toBe(3);
    });

    it('should deduplicate memories by id', async () => {
      const sameMemory = makeMockMemory('mem-same');

      graphService.searchEntities.mockResolvedValue([
        { id: 'entity-1', name: 'Alice', userId, matchType: 'exact' } as any,
      ]);
      // Return same memory from direct and related
      graphService.getMemoriesForEntity.mockResolvedValue([sameMemory as any]);
      graphService.getRelatedEntities.mockResolvedValue([
        { id: 'entity-2', name: 'Related', userId } as any,
      ]);

      const result = await service.recallViaGraph(
        'What does Alice think?',
        userId,
        10,
      );

      // Should have only one entry despite appearing multiple times
      const ids = result.map((m) => m.id);
      const uniqueIds = [...new Set(ids)];
      expect(ids.length).toBe(uniqueIds.length);
    });
  });
});
