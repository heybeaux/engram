import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SummarizationService } from './summarization.service';
import { LLMService } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { MessageRole } from '../auto/dto/observe.dto';

describe('SummarizationService', () => {
  let service: SummarizationService;
  let llmService: jest.Mocked<Partial<LLMService>>;
  let memoryService: jest.Mocked<Partial<MemoryService>>;
  let configService: Partial<ConfigService>;

  const mockTurns = [
    { role: MessageRole.USER, content: 'I prefer dark mode in all my apps' },
    {
      role: MessageRole.ASSISTANT,
      content: "Noted! I'll remember that preference.",
    },
    {
      role: MessageRole.USER,
      content: 'Also, I live in Vancouver and work at Acme Corp',
    },
    { role: MessageRole.ASSISTANT, content: 'Got it — Vancouver, Acme Corp.' },
    { role: MessageRole.USER, content: "Let's deploy the API on Monday" },
  ];

  const mockLLMResponse = {
    facts: [
      {
        content: 'Beaux prefers dark mode in all applications',
        category: 'preference',
        confidence: 0.9,
        sourceTurnIndices: [0],
      },
      {
        content: 'Beaux lives in Vancouver and works at Acme Corp',
        category: 'fact',
        confidence: 0.95,
        sourceTurnIndices: [2],
      },
      {
        content: 'Deploy the API on Monday',
        category: 'action_item',
        confidence: 0.8,
        sourceTurnIndices: [4],
      },
    ],
  };

  beforeEach(async () => {
    llmService = {
      json: jest.fn().mockResolvedValue(mockLLMResponse),
    };

    memoryService = {
      remember: jest.fn().mockResolvedValue({ id: 'test-id' }),
    };

    configService = {
      get: jest
        .fn()
        .mockImplementation((key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            SUMMARIZATION_ENABLED: 'true',
            SUMMARIZATION_BATCH_SIZE: '5',
          };
          return config[key] ?? defaultValue;
        }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SummarizationService,
        { provide: LLMService, useValue: llmService },
        { provide: MemoryService, useValue: memoryService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<SummarizationService>(SummarizationService);
  });

  describe('summarize', () => {
    it('should extract facts from conversation turns', async () => {
      const facts = await service.summarize(mockTurns, 'Beaux');

      expect(llmService.json).toHaveBeenCalledTimes(1);
      expect(facts).toHaveLength(3);
      expect(facts[0].category).toBe('preference');
      expect(facts[1].category).toBe('fact');
      expect(facts[2].category).toBe('action_item');
    });

    it('should return empty array for empty turns', async () => {
      const facts = await service.summarize([]);
      expect(facts).toEqual([]);
      expect(llmService.json).not.toHaveBeenCalled();
    });

    it('should handle LLM failures gracefully', async () => {
      (llmService.json as jest.Mock).mockRejectedValueOnce(
        new Error('LLM unavailable'),
      );
      const facts = await service.summarize(mockTurns);
      expect(facts).toEqual([]);
    });

    it('should clamp confidence to 0-1', async () => {
      (llmService.json as jest.Mock).mockResolvedValueOnce({
        facts: [
          {
            content: 'test',
            category: 'fact',
            confidence: 1.5,
            sourceTurnIndices: [0],
          },
        ],
      });
      const facts = await service.summarize(mockTurns);
      expect(facts[0].confidence).toBe(1);
    });
  });

  describe('summarizeAndStore', () => {
    it('should store facts as memories', async () => {
      const result = await service.summarizeAndStore('user-1', mockTurns, {
        sessionId: 'session-1',
        userName: 'Beaux',
      });

      expect(result.created).toBe(3);
      expect(result.facts).toHaveLength(3);
      expect(memoryService.remember).toHaveBeenCalledTimes(3);

      // Check source attribution is set
      const firstCall = (memoryService.remember as jest.Mock).mock.calls[0][1];
      expect(firstCall.sourceTurnIndex).toBe(0);
    });

    it('should filter by minImportance', async () => {
      const result = await service.summarizeAndStore('user-1', mockTurns, {
        minImportance: 0.85,
      });

      // Only facts with confidence >= 0.85 (0.9 and 0.95)
      expect(result.created).toBe(2);
    });
  });

  describe('buffer management', () => {
    it('should buffer turns until batch size is reached', async () => {
      // Add 3 turns (below batch size of 5)
      const result1 = await service.addTurnsToBuffer(
        'user-1',
        'session-1',
        mockTurns.slice(0, 3),
      );
      expect(result1).toBeNull();
      expect(await service.getBufferSize('session-1')).toBe(3);

      // Add 2 more to reach batch size
      const result2 = await service.addTurnsToBuffer(
        'user-1',
        'session-1',
        mockTurns.slice(3),
      );
      expect(result2).not.toBeNull();
      expect(result2!.created).toBe(3);
    });

    it('should flush remaining buffer', async () => {
      await service.addTurnsToBuffer(
        'user-1',
        'session-1',
        mockTurns.slice(0, 2),
      );
      expect(await service.getBufferSize('session-1')).toBe(2);

      const result = await service.flushBuffer('user-1', 'session-1');
      expect(result).not.toBeNull();
      expect(await service.getBufferSize('session-1')).toBe(0);
    });

    it('should return null when flushing empty buffer', async () => {
      const result = await service.flushBuffer('user-1', 'nonexistent');
      expect(result).toBeNull();
    });

    it('should not buffer when disabled', async () => {
      // Create a disabled service
      const disabledConfig = {
        get: jest.fn((key: string, defaultValue?: string) => {
          if (key === 'SUMMARIZATION_ENABLED') return 'false';
          return defaultValue;
        }),
      };
      const module = await Test.createTestingModule({
        providers: [
          SummarizationService,
          { provide: LLMService, useValue: llmService },
          { provide: MemoryService, useValue: memoryService },
          { provide: ConfigService, useValue: disabledConfig },
        ],
      }).compile();

      const disabledService =
        module.get<SummarizationService>(SummarizationService);
      const result = await disabledService.addTurnsToBuffer(
        'user-1',
        'session-1',
        mockTurns,
      );
      expect(result).toBeNull();
    });
  });

  describe('shutdown', () => {
    it('should not throw if Redis is already closed during shutdown', async () => {
      const closedRedis = {
        status: 'end',
        keys: jest.fn(),
        quit: jest.fn(),
      };
      (service as any).redis = closedRedis;

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
      expect(closedRedis.keys).not.toHaveBeenCalled();
      expect(closedRedis.quit).not.toHaveBeenCalled();
    });

    it('should skip Redis shutdown flush if listing buffered sessions fails', async () => {
      const redis = {
        status: 'ready',
        keys: jest.fn().mockRejectedValue(new Error('Connection is closed.')),
        quit: jest.fn().mockResolvedValue('OK'),
      };
      (service as any).redis = redis;

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
      expect(redis.keys).toHaveBeenCalledWith('engram:summ:turns:*');
      expect(redis.quit).toHaveBeenCalledTimes(1);
    });
  });

  describe('config', () => {
    it('should read SUMMARIZATION_ENABLED', () => {
      expect(service.isEnabled).toBe(true);
    });

    it('should read SUMMARIZATION_BATCH_SIZE', () => {
      expect(service.getBatchSize).toBe(5);
    });
  });
});
