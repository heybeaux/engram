import { Test, TestingModule } from '@nestjs/testing';
import { SummarizationController } from './summarization.controller';
import { SummarizationService } from './summarization.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('SummarizationController', () => {
  let controller: SummarizationController;
  let service: any;

  beforeEach(async () => {
    service = {
      summarizeAndStore: jest.fn(),
      flushBuffer: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SummarizationController],
      providers: [
        { provide: SummarizationService, useValue: service },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<SummarizationController>(SummarizationController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /v1/summarize', () => {
    it('should call summarizeAndStore with correct params', async () => {
      const dto = {
        turns: [{ role: 'user' as const, content: 'hello' }],
        sessionId: 'sess-1',
        projectId: 'proj-1',
        minImportance: 0.5,
      };
      const expected = { facts: [], created: 0, totalTurns: 1, processingMs: 10 };
      service.summarizeAndStore!.mockResolvedValue(expected as any);

      const result = await controller.summarize('user-1', dto as any);

      expect(service.summarizeAndStore).toHaveBeenCalledWith('user-1', dto.turns, {
        sessionId: 'sess-1',
        projectId: 'proj-1',
        minImportance: 0.5,
      });
      expect(result).toEqual(expected);
    });

    it('should pass undefined for optional fields when not provided', async () => {
      const dto = {
        turns: [{ role: 'assistant' as const, content: 'hi' }],
      };
      const expected = { facts: [], created: 0, totalTurns: 1, processingMs: 5 };
      service.summarizeAndStore!.mockResolvedValue(expected as any);

      await controller.summarize('user-2', dto as any);

      expect(service.summarizeAndStore).toHaveBeenCalledWith('user-2', dto.turns, {
        sessionId: undefined,
        projectId: undefined,
        minImportance: undefined,
      });
    });

    it('should propagate service errors', async () => {
      service.summarizeAndStore!.mockRejectedValue(new Error('LLM timeout'));
      const dto = { turns: [{ role: 'user' as const, content: 'test' }] };

      await expect(controller.summarize('user-1', dto as any)).rejects.toThrow('LLM timeout');
    });
  });

  describe('POST /v1/summarize/session/:sessionId', () => {
    it('should return flush result when buffer has data', async () => {
      const expected = { facts: [{ content: 'fact1' }], created: 1, totalTurns: 3, processingMs: 50 };
      service.flushBuffer!.mockResolvedValue(expected as any);

      const result = await controller.summarizeSession('user-1', 'sess-1');

      expect(service.flushBuffer).toHaveBeenCalledWith('user-1', 'sess-1');
      expect(result).toEqual(expected);
    });

    it('should return empty result when flushBuffer returns null', async () => {
      service.flushBuffer!.mockResolvedValue(null as any);

      const result = await controller.summarizeSession('user-1', 'sess-empty');

      expect(result).toEqual({
        facts: [],
        created: 0,
        totalTurns: 0,
        processingMs: 0,
      });
    });

    it('should return empty result when flushBuffer returns undefined', async () => {
      service.flushBuffer!.mockResolvedValue(undefined as any);

      const result = await controller.summarizeSession('user-1', 'sess-none');

      expect(result).toEqual({
        facts: [],
        created: 0,
        totalTurns: 0,
        processingMs: 0,
      });
    });

    it('should propagate service errors', async () => {
      service.flushBuffer!.mockRejectedValue(new Error('Redis down'));

      await expect(controller.summarizeSession('user-1', 'sess-1')).rejects.toThrow('Redis down');
    });
  });
});
