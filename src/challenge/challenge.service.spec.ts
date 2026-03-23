import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ChallengeService } from './challenge.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ChallengeStatus,
  ChallengeResolution,
  ResolutionMethod,
} from './challenge.types';

const mockPrisma = {
  memory: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

const baseMemory = {
  id: 'mem-001',
  userId: 'user-123',
  raw: 'This is a test memory about something important',
  layer: 'SESSION',
  memoryType: 'FACT',
  source: 'USER',
  subjectType: 'USER',
  importanceScore: 0.9,
  confidence: 0.8,
  metadata: {},
  supersededById: null,
  deletedAt: null,
  createdAt: new Date('2026-03-20T10:00:00Z'),
};

const baseChallengeMemory = {
  id: 'chal-001',
  userId: 'user-123',
  raw: '[Challenge] Memory "This is a test memory about..." challenged by agent-x: incorrect data',
  layer: 'INSIGHT',
  memoryType: 'FACT',
  source: 'SYSTEM',
  confidence: 0.5,
  metadata: {
    challenge: true,
    challengerId: 'agent-x',
    targetMemoryId: 'mem-001',
    reason: 'incorrect data',
    evidence: null,
    status: ChallengeStatus.OPEN,
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
  },
  createdAt: new Date('2026-03-21T10:00:00Z'),
};

describe('ChallengeService', () => {
  let service: ChallengeService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChallengeService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ChallengeService>(ChallengeService);
  });

  // ─── createChallenge ────────────────────────────────────────────────────────

  describe('createChallenge', () => {
    it('should create a challenge successfully (happy path)', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseMemory);
      mockPrisma.memory.create.mockResolvedValueOnce(baseChallengeMemory);
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      const result = await service.createChallenge('user-123', 'mem-001', {
        challengerId: 'agent-x',
        memoryId: 'mem-001',
        reason: 'incorrect data',
      });

      expect(result.id).toBe('chal-001');
      expect(result.challengerId).toBe('agent-x');
      expect(result.status).toBe(ChallengeStatus.OPEN);
      expect(result.evidence).toBeNull();
      expect(mockPrisma.memory.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.memory.update).toHaveBeenCalledTimes(1);
    });

    it('should create a challenge with evidence', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseMemory);
      const withEvidence = {
        ...baseChallengeMemory,
        metadata: {
          ...baseChallengeMemory.metadata,
          evidence: 'https://source.example.com/proof',
        },
      };
      mockPrisma.memory.create.mockResolvedValueOnce(withEvidence);
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      const result = await service.createChallenge('user-123', 'mem-001', {
        challengerId: 'agent-x',
        memoryId: 'mem-001',
        reason: 'incorrect data',
        evidence: 'https://source.example.com/proof',
      });

      expect(result.evidence).toBe('https://source.example.com/proof');
    });

    it('should throw NotFoundException if memory does not exist', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.createChallenge('user-123', 'nonexistent-mem', {
          challengerId: 'agent-x',
          memoryId: 'nonexistent-mem',
          reason: 'test',
        }),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.memory.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for memory belonging to different user', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(null); // userId filter returns null

      await expect(
        service.createChallenge('other-user', 'mem-001', {
          challengerId: 'agent-x',
          memoryId: 'mem-001',
          reason: 'test',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for superseded memory', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce({
        ...baseMemory,
        supersededById: 'mem-newer',
      });

      await expect(
        service.createChallenge('user-123', 'mem-001', {
          challengerId: 'agent-x',
          memoryId: 'mem-001',
          reason: 'test',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reduce confidence of target memory when creating challenge', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseMemory);
      mockPrisma.memory.create.mockResolvedValueOnce(baseChallengeMemory);
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      await service.createChallenge('user-123', 'mem-001', {
        challengerId: 'agent-x',
        memoryId: 'mem-001',
        reason: 'test',
      });

      const updateCall = mockPrisma.memory.update.mock.calls[0][0];
      // confidence should be reduced: max(0.1, 0.8 - 0.2) = 0.6
      expect(updateCall.data.confidence).toBeCloseTo(0.6, 5);
      expect(updateCall.data.metadata.disputed).toBe(true);
    });

    it('should append challengeId to existing challengeIds on target memory', async () => {
      const memWithExistingChallenge = {
        ...baseMemory,
        metadata: { challengeIds: ['existing-chal-id'] },
      };
      mockPrisma.memory.findFirst.mockResolvedValueOnce(
        memWithExistingChallenge,
      );
      mockPrisma.memory.create.mockResolvedValueOnce(baseChallengeMemory);
      mockPrisma.memory.update.mockResolvedValueOnce({
        ...memWithExistingChallenge,
      });

      await service.createChallenge('user-123', 'mem-001', {
        challengerId: 'agent-y',
        memoryId: 'mem-001',
        reason: 'additional dispute',
      });

      const updateCall = mockPrisma.memory.update.mock.calls[0][0];
      expect(updateCall.data.metadata.challengeIds).toContain(
        'existing-chal-id',
      );
      expect(updateCall.data.metadata.challengeIds).toContain('chal-001');
    });

    it('should not drop confidence below 0.1', async () => {
      const lowConfidenceMemory = { ...baseMemory, confidence: 0.15 };
      mockPrisma.memory.findFirst.mockResolvedValueOnce(lowConfidenceMemory);
      mockPrisma.memory.create.mockResolvedValueOnce(baseChallengeMemory);
      mockPrisma.memory.update.mockResolvedValueOnce({ ...lowConfidenceMemory });

      await service.createChallenge('user-123', 'mem-001', {
        challengerId: 'agent-x',
        memoryId: 'mem-001',
        reason: 'test',
      });

      const updateCall = mockPrisma.memory.update.mock.calls[0][0];
      // max(0.1, 0.15 - 0.2) = max(0.1, -0.05) = 0.1
      expect(updateCall.data.confidence).toBeCloseTo(0.1, 5);
    });
  });

  // ─── listChallenges ─────────────────────────────────────────────────────────

  describe('listChallenges', () => {
    it('should return all challenges for user (happy path)', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce([
        baseChallengeMemory,
        { ...baseChallengeMemory, id: 'chal-002' },
      ]);

      const result = await service.listChallenges('user-123');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('chal-001');
      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-123' }),
          take: 50,
          skip: 0,
        }),
      );
    });

    it('should filter by status in app layer', async () => {
      const openChallenge = baseChallengeMemory;
      const resolvedChallenge = {
        ...baseChallengeMemory,
        id: 'chal-002',
        metadata: { ...baseChallengeMemory.metadata, status: ChallengeStatus.UPHELD },
      };
      mockPrisma.memory.findMany.mockResolvedValueOnce([
        openChallenge,
        resolvedChallenge,
      ]);

      const result = await service.listChallenges('user-123', {
        status: ChallengeStatus.OPEN,
      });

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe(ChallengeStatus.OPEN);
    });

    it('should respect custom limit and offset', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce([]);

      await service.listChallenges('user-123', { limit: 10, offset: 20 });

      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 20 }),
      );
    });

    it('should return empty array when no challenges exist', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce([]);

      const result = await service.listChallenges('user-123');
      expect(result).toEqual([]);
    });
  });

  // ─── getChallenge ───────────────────────────────────────────────────────────

  describe('getChallenge', () => {
    it('should return a challenge by ID (happy path)', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseChallengeMemory);

      const result = await service.getChallenge('user-123', 'chal-001');

      expect(result.id).toBe('chal-001');
      expect(result.status).toBe(ChallengeStatus.OPEN);
    });

    it('should throw NotFoundException for non-existent challenge', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.getChallenge('user-123', 'nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for challenge owned by different user', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.getChallenge('other-user', 'chal-001'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── resolveChallenge ───────────────────────────────────────────────────────

  describe('resolveChallenge', () => {
    const upheldResolution: ChallengeResolution = {
      status: ChallengeStatus.UPHELD,
      resolution: 'Memory confirmed incorrect based on evidence',
      method: ResolutionMethod.EVIDENCE_BASED,
      resolvedBy: 'admin-agent',
    };

    const dismissedResolution: ChallengeResolution = {
      status: ChallengeStatus.DISMISSED,
      resolution: 'Challenge dismissed — memory is accurate',
      method: ResolutionMethod.HUMAN_REVIEW,
      resolvedBy: 'admin-agent',
    };

    it('should resolve an OPEN challenge as UPHELD (happy path)', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseChallengeMemory);
      const updatedChallenge = {
        ...baseChallengeMemory,
        metadata: {
          ...baseChallengeMemory.metadata,
          status: ChallengeStatus.UPHELD,
          resolvedBy: 'admin-agent',
        },
      };
      mockPrisma.memory.update.mockResolvedValueOnce(updatedChallenge);
      mockPrisma.memory.findUnique.mockResolvedValueOnce({
        ...baseMemory,
        metadata: { disputed: true, challengeIds: ['chal-001'] },
      });
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      const result = await service.resolveChallenge(
        'user-123',
        'chal-001',
        upheldResolution,
      );

      expect(result.status).toBe(ChallengeStatus.UPHELD);
      expect(mockPrisma.memory.update).toHaveBeenCalledTimes(2); // challenge + target
    });

    it('should resolve an UNDER_REVIEW challenge as DISMISSED', async () => {
      const underReviewChallenge = {
        ...baseChallengeMemory,
        metadata: {
          ...baseChallengeMemory.metadata,
          status: ChallengeStatus.UNDER_REVIEW,
        },
      };
      mockPrisma.memory.findFirst.mockResolvedValueOnce(underReviewChallenge);
      const updatedChallenge = {
        ...underReviewChallenge,
        metadata: { ...underReviewChallenge.metadata, status: ChallengeStatus.DISMISSED },
      };
      mockPrisma.memory.update.mockResolvedValueOnce(updatedChallenge);
      mockPrisma.memory.findUnique.mockResolvedValueOnce({
        ...baseMemory,
        metadata: { disputed: true, challengeIds: ['chal-001'] },
      });
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      const result = await service.resolveChallenge(
        'user-123',
        'chal-001',
        dismissedResolution,
      );

      expect(result.status).toBe(ChallengeStatus.DISMISSED);
    });

    it('should throw NotFoundException for non-existent challenge', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.resolveChallenge('user-123', 'nonexistent', upheldResolution),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for already-resolved challenge', async () => {
      const resolvedChallenge = {
        ...baseChallengeMemory,
        metadata: {
          ...baseChallengeMemory.metadata,
          status: ChallengeStatus.UPHELD,
        },
      };
      mockPrisma.memory.findFirst.mockResolvedValueOnce(resolvedChallenge);

      await expect(
        service.resolveChallenge('user-123', 'chal-001', upheldResolution),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for RESOLVED status challenge', async () => {
      const resolvedChallenge = {
        ...baseChallengeMemory,
        metadata: {
          ...baseChallengeMemory.metadata,
          status: ChallengeStatus.RESOLVED,
        },
      };
      mockPrisma.memory.findFirst.mockResolvedValueOnce(resolvedChallenge);

      await expect(
        service.resolveChallenge('user-123', 'chal-001', upheldResolution),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reduce target confidence further when UPHELD', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseChallengeMemory);
      mockPrisma.memory.update.mockResolvedValueOnce({
        ...baseChallengeMemory,
        metadata: { ...baseChallengeMemory.metadata, status: ChallengeStatus.UPHELD },
      });
      mockPrisma.memory.findUnique.mockResolvedValueOnce({
        ...baseMemory,
        confidence: 0.6,
        metadata: { disputed: true, challengeIds: ['chal-001'] },
      });
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      await service.resolveChallenge('user-123', 'chal-001', upheldResolution);

      const targetUpdateCall = mockPrisma.memory.update.mock.calls[1][0];
      // max(0.05, 0.6 - 0.3) = 0.3
      expect(targetUpdateCall.data.confidence).toBeCloseTo(0.3, 5);
    });

    it('should not drop target confidence below 0.05 when UPHELD', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseChallengeMemory);
      mockPrisma.memory.update.mockResolvedValueOnce({
        ...baseChallengeMemory,
        metadata: { ...baseChallengeMemory.metadata, status: ChallengeStatus.UPHELD },
      });
      mockPrisma.memory.findUnique.mockResolvedValueOnce({
        ...baseMemory,
        confidence: 0.1,
        metadata: { disputed: true, challengeIds: ['chal-001'] },
      });
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      await service.resolveChallenge('user-123', 'chal-001', upheldResolution);

      const targetUpdateCall = mockPrisma.memory.update.mock.calls[1][0];
      // max(0.05, 0.1 - 0.3) = 0.05
      expect(targetUpdateCall.data.confidence).toBeCloseTo(0.05, 5);
    });

    it('should restore confidence when DISMISSED', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseChallengeMemory);
      mockPrisma.memory.update.mockResolvedValueOnce({
        ...baseChallengeMemory,
        metadata: { ...baseChallengeMemory.metadata, status: ChallengeStatus.DISMISSED },
      });
      mockPrisma.memory.findUnique.mockResolvedValueOnce({
        ...baseMemory,
        confidence: 0.5,
        metadata: { disputed: true, challengeIds: ['chal-001'] },
      });
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      await service.resolveChallenge(
        'user-123',
        'chal-001',
        dismissedResolution,
      );

      const targetUpdateCall = mockPrisma.memory.update.mock.calls[1][0];
      // min(1.0, 0.5 + 0.2) = 0.7
      expect(targetUpdateCall.data.confidence).toBeCloseTo(0.7, 5);
    });

    it('should not exceed confidence 1.0 when DISMISSED', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseChallengeMemory);
      mockPrisma.memory.update.mockResolvedValueOnce({
        ...baseChallengeMemory,
        metadata: { ...baseChallengeMemory.metadata, status: ChallengeStatus.DISMISSED },
      });
      mockPrisma.memory.findUnique.mockResolvedValueOnce({
        ...baseMemory,
        confidence: 0.95,
        metadata: { disputed: true, challengeIds: ['chal-001'] },
      });
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      await service.resolveChallenge(
        'user-123',
        'chal-001',
        dismissedResolution,
      );

      const targetUpdateCall = mockPrisma.memory.update.mock.calls[1][0];
      // min(1.0, 0.95 + 0.2) = 1.0
      expect(targetUpdateCall.data.confidence).toBe(1.0);
    });

    it('should mark disputed=false when DISMISSED and no remaining challenges', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseChallengeMemory);
      mockPrisma.memory.update.mockResolvedValueOnce({
        ...baseChallengeMemory,
        metadata: { ...baseChallengeMemory.metadata, status: ChallengeStatus.DISMISSED },
      });
      mockPrisma.memory.findUnique.mockResolvedValueOnce({
        ...baseMemory,
        confidence: 0.5,
        metadata: { disputed: true, challengeIds: ['chal-001'] },
      });
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      await service.resolveChallenge(
        'user-123',
        'chal-001',
        dismissedResolution,
      );

      const targetUpdateCall = mockPrisma.memory.update.mock.calls[1][0];
      // Only challenge was 'chal-001', after filter it's empty => disputed=false
      expect(targetUpdateCall.data.metadata.disputed).toBe(false);
    });

    it('should keep disputed=true when DISMISSED but other open challenges remain', async () => {
      const challengeWithMultiple = {
        ...baseChallengeMemory,
        metadata: {
          ...baseChallengeMemory.metadata,
          targetMemoryId: 'mem-001',
        },
      };
      mockPrisma.memory.findFirst.mockResolvedValueOnce(challengeWithMultiple);
      mockPrisma.memory.update.mockResolvedValueOnce({
        ...challengeWithMultiple,
        metadata: { ...challengeWithMultiple.metadata, status: ChallengeStatus.DISMISSED },
      });
      mockPrisma.memory.findUnique.mockResolvedValueOnce({
        ...baseMemory,
        confidence: 0.5,
        metadata: {
          disputed: true,
          challengeIds: ['chal-001', 'chal-002'], // Two challenges exist
        },
      });
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      await service.resolveChallenge(
        'user-123',
        'chal-001',
        dismissedResolution,
      );

      const targetUpdateCall = mockPrisma.memory.update.mock.calls[1][0];
      // 'chal-002' remains => disputed=true
      expect(targetUpdateCall.data.metadata.disputed).toBe(true);
    });

    it('should gracefully handle missing target memory on resolve', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseChallengeMemory);
      mockPrisma.memory.update.mockResolvedValueOnce({
        ...baseChallengeMemory,
        metadata: { ...baseChallengeMemory.metadata, status: ChallengeStatus.UPHELD },
      });
      mockPrisma.memory.findUnique.mockResolvedValueOnce(null); // Target gone

      // Should not throw — missing target is handled gracefully
      await expect(
        service.resolveChallenge('user-123', 'chal-001', upheldResolution),
      ).resolves.not.toThrow();

      // Only one update — the challenge itself; target update skipped
      expect(mockPrisma.memory.update).toHaveBeenCalledTimes(1);
    });
  });

  // ─── toChallengeResult (private — tested via public methods) ────────────────

  describe('toChallengeResult (via createChallenge)', () => {
    it('should correctly map resolvedAt to Date when string present', async () => {
      const resolvedAt = '2026-03-22T09:00:00Z';
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseChallengeMemory);
      const challengeWithResolvedAt = {
        ...baseChallengeMemory,
        metadata: {
          ...baseChallengeMemory.metadata,
          resolvedAt,
        },
      };
      mockPrisma.memory.create.mockResolvedValueOnce(challengeWithResolvedAt);
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      const result = await service.createChallenge('user-123', 'mem-001', {
        challengerId: 'agent-x',
        memoryId: 'mem-001',
        reason: 'test',
      });

      expect(result.resolvedAt).toBeInstanceOf(Date);
      expect(result.resolvedAt?.toISOString()).toBe(new Date(resolvedAt).toISOString());
    });

    it('should return null resolvedAt when not set', async () => {
      mockPrisma.memory.findFirst.mockResolvedValueOnce(baseMemory);
      mockPrisma.memory.create.mockResolvedValueOnce(baseChallengeMemory);
      mockPrisma.memory.update.mockResolvedValueOnce({ ...baseMemory });

      const result = await service.createChallenge('user-123', 'mem-001', {
        challengerId: 'agent-x',
        memoryId: 'mem-001',
        reason: 'test',
      });

      expect(result.resolvedAt).toBeNull();
    });
  });
});
