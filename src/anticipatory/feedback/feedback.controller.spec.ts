import { Test, TestingModule } from '@nestjs/testing';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

describe('FeedbackController (anticipatory)', () => {
  let controller: FeedbackController;
  let mockFeedbackService: any;

  beforeEach(async () => {
    mockFeedbackService = {
      recordFeedback: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeedbackController],
      providers: [{ provide: FeedbackService, useValue: mockFeedbackService }],
    }).compile();

    controller = module.get<FeedbackController>(FeedbackController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('submitFeedback', () => {
    it('should record feedback and return ok', async () => {
      const dto = {
        memoryId: 'mem-1',
        recallId: 'recall-1',
        wasUseful: true,
      };
      const req = { user: { userId: 'user-1' } };
      mockFeedbackService.recordFeedback.mockResolvedValue(undefined);

      const result = await controller.submitFeedback(dto as any, req);

      expect(result).toEqual({ ok: true });
      expect(mockFeedbackService.recordFeedback).toHaveBeenCalledWith(
        'mem-1',
        'recall-1',
        true,
        'user-1',
      );
    });

    it('should extract userId from req.userId fallback', async () => {
      const dto = {
        memoryId: 'mem-2',
        recallId: undefined,
        wasUseful: false,
      };
      const req = { userId: 'user-2' };
      mockFeedbackService.recordFeedback.mockResolvedValue(undefined);

      const result = await controller.submitFeedback(dto as any, req);

      expect(result).toEqual({ ok: true });
      expect(mockFeedbackService.recordFeedback).toHaveBeenCalledWith(
        'mem-2',
        undefined,
        false,
        'user-2',
      );
    });

    it('should default to "unknown" userId when not present', async () => {
      const dto = {
        memoryId: 'mem-3',
        recallId: 'recall-3',
        wasUseful: false,
      };
      const req = {};
      mockFeedbackService.recordFeedback.mockResolvedValue(undefined);

      const result = await controller.submitFeedback(dto as any, req);

      expect(result).toEqual({ ok: true });
      expect(mockFeedbackService.recordFeedback).toHaveBeenCalledWith(
        'mem-3',
        'recall-3',
        false,
        'unknown',
      );
    });

    it('should propagate service errors', async () => {
      const dto = {
        memoryId: 'mem-1',
        recallId: 'recall-1',
        wasUseful: true,
      };
      const req = { user: { userId: 'user-1' } };
      mockFeedbackService.recordFeedback.mockRejectedValue(
        new Error('DB write failed'),
      );

      await expect(controller.submitFeedback(dto as any, req)).rejects.toThrow(
        'DB write failed',
      );
    });
  });
});
