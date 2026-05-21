import { Test, TestingModule } from '@nestjs/testing';
import { DedupClassificationService } from './dedup-classification.service';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { LLMService } from '../../llm/llm.service';

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
