import { Test, TestingModule } from '@nestjs/testing';
import { AgentRecallService } from './agent-recall.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: { findMany: jest.fn() },
  entityProfile: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  entityProfileMemory: { findMany: jest.fn() },
  memoryEntity: { findMany: jest.fn() },
  graphEntity: { findFirst: jest.fn() },
  graphRelationship: { findMany: jest.fn() },
  $queryRawUnsafe: jest.fn(),
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'acc-1';
const USER_IDS = ['user-1', 'user-2'];

const baseProfile = {
  id: 'profile-1',
  name: 'Alice',
  type: 'PERSON',
  description: 'A developer',
  normalizedName: 'alice',
  entityId: 'entity-1',
  attributes: [
    {
      key: 'role',
      value: 'developer',
      verified: true,
      confidence: 1.0,
      source: 'MANUAL',
    },
    {
      key: 'unconfirmed_note',
      value: 'maybe CTO',
      verified: false,
      confidence: 0.4,
      source: null,
    },
  ],
};

const baseMemory = {
  id: 'mem-1',
  raw: 'Alice is a great developer',
  importanceScore: 0.9,
  source: 'chat',
  ingestedAt: new Date('2026-01-01T00:00:00Z'),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRecallService', () => {
  let service: AgentRecallService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRecallService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<AgentRecallService>(AgentRecallService);
  });

  // =========================================================================
  // resolveAccountUserIds (internal, tested via recallEntity)
  // =========================================================================

  describe('resolveAccountUserIds', () => {
    it('should return [] when account has no users', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      const result = await service.recallEntity(ACCOUNT_ID, 'Alice');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // recallEntity
  // =========================================================================

  describe('recallEntity', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
    });

    it('should return null when no profile matched', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(null);
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
      const result = await service.recallEntity(ACCOUNT_ID, 'Unknown');
      expect(result).toBeNull();
    });

    it('should return a full RecallResult on exact match', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([
        {
          id: 'epm-1',
          profileId: 'profile-1',
          memoryId: 'mem-1',
          relevanceScore: 0.95,
          attachMethod: 'MANUAL',
          createdAt: new Date(),
          memory: baseMemory,
        },
      ]);
      mockPrisma.entityProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        entityId: null,
      });
      mockPrisma.graphEntity.findFirst.mockResolvedValue(null);

      const result = await service.recallEntity(ACCOUNT_ID, 'Alice');

      expect(result).not.toBeNull();
      expect(result!.profile.name).toBe('Alice');
      expect(result!.profile.type).toBe('PERSON');
      expect(result!.profile.attributes).toHaveLength(1); // only verified
      expect(result!.profile.attributes[0].key).toBe('role');
      expect(result!.unverifiedAttributes).toHaveLength(1);
      expect(result!.unverifiedAttributes[0].key).toBe('unconfirmed_note');
      expect(result!.memories).toHaveLength(1);
      expect(result!.memories[0].content).toBe('Alice is a great developer');
    });

    it('should separate verified and unverified attributes', async () => {
      const mixedProfile = {
        ...baseProfile,
        attributes: [
          {
            key: 'a',
            value: '1',
            verified: true,
            confidence: 1.0,
            source: null,
          },
          {
            key: 'b',
            value: '2',
            verified: false,
            confidence: 0.3,
            source: 'inferred',
          },
          {
            key: 'c',
            value: '3',
            verified: true,
            confidence: 0.9,
            source: null,
          },
        ],
      };
      mockPrisma.entityProfile.findFirst.mockResolvedValue(mixedProfile);
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([]);
      mockPrisma.entityProfile.findUnique.mockResolvedValue({
        ...mixedProfile,
        entityId: null,
      });
      mockPrisma.graphEntity.findFirst.mockResolvedValue(null);

      const result = await service.recallEntity(ACCOUNT_ID, 'Alice');
      expect(result!.profile.attributes).toHaveLength(2);
      expect(result!.unverifiedAttributes).toHaveLength(1);
      expect(result!.unverifiedAttributes[0].key).toBe('b');
    });

    it('should deduplicate memories from profile and entity link paths', async () => {
      // Same memory appears via attached and entity-linked path
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([
        {
          id: 'epm-1',
          profileId: 'profile-1',
          memoryId: 'mem-1',
          relevanceScore: 0.9,
          attachMethod: 'MANUAL',
          createdAt: new Date(),
          memory: baseMemory,
        },
      ]);
      mockPrisma.entityProfile.findUnique.mockResolvedValue(baseProfile); // has entityId
      mockPrisma.memoryEntity.findMany.mockResolvedValue([
        {
          id: 'me-1',
          entityId: 'entity-1',
          memoryId: 'mem-1', // duplicate
          memory: baseMemory,
        },
      ]);
      mockPrisma.graphEntity.findFirst.mockResolvedValue(null);

      const result = await service.recallEntity(ACCOUNT_ID, 'Alice');
      // Should not have duplicated mem-1
      expect(result!.memories).toHaveLength(1);
    });

    it('should respect the limit on memories', async () => {
      const manyMemories = Array.from({ length: 20 }, (_, i) => ({
        id: `epm-${i}`,
        profileId: 'profile-1',
        memoryId: `mem-${i}`,
        relevanceScore: 0.5,
        attachMethod: 'MANUAL',
        createdAt: new Date(),
        memory: {
          id: `mem-${i}`,
          raw: `Memory ${i}`,
          importanceScore: Math.random(),
          source: 'chat',
          ingestedAt: new Date(),
        },
      }));

      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue(manyMemories);
      mockPrisma.entityProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        entityId: null,
      });
      mockPrisma.graphEntity.findFirst.mockResolvedValue(null);

      const result = await service.recallEntity(ACCOUNT_ID, 'Alice', 5);
      expect(result!.memories.length).toBeLessThanOrEqual(5);
    });

    it('should return relationships when graph entity found', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([]);
      mockPrisma.entityProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        entityId: null,
      });
      mockPrisma.graphEntity.findFirst.mockResolvedValue({ id: 'ge-1' });
      mockPrisma.graphRelationship.findMany.mockResolvedValue([
        {
          id: 'rel-1',
          sourceEntityId: 'ge-1',
          targetEntityId: 'ge-2',
          type: 'WORKS_WITH',
          weight: 0.8,
          sourceEntity: { id: 'ge-1', name: 'Alice' },
          targetEntity: { id: 'ge-2', name: 'Bob' },
        },
      ]);

      const result = await service.recallEntity(ACCOUNT_ID, 'Alice');
      expect(result!.relationships).toHaveLength(1);
      expect(result!.relationships[0].entity).toBe('Bob');
      expect(result!.relationships[0].type).toBe('WORKS_WITH');
      expect(result!.relationships[0].strength).toBe(0.8);
    });

    it('should return relationships for both source and target edges', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([]);
      mockPrisma.entityProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        entityId: null,
      });
      mockPrisma.graphEntity.findFirst.mockResolvedValue({ id: 'ge-1' });
      mockPrisma.graphRelationship.findMany.mockResolvedValue([
        {
          id: 'rel-1',
          sourceEntityId: 'ge-other',
          targetEntityId: 'ge-1', // Alice is the target
          type: 'MANAGES',
          weight: 0.9,
          sourceEntity: { id: 'ge-other', name: 'Carol' },
          targetEntity: { id: 'ge-1', name: 'Alice' },
        },
      ]);

      const result = await service.recallEntity(ACCOUNT_ID, 'Alice');
      expect(result!.relationships[0].entity).toBe('Carol');
      expect(result!.relationships[0].type).toBe('MANAGES');
    });

    it('should return empty relationships when graph entity lookup fails', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([]);
      mockPrisma.entityProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        entityId: null,
      });
      mockPrisma.graphEntity.findFirst.mockRejectedValue(new Error('DB error'));

      const result = await service.recallEntity(ACCOUNT_ID, 'Alice');
      expect(result!.relationships).toEqual([]);
    });
  });

  // =========================================================================
  // Matching strategies
  // =========================================================================

  describe('matching strategies', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([]);
      mockPrisma.entityProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        entityId: null,
      });
      mockPrisma.graphEntity.findFirst.mockResolvedValue(null);
    });

    it('should normalize entity name for exact match (lowercase + trim)', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);

      await service.recallEntity(ACCOUNT_ID, '  Alice  ');

      expect(mockPrisma.entityProfile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            normalizedName: 'alice', // trimmed + lowercased
          }),
        }),
      );
    });

    it('should try alias match when exact fails', async () => {
      // First call (exact) returns null; subsequent calls for alias return match
      mockPrisma.entityProfile.findFirst
        .mockResolvedValueOnce(null) // exact
        .mockResolvedValueOnce(baseProfile); // alias

      const result = await service.recallEntity(ACCOUNT_ID, 'Ally');
      expect(result).not.toBeNull();
      // findFirst called at least twice: once for exact, once for alias
      expect(
        mockPrisma.entityProfile.findFirst.mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });

    it('should try fuzzy (pg_trgm) when exact + alias fail', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(null); // exact + alias fail
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'profile-1', sim: 0.7 },
      ]); // fuzzy
      mockPrisma.entityProfile.findUnique.mockResolvedValueOnce(baseProfile); // fuzzy lookup

      const result = await service.recallEntity(ACCOUNT_ID, 'Alyce');
      expect(result).not.toBeNull();
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
    });

    it('should fall back to Levenshtein when pg_trgm throws', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(null);
      mockPrisma.$queryRawUnsafe
        .mockRejectedValueOnce(new Error('pg_trgm not available')) // trgm fails
        .mockResolvedValueOnce([]); // semantic check (no embeddings)

      // Levenshtein path — returns candidates and finds match
      mockPrisma.entityProfile.findMany.mockResolvedValue([
        { id: 'profile-1', normalizedName: 'alice' },
      ]);
      mockPrisma.entityProfile.findUnique.mockResolvedValue(baseProfile); // levenshtein lookup

      const result = await service.recallEntity(ACCOUNT_ID, 'Alyce');
      expect(result).not.toBeNull();
      expect(mockPrisma.entityProfile.findMany).toHaveBeenCalled();
    });

    it('should return null when Levenshtein ratio is below threshold (0.75)', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(null);
      mockPrisma.$queryRawUnsafe
        .mockRejectedValueOnce(new Error('pg_trgm unavailable')) // trgm fails
        .mockResolvedValueOnce([]); // semantic check

      // Very different name — Levenshtein ratio << 0.75
      mockPrisma.entityProfile.findMany.mockResolvedValue([
        { id: 'profile-1', normalizedName: 'zzzzzz' },
      ]);

      const result = await service.recallEntity(ACCOUNT_ID, 'Alice');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // Levenshtein internals (pure logic — test via private-accessible service)
  // =========================================================================

  describe('levenshteinDistance (pure logic)', () => {
    // Access private via any cast
    const svc = () => service as any;

    it('should return 0 for identical strings', () => {
      expect(svc().levenshteinDistance('abc', 'abc')).toBe(0);
    });

    it('should return string length for empty vs non-empty', () => {
      expect(svc().levenshteinDistance('', 'abc')).toBe(3);
      expect(svc().levenshteinDistance('abc', '')).toBe(3);
    });

    it('should return 1 for single substitution', () => {
      expect(svc().levenshteinDistance('cat', 'bat')).toBe(1);
    });

    it('should return 1 for single insertion', () => {
      expect(svc().levenshteinDistance('cat', 'cats')).toBe(1);
    });
  });

  describe('levenshteinRatio', () => {
    const svc = () => service as any;

    it('should return 1 for identical strings', () => {
      expect(svc().levenshteinRatio('alice', 'alice')).toBe(1);
    });

    it('should return 1 for two empty strings', () => {
      expect(svc().levenshteinRatio('', '')).toBe(1);
    });

    it('should return a ratio between 0 and 1 for partial matches', () => {
      const ratio = svc().levenshteinRatio('alice', 'alyce');
      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThan(1);
    });
  });

  // =========================================================================
  // recallBatch
  // =========================================================================

  describe('recallBatch', () => {
    it('should return array of results with nulls for unmatched', async () => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
      mockPrisma.entityProfile.findFirst
        .mockResolvedValueOnce(baseProfile) // 'Alice' found
        .mockResolvedValue(null); // 'Unknown' not found
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([]);
      mockPrisma.entityProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        entityId: null,
      });
      mockPrisma.graphEntity.findFirst.mockResolvedValue(null);

      const results = await service.recallBatch(ACCOUNT_ID, [
        'Alice',
        'Unknown',
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]).not.toBeNull();
      expect(results[1]).toBeNull();
    });

    it('should process all names in parallel', async () => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
      mockPrisma.entityProfile.findFirst.mockResolvedValue(null);
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const results = await service.recallBatch(ACCOUNT_ID, ['A', 'B', 'C']);
      expect(results).toHaveLength(3);
      expect(results.every((r) => r === null)).toBe(true);
    });
  });
});
