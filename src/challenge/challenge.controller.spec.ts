import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ChallengeController } from './challenge.controller';
import { ChallengeService } from './challenge.service';
import { ChallengeStatus, ResolutionMethod } from './challenge.types';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

const mockChallengeResult = {
  id: 'challenge-1',
  challengerId: 'challenger-user',
  memoryId: 'memory-1',
  reason: 'This memory is incorrect',
  evidence: 'Here is my evidence',
  status: ChallengeStatus.OPEN,
  resolution: null,
  resolvedBy: null,
  resolvedAt: null,
  createdAt: new Date('2026-03-12T00:00:00Z'),
};

const mockChallengeService = {
  createChallenge: jest.fn(),
  listChallenges: jest.fn(),
  getChallenge: jest.fn(),
  resolveChallenge: jest.fn(),
};

describe('ChallengeController', () => {
  let controller: ChallengeController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChallengeController],
      providers: [
        { provide: ChallengeService, useValue: mockChallengeService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ChallengeController>(ChallengeController);
  });

  // ─── createChallenge ──────────────────────────────────────────────────────

  describe('createChallenge()', () => {
    it('should create a challenge and return result', async () => {
      mockChallengeService.createChallenge.mockResolvedValue(
        mockChallengeResult,
      );

      const result = await controller.createChallenge('user-1', 'memory-1', {
        challengerId: 'challenger-user',
        reason: 'This memory is incorrect',
        evidence: 'Here is my evidence',
      });

      expect(mockChallengeService.createChallenge).toHaveBeenCalledWith(
        'user-1',
        'memory-1',
        {
          challengerId: 'challenger-user',
          memoryId: 'memory-1',
          reason: 'This memory is incorrect',
          evidence: 'Here is my evidence',
        },
      );
      expect(result).toEqual(mockChallengeResult);
    });

    it('should create a challenge without optional evidence', async () => {
      mockChallengeService.createChallenge.mockResolvedValue({
        ...mockChallengeResult,
        evidence: null,
      });

      const result = await controller.createChallenge('user-1', 'memory-1', {
        challengerId: 'challenger-user',
        reason: 'This memory is incorrect',
      });

      expect(mockChallengeService.createChallenge).toHaveBeenCalledWith(
        'user-1',
        'memory-1',
        {
          challengerId: 'challenger-user',
          memoryId: 'memory-1',
          reason: 'This memory is incorrect',
          evidence: undefined,
        },
      );
      expect(result.evidence).toBeNull();
    });

    it('should propagate NotFoundException when memory not found', async () => {
      mockChallengeService.createChallenge.mockRejectedValue(
        new NotFoundException('Memory memory-999 not found'),
      );

      await expect(
        controller.createChallenge('user-1', 'memory-999', {
          challengerId: 'challenger-user',
          reason: 'Test reason',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should propagate BadRequestException when challenging superseded memory', async () => {
      mockChallengeService.createChallenge.mockRejectedValue(
        new BadRequestException('Cannot challenge a superseded memory'),
      );

      await expect(
        controller.createChallenge('user-1', 'memory-1', {
          challengerId: 'challenger-user',
          reason: 'Test reason',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── listChallenges ───────────────────────────────────────────────────────

  describe('listChallenges()', () => {
    it('should list all challenges without filters', async () => {
      mockChallengeService.listChallenges.mockResolvedValue([
        mockChallengeResult,
      ]);

      const result = await controller.listChallenges('user-1');

      expect(mockChallengeService.listChallenges).toHaveBeenCalledWith(
        'user-1',
        { status: undefined, limit: undefined, offset: undefined },
      );
      expect(result).toHaveLength(1);
    });

    it('should pass status filter to service', async () => {
      mockChallengeService.listChallenges.mockResolvedValue([
        mockChallengeResult,
      ]);

      await controller.listChallenges('user-1', ChallengeStatus.OPEN);

      expect(mockChallengeService.listChallenges).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ status: ChallengeStatus.OPEN }),
      );
    });

    it('should parse limit and offset as integers', async () => {
      mockChallengeService.listChallenges.mockResolvedValue([]);

      await controller.listChallenges('user-1', undefined, '10', '20');

      expect(mockChallengeService.listChallenges).toHaveBeenCalledWith(
        'user-1',
        { status: undefined, limit: 10, offset: 20 },
      );
    });

    it('should return empty array when no challenges', async () => {
      mockChallengeService.listChallenges.mockResolvedValue([]);

      const result = await controller.listChallenges('user-1');
      expect(result).toEqual([]);
    });

    it('should handle both status and pagination filters', async () => {
      mockChallengeService.listChallenges.mockResolvedValue([
        mockChallengeResult,
      ]);

      await controller.listChallenges(
        'user-1',
        ChallengeStatus.UNDER_REVIEW,
        '5',
        '0',
      );

      expect(mockChallengeService.listChallenges).toHaveBeenCalledWith(
        'user-1',
        { status: ChallengeStatus.UNDER_REVIEW, limit: 5, offset: 0 },
      );
    });
  });

  // ─── getChallenge ─────────────────────────────────────────────────────────

  describe('getChallenge()', () => {
    it('should return a challenge by ID', async () => {
      mockChallengeService.getChallenge.mockResolvedValue(mockChallengeResult);

      const result = await controller.getChallenge('user-1', 'challenge-1');

      expect(mockChallengeService.getChallenge).toHaveBeenCalledWith(
        'user-1',
        'challenge-1',
      );
      expect(result).toEqual(mockChallengeResult);
    });

    it('should propagate NotFoundException when challenge not found', async () => {
      mockChallengeService.getChallenge.mockRejectedValue(
        new NotFoundException('Challenge challenge-999 not found'),
      );

      await expect(
        controller.getChallenge('user-1', 'challenge-999'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── resolveChallenge ─────────────────────────────────────────────────────

  describe('resolveChallenge()', () => {
    const resolveDto = {
      status: ChallengeStatus.DISMISSED,
      resolution: 'Memory verified to be correct',
      method: ResolutionMethod.HUMAN_REVIEW,
      resolvedBy: 'admin-user',
    };

    it('should resolve a challenge and return updated result', async () => {
      const resolvedResult = {
        ...mockChallengeResult,
        status: ChallengeStatus.DISMISSED,
        resolution: 'Memory verified to be correct',
        resolvedBy: 'admin-user',
        resolvedAt: new Date('2026-03-12T01:00:00Z'),
      };
      mockChallengeService.resolveChallenge.mockResolvedValue(resolvedResult);

      const result = await controller.resolveChallenge(
        'user-1',
        'challenge-1',
        resolveDto,
      );

      expect(mockChallengeService.resolveChallenge).toHaveBeenCalledWith(
        'user-1',
        'challenge-1',
        {
          status: ChallengeStatus.DISMISSED,
          resolution: 'Memory verified to be correct',
          method: ResolutionMethod.HUMAN_REVIEW,
          resolvedBy: 'admin-user',
        },
      );
      expect(result.status).toBe(ChallengeStatus.DISMISSED);
      expect(result.resolvedBy).toBe('admin-user');
    });

    it('should resolve with UPHELD status', async () => {
      const upheldDto = {
        ...resolveDto,
        status: ChallengeStatus.UPHELD,
      };
      const upheldResult = {
        ...mockChallengeResult,
        status: ChallengeStatus.UPHELD,
      };
      mockChallengeService.resolveChallenge.mockResolvedValue(upheldResult);

      const result = await controller.resolveChallenge(
        'user-1',
        'challenge-1',
        upheldDto,
      );
      expect(result.status).toBe(ChallengeStatus.UPHELD);
    });

    it('should propagate BadRequestException when already resolved', async () => {
      mockChallengeService.resolveChallenge.mockRejectedValue(
        new BadRequestException('Challenge is already resolved'),
      );

      await expect(
        controller.resolveChallenge('user-1', 'challenge-1', resolveDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should propagate NotFoundException when challenge not found', async () => {
      mockChallengeService.resolveChallenge.mockRejectedValue(
        new NotFoundException('Challenge challenge-999 not found'),
      );

      await expect(
        controller.resolveChallenge('user-1', 'challenge-999', resolveDto),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
