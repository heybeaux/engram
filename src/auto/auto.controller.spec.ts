import { Test, TestingModule } from '@nestjs/testing';
import { AutoController } from './auto.controller';
import { ConversationObserverService } from './conversation-observer.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

describe('AutoController', () => {
  let controller: AutoController;
  let mockObserver: any;

  beforeEach(async () => {
    mockObserver = {
      observe: jest.fn(),
      analyzeSignals: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AutoController],
      providers: [
        { provide: ConversationObserverService, useValue: mockObserver },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AutoController>(AutoController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('observe', () => {
    it('should call observer.observe with userId and dto', async () => {
      const dto = {
        turns: [
          { role: 'user', content: 'Remember my name is Alice' },
          { role: 'assistant', content: 'Got it, Alice!' },
        ],
        sessionId: 'sess-1',
      };
      const expected = {
        memories: [
          {
            content: 'User name is Alice',
            importance: 0.8,
            signals: [],
            source: { turnIndex: 0, role: 'user' },
          },
        ],
        created: 1,
        skipped: 0,
        signals: [],
        processingMs: 42,
      };
      mockObserver.observe.mockResolvedValue(expected);

      const result = await controller.observe('user-1', dto as any);

      expect(result).toEqual(expected);
      expect(mockObserver.observe).toHaveBeenCalledWith('user-1', dto);
    });

    it('should propagate service errors', async () => {
      const dto = { turns: [] };
      mockObserver.observe.mockRejectedValue(new Error('LLM timeout'));

      await expect(controller.observe('user-1', dto as any)).rejects.toThrow(
        'LLM timeout',
      );
    });
  });

  describe('analyze', () => {
    it('should call observer.analyzeSignals and return signals', async () => {
      const dto = {
        turns: [{ role: 'user', content: 'I always use dark mode' }],
      };
      const expected = {
        signals: [
          {
            type: 'preference',
            trigger: 'I always',
            content: 'I always use dark mode',
            turnIndex: 0,
            confidence: 0.9,
          },
        ],
        aggregateImportance: 0.85,
      };
      mockObserver.analyzeSignals.mockResolvedValue(expected);

      const result = await controller.analyze('user-1', dto as any);

      expect(result).toEqual(expected);
      expect(mockObserver.analyzeSignals).toHaveBeenCalledWith(dto);
    });

    it('should return empty signals for no-signal input', async () => {
      const dto = {
        turns: [{ role: 'user', content: 'Hi' }],
      };
      const expected = { signals: [], aggregateImportance: 0 };
      mockObserver.analyzeSignals.mockResolvedValue(expected);

      const result = await controller.analyze('user-1', dto as any);

      expect(result).toEqual(expected);
    });
  });
});
