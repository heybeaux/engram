import { Test, TestingModule } from '@nestjs/testing';
import { TrajectoryFeedbackController } from './feedback.controller';
import { TrajectoryFeedbackService } from './feedback.service';
import { ApiKeyOrJwtGuard } from '../../common/guards/api-key-or-jwt.guard';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';

describe('TrajectoryFeedbackController', () => {
  let controller: TrajectoryFeedbackController;
  let mockFeedbackService: any;

  beforeEach(async () => {
    mockFeedbackService = {
      processFeedback: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TrajectoryFeedbackController],
      providers: [
        { provide: TrajectoryFeedbackService, useValue: mockFeedbackService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TrajectoryFeedbackController>(
      TrajectoryFeedbackController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('submitFeedback', () => {
    it('should call processFeedback and return result', async () => {
      const dto = {
        recallId: 'recall-1',
        usedMemoryIds: ['mem-1', 'mem-2'],
        unusedMemoryIds: ['mem-3'],
      };
      const expected = { updated: 3, recallId: 'recall-1' };
      mockFeedbackService.processFeedback.mockResolvedValue(expected);

      const result = await controller.submitFeedback(dto as any);

      expect(result).toEqual(expected);
      expect(mockFeedbackService.processFeedback).toHaveBeenCalledWith(dto);
    });

    it('should handle feedback with only used memory ids', async () => {
      const dto = {
        recallId: 'recall-2',
        usedMemoryIds: ['mem-1'],
      };
      const expected = { updated: 1, recallId: 'recall-2' };
      mockFeedbackService.processFeedback.mockResolvedValue(expected);

      const result = await controller.submitFeedback(dto as any);

      expect(result).toEqual(expected);
    });

    it('should propagate service errors', async () => {
      const dto = {
        recallId: 'recall-3',
        usedMemoryIds: ['mem-1'],
      };
      mockFeedbackService.processFeedback.mockRejectedValue(
        new Error('DB error'),
      );

      await expect(controller.submitFeedback(dto as any)).rejects.toThrow(
        'DB error',
      );
    });
  });
});
