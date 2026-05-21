import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HypeService } from './hype.service';
import { LLMService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';

describe('HypeService', () => {
  let service: HypeService;
  let mockLlmService: jest.Mocked<LLMService>;
  let mockPrisma: jest.Mocked<PrismaService>;
  let mockConfig: jest.Mocked<ConfigService>;

  const mockEmbedding = [0.1, 0.2, 0.3];

  beforeEach(async () => {
    mockLlmService = {
      chat: jest.fn(),
      embed: jest.fn(),
    } as any;

    mockPrisma = {
      $executeRawUnsafe: jest.fn(),
    } as any;

    mockConfig = {
      get: jest.fn().mockReturnValue('true'),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HypeService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: LLMService, useValue: mockLlmService },
      ],
    }).compile();

    service = module.get<HypeService>(HypeService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateHypotheticals', () => {
    it('should return questions when LLM returns valid JSON array', async () => {
      const questions = [
        'What does Alice put in her coffee?',
        "What are Alice's food preferences?",
        'Does Alice have any dietary restrictions?',
      ];
      mockLlmService.chat.mockResolvedValue({
        content: JSON.stringify(questions),
        model: 'test',
      });

      const result = await service.generateHypotheticals(
        'Alice prefers oat milk in her coffee',
      );

      expect(result).toEqual(questions);
      expect(mockLlmService.chat).toHaveBeenCalledWith([
        {
          role: 'user',
          content: expect.stringContaining('Alice prefers oat milk'),
        },
      ]);
    });

    it('should return [] when LLM returns malformed JSON', async () => {
      mockLlmService.chat.mockResolvedValue({
        content: 'not valid json',
        model: 'test',
      });

      const result = await service.generateHypotheticals('some content');

      expect(result).toEqual([]);
    });

    it('should return [] when LLM returns non-array JSON', async () => {
      mockLlmService.chat.mockResolvedValue({
        content: '{"key": "value"}',
        model: 'test',
      });

      const result = await service.generateHypotheticals('some content');

      expect(result).toEqual([]);
    });

    it('should return [] when LLM throws', async () => {
      mockLlmService.chat.mockRejectedValue(new Error('LLM unavailable'));

      const result = await service.generateHypotheticals('some content');

      expect(result).toEqual([]);
    });

    it('should return [] when HYPE_ENABLED=false', async () => {
      // Re-create service with HYPE_ENABLED=false
      mockConfig.get.mockReturnValue('false');
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          HypeService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: ConfigService, useValue: mockConfig },
          { provide: LLMService, useValue: mockLlmService },
        ],
      }).compile();
      const disabledService = module.get<HypeService>(HypeService);

      const result =
        await disabledService.generateHypotheticals('some content');

      expect(result).toEqual([]);
      expect(mockLlmService.chat).not.toHaveBeenCalled();
    });

    it('should filter out non-string values from the array', async () => {
      mockLlmService.chat.mockResolvedValue({
        content: '["valid question?", 42, null, "another question?"]',
        model: 'test',
      });

      const result = await service.generateHypotheticals('some content');

      expect(result).toEqual(['valid question?', 'another question?']);
    });

    it('should return [] on timeout', async () => {
      mockLlmService.chat.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ content: '["question"]', model: 'test' }),
              6000,
            ),
          ),
      );

      const result = await service.generateHypotheticals('some content');

      expect(result).toEqual([]);
    }, 10000);
  });

  describe('embedAndStore', () => {
    it('should embed each question and store in memory_embeddings', async () => {
      const hypotheticals = ['What is X?', 'How does Y work?', 'Why Z?'];
      mockLlmService.embed.mockResolvedValue({
        embedding: mockEmbedding,
        dimensions: 3,
        model: 'test-model',
      });

      await service.embedAndStore('mem-1', hypotheticals, 'user-1');

      expect(mockLlmService.embed).toHaveBeenCalledTimes(3);
      expect(mockLlmService.embed).toHaveBeenCalledWith('What is X?');
      expect(mockLlmService.embed).toHaveBeenCalledWith('How does Y work?');
      expect(mockLlmService.embed).toHaveBeenCalledWith('Why Z?');

      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(3);
      for (let i = 0; i < 3; i++) {
        expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO memory_embeddings'),
          'mem-1',
          `hype-${i}`,
          3,
          '[0.1,0.2,0.3]',
          expect.any(Date),
        );
      }
    });

    it('should skip silently when no hypotheticals', async () => {
      await service.embedAndStore('mem-1', [], 'user-1');

      expect(mockLlmService.embed).not.toHaveBeenCalled();
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('should skip silently when LLM unavailable', async () => {
      // Re-create without LLM
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          HypeService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();
      const noLlmService = module.get<HypeService>(HypeService);

      await noLlmService.embedAndStore('mem-1', ['question?'], 'user-1');

      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe('generateAndStore', () => {
    it('should chain generateHypotheticals and embedAndStore', async () => {
      const questions = ['Q1?', 'Q2?', 'Q3?'];
      mockLlmService.chat.mockResolvedValue({
        content: JSON.stringify(questions),
        model: 'test',
      });
      mockLlmService.embed.mockResolvedValue({
        embedding: mockEmbedding,
        dimensions: 3,
        model: 'test-model',
      });

      await service.generateAndStore('mem-1', 'some memory content', 'user-1');

      expect(mockLlmService.chat).toHaveBeenCalledTimes(1);
      expect(mockLlmService.embed).toHaveBeenCalledTimes(3);
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(3);
    });

    it('should be a no-op when HYPE_ENABLED=false', async () => {
      mockConfig.get.mockReturnValue('false');
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          HypeService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: ConfigService, useValue: mockConfig },
          { provide: LLMService, useValue: mockLlmService },
        ],
      }).compile();
      const disabledService = module.get<HypeService>(HypeService);

      await disabledService.generateAndStore('mem-1', 'content', 'user-1');

      expect(mockLlmService.chat).not.toHaveBeenCalled();
      expect(mockLlmService.embed).not.toHaveBeenCalled();
    });
  });
});
