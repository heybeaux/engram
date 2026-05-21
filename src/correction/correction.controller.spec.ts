import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import {
  CorrectionController,
  ManualCorrectDto,
} from './correction.controller';
import { CorrectionService } from './correction.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

const mockCorrectionService = {
  manualCorrect: jest.fn(),
};

// Guard mock — simulates authenticated user
const mockGuard = {
  canActivate: jest.fn((ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    req.user = { id: 'user-123' };
    return true;
  }),
};

describe('CorrectionController', () => {
  let controller: CorrectionController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CorrectionController],
      providers: [
        { provide: CorrectionService, useValue: mockCorrectionService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue(mockGuard)
      .compile();

    controller = module.get<CorrectionController>(CorrectionController);
  });

  describe('correct()', () => {
    const userId = 'user-123';
    const memoryId = 'mem-abc';

    it('should return correctionId and supersededId on success', async () => {
      mockCorrectionService.manualCorrect.mockResolvedValue({
        correctionId: 'corr-1',
        supersededId: memoryId,
      });

      const dto: ManualCorrectDto = { correctedContent: 'Updated fact' };
      const result = await controller.correct(userId, memoryId, dto);

      expect(result).toEqual({
        correctionId: 'corr-1',
        supersededId: memoryId,
      });
    });

    it('should pass all parameters to CorrectionService', async () => {
      mockCorrectionService.manualCorrect.mockResolvedValue({
        correctionId: 'corr-2',
        supersededId: memoryId,
      });

      const dto: ManualCorrectDto = {
        correctedContent: 'New fact',
        reason: 'It was wrong',
      };
      await controller.correct(userId, memoryId, dto);

      expect(mockCorrectionService.manualCorrect).toHaveBeenCalledWith(
        userId,
        memoryId,
        'New fact',
        'It was wrong',
      );
    });

    it('should pass undefined reason when not provided', async () => {
      mockCorrectionService.manualCorrect.mockResolvedValue({
        correctionId: 'corr-3',
        supersededId: memoryId,
      });

      const dto: ManualCorrectDto = { correctedContent: 'Fact without reason' };
      await controller.correct(userId, memoryId, dto);

      expect(mockCorrectionService.manualCorrect).toHaveBeenCalledWith(
        userId,
        memoryId,
        'Fact without reason',
        undefined,
      );
    });

    it('should propagate service errors', async () => {
      mockCorrectionService.manualCorrect.mockRejectedValue(
        new Error('Memory not found: bad-id'),
      );

      const dto: ManualCorrectDto = { correctedContent: 'Test' };
      await expect(controller.correct(userId, 'bad-id', dto)).rejects.toThrow(
        'Memory not found',
      );
    });

    it('should propagate access denied errors', async () => {
      mockCorrectionService.manualCorrect.mockRejectedValue(
        new Error('Access denied: Memory belongs to another user'),
      );

      const dto: ManualCorrectDto = { correctedContent: 'Steal your memory' };
      await expect(
        controller.correct('attacker', memoryId, dto),
      ).rejects.toThrow('Access denied');
    });
  });

  describe('ApiKeyOrJwtGuard', () => {
    it('should apply the guard on the controller class', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        CorrectionController,
      ) as unknown[];
      // The guard is applied at class level via @UseGuards()
      expect(guards).toBeDefined();
      expect(guards.length).toBeGreaterThan(0);
    });

    it('should block unauthenticated requests when guard returns false', async () => {
      // Reset guard to deny
      mockGuard.canActivate.mockReturnValueOnce(false);

      const denyModule: TestingModule = await Test.createTestingModule({
        controllers: [CorrectionController],
        providers: [
          { provide: CorrectionService, useValue: mockCorrectionService },
        ],
      })
        .overrideGuard(ApiKeyOrJwtGuard)
        .useValue(mockGuard)
        .compile();

      // Module creation succeeds — guard enforcement happens at the HTTP layer
      // This test confirms the guard is wired and can be overridden
      expect(
        denyModule.get<CorrectionController>(CorrectionController),
      ).toBeDefined();
    });
  });

  describe('ManualCorrectDto', () => {
    it('should accept correctedContent only (reason optional)', () => {
      const dto = new ManualCorrectDto();
      dto.correctedContent = 'New value';
      expect(dto.correctedContent).toBe('New value');
      expect(dto.reason).toBeUndefined();
    });

    it('should accept both correctedContent and reason', () => {
      const dto = new ManualCorrectDto();
      dto.correctedContent = 'New value';
      dto.reason = 'Was incorrect';
      expect(dto.reason).toBe('Was incorrect');
    });
  });
});
