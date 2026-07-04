import { Test, TestingModule } from '@nestjs/testing';
import {
  ConversationObserverService,
  ObserveContext,
} from './conversation-observer.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { ImportanceDetectorService } from './importance-detector.service';
import { AutoExtractorService } from './auto-extractor.service';
import { SummarizationService } from '../summarization/summarization.service';
import { MemoryLayer, ImportanceHint } from '@prisma/client';
import { ObserveDto, MessageRole, ImportanceSignal } from './dto/observe.dto';

describe('ConversationObserverService', () => {
  let service: ConversationObserverService;
  let mockPrisma: any;
  let mockMemoryService: any;
  let mockImportanceDetector: any;
  let mockAutoExtractor: any;
  let mockSummarizationService: any;

  beforeEach(async () => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
      },
    };

    mockMemoryService = {
      remember: jest.fn().mockResolvedValue({ id: 'mem-1' }),
    };

    mockImportanceDetector = {
      detect: jest.fn().mockReturnValue([]),
      calculateImportance: jest.fn().mockReturnValue(0.5),
    };

    mockAutoExtractor = {
      extract: jest.fn().mockResolvedValue([]),
    };

    mockSummarizationService = {
      isEnabled: false,
      addTurnsToBuffer: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationObserverService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MemoryService, useValue: mockMemoryService },
        {
          provide: ImportanceDetectorService,
          useValue: mockImportanceDetector,
        },
        { provide: AutoExtractorService, useValue: mockAutoExtractor },
        { provide: SummarizationService, useValue: mockSummarizationService },
      ],
    }).compile();

    service = module.get<ConversationObserverService>(
      ConversationObserverService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('observe', () => {
    const userId = 'user-1';
    const basicDto: ObserveDto = {
      turns: [
        { role: MessageRole.USER, content: 'My name is Alice' },
        {
          role: MessageRole.ASSISTANT,
          content: 'Nice to meet you, Alice!',
        },
      ],
    };

    it('should return empty result when no memories extracted', async () => {
      mockAutoExtractor.extract.mockResolvedValue([]);

      const result = await service.observe(userId, basicDto);

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.memories).toEqual([]);
      expect(result.processingMs).toBeGreaterThanOrEqual(0);
    });

    it('should extract and store memories above importance threshold', async () => {
      const extracted = [
        {
          content: 'User name is Alice',
          importance: 0.8,
          signals: [],
          source: { turnIndex: 0, role: MessageRole.USER },
        },
      ];
      mockAutoExtractor.extract.mockResolvedValue(extracted);

      const result = await service.observe(userId, basicDto);

      expect(result.created).toBe(1);
      expect(result.memories).toHaveLength(1);
      expect(mockMemoryService.remember).toHaveBeenCalledTimes(1);
    });

    it('should skip memories below importance threshold', async () => {
      const extracted = [
        {
          content: 'User said hello',
          importance: 0.2,
          signals: [],
          source: { turnIndex: 0, role: MessageRole.USER },
        },
      ];
      mockAutoExtractor.extract.mockResolvedValue(extracted);

      const result = await service.observe(userId, basicDto);

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockMemoryService.remember).not.toHaveBeenCalled();
    });

    it('should use custom minImportance threshold', async () => {
      const extracted = [
        {
          content: 'Moderate importance fact',
          importance: 0.35,
          signals: [],
          source: { turnIndex: 0, role: MessageRole.USER },
        },
      ];
      mockAutoExtractor.extract.mockResolvedValue(extracted);

      const result = await service.observe(userId, {
        ...basicDto,
        minImportance: 0.3,
      });

      expect(result.created).toBe(1);
    });

    it('should look up user name when not provided in context', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        displayName: 'Alice',
        externalId: 'alice-ext',
      });
      mockAutoExtractor.extract.mockResolvedValue([]);

      await service.observe(userId, basicDto);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: userId },
        select: { externalId: true, displayName: true },
      });
    });

    it('should use context userName when provided', async () => {
      mockAutoExtractor.extract.mockResolvedValue([]);

      await service.observe(userId, basicDto, { userName: 'Alice' });

      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('should pass signals to extractor', async () => {
      const signals: ImportanceSignal[] = [
        {
          type: 'preference',
          trigger: 'I prefer',
          content: 'dark mode',
          turnIndex: 0,
          confidence: 0.9,
        },
      ];
      mockImportanceDetector.detect.mockReturnValue(signals);
      mockAutoExtractor.extract.mockResolvedValue([]);

      await service.observe(userId, basicDto);

      expect(mockAutoExtractor.extract).toHaveBeenCalledWith(
        basicDto.turns,
        signals,
        expect.objectContaining({ timestamp: expect.any(Date) }),
      );
    });

    it('should handle memory store failures gracefully', async () => {
      const extracted = [
        {
          content: 'Fact 1',
          importance: 0.8,
          signals: [],
          source: { turnIndex: 0, role: MessageRole.USER },
        },
        {
          content: 'Fact 2',
          importance: 0.9,
          signals: [],
          source: { turnIndex: 1, role: MessageRole.USER },
        },
      ];
      mockAutoExtractor.extract.mockResolvedValue(extracted);
      mockMemoryService.remember
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({ id: 'mem-2' });

      const result = await service.observe(userId, basicDto);

      // Should still create the second memory despite first failing
      expect(result.created).toBe(1);
    });

    it('should pass poolId and agentSessionKey to remember', async () => {
      const extracted = [
        {
          content: 'A fact',
          importance: 0.8,
          signals: [],
          source: { turnIndex: 0, role: MessageRole.USER },
        },
      ];
      mockAutoExtractor.extract.mockResolvedValue(extracted);

      await service.observe(userId, {
        ...basicDto,
        poolId: 'pool-1',
        agentSessionKey: 'session-key-1',
      });

      expect(mockMemoryService.remember).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          poolId: 'pool-1',
          agentSessionKey: 'session-key-1',
        }),
      );
    });

    it('should use sessionId as the agent session key when explicit key is absent', async () => {
      const extracted = [
        {
          content: 'A fact',
          importance: 0.8,
          signals: [],
          source: { turnIndex: 0, role: MessageRole.USER },
        },
      ];
      mockAutoExtractor.extract.mockResolvedValue(extracted);

      await service.observe(userId, {
        ...basicDto,
        sessionId: 'openclaw-session-key',
      });

      expect(mockMemoryService.remember).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          context: expect.objectContaining({
            sessionId: 'openclaw-session-key',
          }),
          agentSessionKey: 'openclaw-session-key',
        }),
      );
    });

    describe('with summarization enabled', () => {
      beforeEach(() => {
        mockSummarizationService.isEnabled = true;
      });

      it('should use summarization when enabled and sessionId provided', async () => {
        mockSummarizationService.addTurnsToBuffer.mockResolvedValue({
          facts: [
            {
              content: 'Alice is the user',
              confidence: 0.9,
              sourceTurnIndices: [0],
            },
          ],
          created: 1,
          processingMs: 50,
        });

        const result = await service.observe(userId, {
          ...basicDto,
          sessionId: 'session-1',
        });

        expect(result.created).toBe(1);
        expect(result.memories).toHaveLength(1);
        expect(mockSummarizationService.addTurnsToBuffer).toHaveBeenCalledWith(
          userId,
          'session-1',
          expect.any(Array),
          expect.objectContaining({
            agentSessionKey: 'session-1',
          }),
        );
        expect(mockAutoExtractor.extract).not.toHaveBeenCalled();
      });

      it('should return empty when buffer not full yet', async () => {
        mockSummarizationService.addTurnsToBuffer.mockResolvedValue(null);

        const result = await service.observe(userId, {
          ...basicDto,
          sessionId: 'session-1',
        });

        expect(result.created).toBe(0);
        expect(result.memories).toHaveLength(0);
      });

      it('should fall back to regular path when no sessionId', async () => {
        mockAutoExtractor.extract.mockResolvedValue([]);

        const result = await service.observe(userId, basicDto);

        expect(
          mockSummarizationService.addTurnsToBuffer,
        ).not.toHaveBeenCalled();
        expect(mockAutoExtractor.extract).toHaveBeenCalled();
      });
    });
  });

  describe('analyzeSignals', () => {
    it('should return signals and aggregate importance', () => {
      const signals: ImportanceSignal[] = [
        {
          type: 'explicit',
          trigger: 'remember this',
          content: 'important fact',
          turnIndex: 0,
          confidence: 0.9,
        },
      ];
      mockImportanceDetector.detect.mockReturnValue(signals);
      mockImportanceDetector.calculateImportance.mockReturnValue(0.85);

      const dto: ObserveDto = {
        turns: [
          { role: MessageRole.USER, content: 'Remember this: important fact' },
        ],
      };

      const result = service.analyzeSignals(dto);

      expect(result.signals).toEqual(signals);
      expect(result.aggregateImportance).toBe(0.85);
    });
  });

  describe('layer determination (via storeMemories)', () => {
    it('should assign IDENTITY layer for preference signals', async () => {
      const extracted = [
        {
          content: 'I always use dark mode',
          importance: 0.8,
          signals: [
            {
              type: 'preference',
              trigger: 'always',
              content: 'dark mode',
              turnIndex: 0,
              confidence: 0.8,
            },
          ],
          source: { turnIndex: 0, role: MessageRole.USER },
        },
      ];
      mockAutoExtractor.extract.mockResolvedValue(extracted);

      await service.observe('user-1', {
        turns: [{ role: MessageRole.USER, content: 'I always use dark mode' }],
      });

      expect(mockMemoryService.remember).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          layer: MemoryLayer.IDENTITY,
        }),
      );
    });

    it('should assign PROJECT layer for work-related content', async () => {
      const extracted = [
        {
          content: 'The project deadline is next Friday',
          importance: 0.8,
          signals: [],
          source: { turnIndex: 0, role: MessageRole.USER },
        },
      ];
      mockAutoExtractor.extract.mockResolvedValue(extracted);

      await service.observe('user-1', {
        turns: [
          {
            role: MessageRole.USER,
            content: 'The project deadline is next Friday',
          },
        ],
      });

      expect(mockMemoryService.remember).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          layer: MemoryLayer.PROJECT,
        }),
      );
    });

    it('should default to SESSION layer', async () => {
      const extracted = [
        {
          content: 'The weather is nice today',
          importance: 0.5,
          signals: [],
          source: { turnIndex: 0, role: MessageRole.USER },
        },
      ];
      mockAutoExtractor.extract.mockResolvedValue(extracted);

      await service.observe('user-1', {
        turns: [
          { role: MessageRole.USER, content: 'The weather is nice today' },
        ],
      });

      expect(mockMemoryService.remember).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          layer: MemoryLayer.SESSION,
        }),
      );
    });
  });

  describe('importance hint mapping (via storeMemories)', () => {
    it.each([
      [0.95, ImportanceHint.CRITICAL],
      [0.75, ImportanceHint.HIGH],
      [0.55, ImportanceHint.MEDIUM],
      [0.3, ImportanceHint.LOW],
    ])(
      'should map importance %s to %s hint',
      async (importance, expectedHint) => {
        const extracted = [
          {
            content: 'A fact',
            importance,
            signals: [],
            source: { turnIndex: 0, role: MessageRole.USER },
          },
        ];
        mockAutoExtractor.extract.mockResolvedValue(extracted);

        await service.observe('user-1', {
          turns: [{ role: MessageRole.USER, content: 'test' }],
          minImportance: 0,
        });

        expect(mockMemoryService.remember).toHaveBeenCalledWith(
          'user-1',
          expect.objectContaining({
            importanceHint: expectedHint,
          }),
        );
      },
    );
  });
});
