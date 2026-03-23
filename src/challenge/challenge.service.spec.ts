import { ChallengeService } from './challenge.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChallengeStatus, ResolutionMethod } from './challenge.types';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('ChallengeService', () => {
  let service: ChallengeService;
  let prisma: any;

  const mockMemory = {
    id: 'mem-1',
    userId: 'user-1',
    raw: 'Agent deployed to production successfully',
    confidence: 0.9,
    supersededById: null,
    metadata: null,
    createdAt: new Date('2026-02-20'),
  };

  beforeEach(() => {
    prisma = {
      memory: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    } as any;

    service = new ChallengeService(prisma);
  });

  describe('createChallenge', () => {
    it('should create a challenge against a memory', async () => {
      prisma.memory.findFirst.mockResolvedValue(mockMemory as any);
      prisma.memory.create.mockResolvedValue({
        id: 'challenge-1',
        raw: '[Challenge] Memory "Agent deployed..." challenged by agent-2: Deployment actually failed',
        metadata: {
          challenge: true,
          challengerId: 'agent-2',
          targetMemoryId: 'mem-1',
          reason: 'Deployment actually failed',
          evidence: 'Error logs show 500 errors',
          status: 'OPEN',
          resolution: null,
          resolvedBy: null,
          resolvedAt: null,
        },
        createdAt: new Date(),
      } as any);
      prisma.memory.update.mockResolvedValue({} as any);

      const result = await service.createChallenge('user-1', 'mem-1', {
        challengerId: 'agent-2',
        memoryId: 'mem-1',
        reason: 'Deployment actually failed',
        evidence: 'Error logs show 500 errors',
      });

      expect(result.id).toBe('challenge-1');
      expect(result.status).toBe('OPEN');
      expect(result.challengerId).toBe('agent-2');
      expect(result.reason).toBe('Deployment actually failed');

      // Should reduce confidence of original memory
      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'mem-1' },
          data: expect.objectContaining({
            confidence: 0.7, // 0.9 - 0.2
            metadata: expect.objectContaining({ disputed: true }),
          }),
        }),
      );
    });

    it('should throw NotFoundException for missing memory', async () => {
      prisma.memory.findFirst.mockResolvedValue(null);

      await expect(
        service.createChallenge('user-1', 'nonexistent', {
          challengerId: 'agent-2',
          memoryId: 'nonexistent',
          reason: 'test',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject challenging superseded memories', async () => {
      prisma.memory.findFirst.mockResolvedValue({
        ...mockMemory,
        supersededById: 'newer-mem',
      } as any);

      await expect(
        service.createChallenge('user-1', 'mem-1', {
          challengerId: 'agent-2',
          memoryId: 'mem-1',
          reason: 'test',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('listChallenges', () => {
    it('should list all challenges', async () => {
      prisma.memory.findMany.mockResolvedValue([
        {
          id: 'c-1',
          metadata: {
            challenge: true,
            challengerId: 'agent-2',
            targetMemoryId: 'mem-1',
            reason: 'Wrong',
            evidence: null,
            status: 'OPEN',
            resolution: null,
            resolvedBy: null,
            resolvedAt: null,
          },
          createdAt: new Date(),
        },
      ] as any);

      const result = await service.listChallenges('user-1');

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('OPEN');
    });

    it('should filter by status', async () => {
      prisma.memory.findMany.mockResolvedValue([
        {
          id: 'c-1',
          metadata: {
            challenge: true,
            status: 'OPEN',
            challengerId: 'a',
            targetMemoryId: 'm',
            reason: 'r',
            evidence: null,
            resolution: null,
            resolvedBy: null,
            resolvedAt: null,
          },
          createdAt: new Date(),
        },
        {
          id: 'c-2',
          metadata: {
            challenge: true,
            status: 'UPHELD',
            challengerId: 'a',
            targetMemoryId: 'm',
            reason: 'r',
            evidence: null,
            resolution: 'yes',
            resolvedBy: 'human',
            resolvedAt: new Date().toISOString(),
          },
          createdAt: new Date(),
        },
      ] as any);

      const result = await service.listChallenges('user-1', {
        status: ChallengeStatus.OPEN,
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('c-1');
    });
  });

  describe('resolveChallenge', () => {
    it('should resolve an open challenge', async () => {
      prisma.memory.findFirst.mockResolvedValue({
        id: 'c-1',
        raw: '[Challenge] ...',
        metadata: {
          challenge: true,
          challengerId: 'agent-2',
          targetMemoryId: 'mem-1',
          reason: 'Wrong',
          status: 'OPEN',
        },
        createdAt: new Date(),
      } as any);

      prisma.memory.update.mockResolvedValue({
        id: 'c-1',
        raw: '[Challenge] ... [Resolved: UPHELD — Confirmed failure]',
        metadata: {
          challenge: true,
          challengerId: 'agent-2',
          targetMemoryId: 'mem-1',
          reason: 'Wrong',
          status: 'UPHELD',
          resolution: 'Confirmed failure',
          resolvedBy: 'human-1',
          resolvedAt: expect.any(String),
          method: 'HUMAN_REVIEW',
        },
        createdAt: new Date(),
      } as any);

      prisma.memory.findUnique.mockResolvedValue({
        id: 'mem-1',
        confidence: 0.7,
        metadata: { disputed: true, challengeIds: ['c-1'] },
      } as any);

      const result = await service.resolveChallenge('user-1', 'c-1', {
        status: ChallengeStatus.UPHELD,
        resolution: 'Confirmed failure',
        method: ResolutionMethod.HUMAN_REVIEW,
        resolvedBy: 'human-1',
      });

      expect(result.status).toBe('UPHELD');
      expect(result.resolution).toBe('Confirmed failure');
    });

    it('should reject resolving already-resolved challenges', async () => {
      prisma.memory.findFirst.mockResolvedValue({
        id: 'c-1',
        metadata: { challenge: true, status: 'UPHELD' },
        createdAt: new Date(),
      } as any);

      await expect(
        service.resolveChallenge('user-1', 'c-1', {
          status: ChallengeStatus.DISMISSED,
          resolution: 'test',
          method: ResolutionMethod.HUMAN_REVIEW,
          resolvedBy: 'human',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
