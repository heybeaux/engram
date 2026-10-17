import { Test, TestingModule } from '@nestjs/testing';
import { DedupClassificationService } from './dedup-classification.service';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { LLMService } from '../../llm/llm.service';
import { ConfigService } from '@nestjs/config';

const mockCandidate = {
  id: 'cand-1',
  memoryId1: 'mem-1',
  memoryId2: 'mem-2',
  similarityScore: 0.92,
  detectionMethod: 'VECTOR',
  status: 'PENDING',
  classification: null,
  confidence: null,
  mergedContent: null,
  reasoning: null,
  classifiedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  memory1: {
    id: 'mem-1',
    raw: 'User prefers dark mode in all applications',
    importanceScore: 0.7,
    source: 'EXPLICIT_STATEMENT',
    createdAt: new Date(),
  },
  memory2: {
    id: 'mem-2',
    raw: 'User likes dark theme in apps',
    importanceScore: 0.6,
    source: 'INFERRED',
    createdAt: new Date(),
  },
};

const mockLlmResponse = {
  content: JSON.stringify({
    classification: 'DUPLICATE',
    confidence: 0.91,
    merged_content: 'User prefers dark mode in all applications',
    reasoning: 'Both memories convey identical preference for dark mode.',
  }),
  model: 'claude-haiku-4-5',
  usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
};

const mockPrisma = {
  dedupCandidate: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
};

const mockLlm = {
  chat: jest.fn(),
  getProvider: jest.fn().mockReturnValue({ name: 'openai' }),
};

describe('DedupClassificationService', () => {
  let service: DedupClassificationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DedupClassificationService,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: LLMService, useValue: mockLlm },
      ],
    }).compile();

    service = module.get<DedupClassificationService>(
      DedupClassificationService,
    );
    jest.clearAllMocks();
  });

  describe('processPendingCandidates', () => {
    it('routes gpt-4o-mini to the registered OpenAI provider, even when Anthropic is registered', async () => {
      const config = {
        get: (key: string) =>
          ({
            OPENAI_API_KEY: 'test-openai-key',
            ANTHROPIC_API_KEY: 'test-anthropic-key',
          })[key],
      } as ConfigService;
      const llm = new LLMService(config);
      const openaiChat = jest
        .spyOn(llm.getProvider('openai')!, 'chat')
        .mockResolvedValue(mockLlmResponse);
      const anthropicChat = jest
        .spyOn(llm.getProvider('anthropic')!, 'chat')
        .mockResolvedValue(mockLlmResponse);
      const classifier = new DedupClassificationService(
        mockPrisma as unknown as ServicePrismaService,
        llm,
      );
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([mockCandidate]);
      mockPrisma.dedupCandidate.update.mockResolvedValue({});

      const result = await classifier.processPendingCandidates();

      expect(result).toEqual({ processed: 1, errors: 0 });
      expect(openaiChat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          provider: 'openai',
          model: 'gpt-4o-mini',
          temperature: 0.2,
          maxTokens: 512,
        }),
      );
      expect(anthropicChat).not.toHaveBeenCalled();
    });

    it('does not send an OpenAI model to Anthropic when OpenAI is unavailable', async () => {
      const config = {
        get: (key: string) =>
          ({
            ANTHROPIC_API_KEY: 'test-anthropic-key',
            LLM_PROVIDER: 'anthropic',
          })[key],
      } as ConfigService;
      const llm = new LLMService(config);
      const anthropicChat = jest
        .spyOn(llm.getProvider('anthropic')!, 'chat')
        .mockResolvedValue(mockLlmResponse);
      const classifier = new DedupClassificationService(
        mockPrisma as unknown as ServicePrismaService,
        llm,
      );
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([mockCandidate]);

      const result = await classifier.processPendingCandidates();

      expect(result).toEqual({ processed: 0, errors: 1 });
      expect(anthropicChat).not.toHaveBeenCalled();
    });
    it('returns zero counts when no pending candidates', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([]);
      const result = await service.processPendingCandidates();
      expect(result.processed).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('classifies a pending candidate and updates it to CLASSIFIED', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([mockCandidate]);
      mockLlm.chat.mockResolvedValue(mockLlmResponse);
      mockPrisma.dedupCandidate.update.mockResolvedValue({});

      const result = await service.processPendingCandidates();

      expect(result.processed).toBe(1);
      expect(result.errors).toBe(0);
      expect(mockPrisma.dedupCandidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cand-1' },
          data: expect.objectContaining({
            status: 'CLASSIFIED',
            classification: 'DUPLICATE',
            confidence: expect.any(Number),
          }),
        }),
      );
    });

    it('counts errors without throwing on LLM failure', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([mockCandidate]);
      mockLlm.chat.mockRejectedValue(new Error('LLM unavailable'));

      const result = await service.processPendingCandidates();
      expect(result.errors).toBe(1);
      expect(result.processed).toBe(0);
    });

    it('handles malformed LLM JSON gracefully', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([mockCandidate]);
      mockLlm.chat.mockResolvedValue({ content: 'not valid json at all' });

      const result = await service.processPendingCandidates();
      expect(result.errors).toBe(1);
    });

    it('rejects invalid classification labels', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([mockCandidate]);
      mockLlm.chat.mockResolvedValue({
        content: JSON.stringify({
          classification: 'INVENTED_LABEL',
          confidence: 0.8,
          reasoning: 'test',
        }),
      });

      const result = await service.processPendingCandidates();
      expect(result.errors).toBe(1);
    });

    it('strips markdown fences from LLM response', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([mockCandidate]);
      mockLlm.chat.mockResolvedValue({
        content: `\`\`\`json\n${JSON.stringify({
          classification: 'RELATED',
          confidence: 0.4,
          reasoning: 'Different topics.',
        })}\n\`\`\``,
      });
      mockPrisma.dedupCandidate.update.mockResolvedValue({});

      const result = await service.processPendingCandidates();
      expect(result.processed).toBe(1);
      expect(result.errors).toBe(0);
    });
  });

  describe('source authority weighting', () => {
    it('builds prompt with signal scores', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([mockCandidate]);
      mockLlm.chat.mockResolvedValue(mockLlmResponse);
      mockPrisma.dedupCandidate.update.mockResolvedValue({});

      await service.processPendingCandidates();

      const callArgs = mockLlm.chat.mock.calls[0][0][0].content as string;
      expect(callArgs).toContain('Semantic similarity');
      expect(callArgs).toContain('Entity overlap');
      expect(callArgs).toContain('Weighted score');
    });
  });
});
