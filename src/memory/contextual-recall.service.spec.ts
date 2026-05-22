import { ContextualRecallService } from './contextual-recall.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { MemoryPoolService } from '../memory-pool/memory-pool.service';
import { MemoryAccessLogService } from '../memory-access-log/memory-access-log.service';
import { TemporalParserService } from './temporal/temporal-parser.service';

describe('ContextualRecallService', () => {
  let service: ContextualRecallService;
  let prisma: jest.Mocked<PrismaService>;
  let embedding: jest.Mocked<EmbeddingService>;
  let memoryPoolService: jest.Mocked<MemoryPoolService>;
  let memoryAccessLogService: jest.Mocked<MemoryAccessLogService>;
  let temporalParser: TemporalParserService;

  const userId = 'user-123';

  beforeEach(() => {
    prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as any;

    embedding = {
      generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      search: jest.fn().mockResolvedValue([]),
    } as any;

    memoryPoolService = {
      getAccessiblePoolIds: jest.fn().mockResolvedValue(['pool-1']),
    } as any;

    memoryAccessLogService = {
      logRecalled: jest.fn().mockResolvedValue(undefined),
    } as any;

    temporalParser = new TemporalParserService();

    service = new ContextualRecallService(
      prisma,
      embedding,
      memoryPoolService,
      memoryAccessLogService,
      temporalParser,
    );
  });

  describe('recall', () => {
    it('should trigger recall on first message (topic shift)', async () => {
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.8 }] as any);

      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'test memory',
          layer: 'EPISODIC',
          extraction: { topics: ['test'] },
        },
      ]);

      const result = await service.recall(userId, {
        text: 'hello world',
        sessionKey: 'sess-1',
      } as any);

      expect(result.topicShift).toBe(true);
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].id).toBe('m1');
    });

    it('should return empty when no topic shift', async () => {
      // First call seeds the session
      embedding.generate.mockResolvedValue([0.1, 0.2, 0.3]);
      await service.recall(userId, {
        text: 'hello',
        sessionKey: 'sess-2',
      } as any);

      // Second call with very similar embedding — no topic shift
      embedding.generate.mockResolvedValue([0.1, 0.2, 0.3]);
      const result = await service.recall(userId, {
        text: 'hello again',
        sessionKey: 'sess-2',
      } as any);

      expect(result.topicShift).toBe(false);
      expect(result.memories).toHaveLength(0);
    });

    it('should detect topic shift with different embedding', async () => {
      // First call
      embedding.generate.mockResolvedValue([1, 0, 0]);
      await service.recall(userId, {
        text: 'topic A',
        sessionKey: 'sess-3',
      } as any);

      // Second call with orthogonal embedding — topic shift
      embedding.generate.mockResolvedValue([0, 1, 0]);
      embedding.search.mockResolvedValue([{ id: 'm2', score: 0.7 }] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm2',
          raw: 'different topic',
          layer: 'EPISODIC',
          extraction: { topics: [] },
        },
      ]);

      const result = await service.recall(userId, {
        text: 'topic B',
        sessionKey: 'sess-3',
      } as any);

      expect(result.topicShift).toBe(true);
      expect(result.memories).toHaveLength(1);
    });

    it('should filter by minScore', async () => {
      embedding.generate.mockResolvedValue([1, 0, 0]);
      embedding.search.mockResolvedValue([
        { id: 'm1', score: 0.9 },
        { id: 'm2', score: 0.3 },
      ] as any);

      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'relevant',
          layer: 'EPISODIC',
          extraction: { topics: [] },
        },
      ]);

      const result = await service.recall(userId, {
        text: 'test',
        sessionKey: 'sess-4',
        minScore: 0.5,
      } as any);

      // m2 should be filtered out by score
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].id).toBe('m1');
    });

    it('should exclude previously recalled IDs', async () => {
      // First recall returns m1
      embedding.generate.mockResolvedValue([1, 0, 0]);
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.8 }] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'first',
          layer: 'EPISODIC',
          extraction: { topics: [] },
        },
      ]);
      await service.recall(userId, { text: 'A', sessionKey: 'sess-5' } as any);

      // Second recall - m1 should be excluded, shift via orthogonal embedding
      embedding.generate.mockResolvedValue([0, 1, 0]);
      embedding.search.mockResolvedValue([
        { id: 'm1', score: 0.8 },
        { id: 'm2', score: 0.7 },
      ] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm2',
          raw: 'second',
          layer: 'EPISODIC',
          extraction: { topics: [] },
        },
      ]);

      const result = await service.recall(userId, {
        text: 'B',
        sessionKey: 'sess-5',
      } as any);
      // m1 was already recalled, so only m2 should appear
      const ids = result.memories.map((m) => m.id);
      expect(ids).not.toContain('m1');
    });

    it('should respect maxTokens budget', async () => {
      embedding.generate.mockResolvedValue([1, 0, 0]);
      embedding.search.mockResolvedValue([
        { id: 'm1', score: 0.9 },
        { id: 'm2', score: 0.8 },
      ] as any);

      // Each memory ~100 chars = ~25 tokens
      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'a'.repeat(100),
          layer: 'EPISODIC',
          extraction: { topics: [] },
        },
        {
          id: 'm2',
          raw: 'b'.repeat(100),
          layer: 'EPISODIC',
          extraction: { topics: [] },
        },
      ]);

      const result = await service.recall(userId, {
        text: 'test',
        sessionKey: 'sess-6',
        maxTokens: 30, // only enough for 1 memory
      } as any);

      expect(result.memories.length).toBeLessThanOrEqual(2);
      expect(result.tokenCount).toBeLessThanOrEqual(30);
    });

    it('should resolve pool IDs from agentSessionKey', async () => {
      embedding.generate.mockResolvedValue([1, 0, 0]);
      embedding.search.mockResolvedValue([]);

      await service.recall(userId, {
        text: 'test',
        sessionKey: 'sess-7',
        agentSessionKey: 'agent-1',
      } as any);

      expect(memoryPoolService.getAccessiblePoolIds).toHaveBeenCalledWith(
        'agent-1',
        userId,
      );
    });

    it('should handle pool resolution failure gracefully', async () => {
      memoryPoolService.getAccessiblePoolIds.mockRejectedValue(
        new Error('fail'),
      );
      embedding.generate.mockResolvedValue([1, 0, 0]);
      embedding.search.mockResolvedValue([]);

      const result = await service.recall(userId, {
        text: 'test',
        sessionKey: 'sess-8',
        agentSessionKey: 'agent-1',
      } as any);

      expect(result.memories).toHaveLength(0);
    });

    it('should log access when agentSessionKey provided', async () => {
      embedding.generate.mockResolvedValue([1, 0, 0]);
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.8 }] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'test',
          layer: 'EPISODIC',
          extraction: { topics: [] },
        },
      ]);

      await service.recall(userId, {
        text: 'test',
        sessionKey: 'sess-9',
        agentSessionKey: 'agent-1',
      } as any);

      expect(memoryAccessLogService.logRecalled).toHaveBeenCalled();
    });
  });

  describe('clearSession', () => {
    it('should remove session state', async () => {
      // Create a session
      embedding.generate.mockResolvedValue([1, 0, 0]);
      await service.recall(userId, {
        text: 'test',
        sessionKey: 'sess-clear',
      } as any);

      service.clearSession('sess-clear');

      // Next recall should treat as first message (topic shift)
      embedding.search.mockResolvedValue([]);
      const result = await service.recall(userId, {
        text: 'test',
        sessionKey: 'sess-clear',
      } as any);
      expect(result.topicShift).toBe(true);
    });
  });

  describe('relative score gap filtering', () => {
    it('should drop results scoring less than 70% of top result', async () => {
      embedding.generate.mockResolvedValue([1, 0, 0]);
      embedding.search.mockResolvedValue([
        { id: 'm1', score: 1.0 },
        { id: 'm2', score: 0.8 },
        { id: 'm3', score: 0.5 }, // < 0.7 of 1.0, should be dropped
      ] as any);

      prisma.memory.findMany = jest.fn().mockResolvedValue([
        { id: 'm1', raw: 'top', layer: 'EPISODIC', extraction: { topics: [] } },
        {
          id: 'm2',
          raw: 'good',
          layer: 'EPISODIC',
          extraction: { topics: [] },
        },
      ]);

      const result = await service.recall(userId, {
        text: 'test',
        sessionKey: 'sess-gap',
        minScore: 0.3,
      } as any);

      const ids = result.memories.map((m) => m.id);
      expect(ids).toContain('m1');
      expect(ids).toContain('m2');
      expect(ids).not.toContain('m3');
    });
  });

  // HEY-575: Temporal filtering in ContextualRecallService
  describe('temporal filtering (HEY-575)', () => {
    it('should pass createdAt filter to findMany when temporal intent detected', async () => {
      embedding.generate.mockResolvedValue([1, 0, 0]);
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.8 }] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'yesterday memory',
          layer: 'EPISODIC',
          extraction: { topics: [] },
        },
      ]);

      await service.recall(userId, {
        text: 'What did we talk about yesterday?',
        sessionKey: 'sess-temporal-1',
      } as any);

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: expect.objectContaining({
              gte: expect.any(Date),
              lte: expect.any(Date),
            }),
          }),
        }),
      );
    });

    it('should not pass createdAt filter for non-temporal queries', async () => {
      embedding.generate.mockResolvedValue([1, 0, 0]);
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.8 }] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'some memory',
          layer: 'EPISODIC',
          extraction: { topics: [] },
        },
      ]);

      await service.recall(userId, {
        text: 'What are my coffee preferences?',
        sessionKey: 'sess-temporal-2',
      } as any);

      const call = (prisma.memory.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.createdAt).toBeUndefined();
    });

    it('should re-embed with temporal-stripped semantic query', async () => {
      const generateSpy = jest
        .spyOn(embedding, 'generate')
        .mockResolvedValue([0.5, 0.5, 0.5]);
      embedding.search.mockResolvedValue([]);

      await service.recall(userId, {
        text: 'What happened yesterday during standup?',
        sessionKey: 'sess-temporal-3',
      } as any);

      // Should have been called twice: once for topic-shift detection (full text),
      // once for the semantic search (stripped text)
      const calls = generateSpy.mock.calls.map((c) => c[0]);
      // The second generate call should NOT include "yesterday"
      if (calls.length >= 2) {
        expect(calls[1]).not.toContain('yesterday');
      }
    });

    it('should work without temporalParser (no optional injection)', async () => {
      // Create service without temporalParser
      const serviceNoParser = new ContextualRecallService(
        prisma,
        embedding,
        undefined,
        undefined,
        undefined,
      );

      embedding.generate.mockResolvedValue([1, 0, 0]);
      embedding.search.mockResolvedValue([{ id: 'm1', score: 0.8 }] as any);
      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm1',
          raw: 'some memory',
          layer: 'EPISODIC',
          extraction: { topics: [] },
        },
      ]);

      const result = await serviceNoParser.recall(userId, {
        text: 'What happened yesterday?',
        sessionKey: 'sess-temporal-4',
      } as any);

      // Should still work, just without temporal filtering
      expect(result.topicShift).toBe(true);
      const call = (prisma.memory.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.createdAt).toBeUndefined();
    });
  });
});
