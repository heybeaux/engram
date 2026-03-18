import { Test, TestingModule } from '@nestjs/testing';
import { RetrievalSignalsController } from './retrieval-signals.controller';
import { RetrievalSignalsService } from './retrieval-signals.service';
import { FeedbackSignalType } from './dto/feedback.dto';
import { RetrievalSignalType } from '@prisma/client';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('RetrievalSignalsController', () => {
  let controller: RetrievalSignalsController;
  let mockService: any;

  const mockGuard = { canActivate: jest.fn().mockReturnValue(true) };

  beforeEach(async () => {
    mockService = {
      logSignal: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RetrievalSignalsController],
      providers: [
        { provide: RetrievalSignalsService, useValue: mockService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue(mockGuard)
      .compile();

    controller = module.get<RetrievalSignalsController>(RetrievalSignalsController);
    jest.clearAllMocks();
  });

  describe('submitFeedback', () => {
    it('should log an EXPLICIT_HIT signal with default weight 2.0', async () => {
      mockService.logSignal.mockResolvedValue('sig-1');

      const result = await controller.submitFeedback(
        {
          queryId: 'query-1',
          memoryId: 'mem-1',
          signal: FeedbackSignalType.EXPLICIT_HIT,
        },
        { accountId: 'acc-1' },
      );

      expect(result).toEqual({ signalId: 'sig-1' });
      expect(mockService.logSignal).toHaveBeenCalledWith({
        accountId: 'acc-1',
        queryId: 'query-1',
        memoryId: 'mem-1',
        signalType: RetrievalSignalType.EXPLICIT_HIT,
        weight: 2.0,
        metadata: undefined,
      });
    });

    it('should log an EXPLICIT_MISS signal with default weight -2.0', async () => {
      mockService.logSignal.mockResolvedValue('sig-2');

      await controller.submitFeedback(
        {
          queryId: 'query-2',
          signal: FeedbackSignalType.EXPLICIT_MISS,
        },
        { accountId: 'acc-2' },
      );

      expect(mockService.logSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          signalType: RetrievalSignalType.EXPLICIT_MISS,
          weight: -2.0,
        }),
      );
    });

    it('should use custom weight when provided', async () => {
      mockService.logSignal.mockResolvedValue('sig-3');

      await controller.submitFeedback(
        {
          queryId: 'query-3',
          signal: FeedbackSignalType.EXPLICIT_PARTIAL,
          weight: -1.0,
        },
        { accountId: 'acc-3' },
      );

      expect(mockService.logSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          weight: -1.0,
        }),
      );
    });

    it('should fall back to agent accountId if req.accountId is not present', async () => {
      mockService.logSignal.mockResolvedValue('sig-4');

      await controller.submitFeedback(
        {
          queryId: 'query-4',
          signal: FeedbackSignalType.EXPLICIT_HIT,
        },
        { user: { accountId: 'acc-from-user' } },
      );

      expect(mockService.logSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: 'acc-from-user',
        }),
      );
    });

    it('should pass metadata through to signal', async () => {
      mockService.logSignal.mockResolvedValue('sig-5');

      const metadata = { sessionId: 'sess-1', context: 'test' };
      await controller.submitFeedback(
        {
          queryId: 'query-5',
          signal: FeedbackSignalType.EXPLICIT_IRRELEVANT,
          metadata,
        },
        { accountId: 'acc-5' },
      );

      expect(mockService.logSignal).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata,
          signalType: RetrievalSignalType.EXPLICIT_IRRELEVANT,
          weight: -1.5,
        }),
      );
    });
  });
});
