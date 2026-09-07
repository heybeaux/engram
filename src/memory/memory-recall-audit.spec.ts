import { ContextualRecallService } from './contextual-recall.service';
import { MemoryQueryService } from './memory-query.service';
import { MemoryQueryRankingService } from './memory-query-ranking.service';

describe('Recall audit regressions', () => {
  const dto = { text: 'fact', sessionKey: 'shared', maxResults: 1 };
  function context() {
    const prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const embedding = {
      generate: jest.fn().mockResolvedValue([1, 0]),
      search: jest.fn().mockResolvedValue([]),
    };
    return {
      prisma,
      embedding,
      service: new ContextualRecallService(prisma as any, embedding as any),
    };
  }
  it('retries after failed vector retrieval instead of suppressing the topic', async () => {
    const { embedding, service } = context();
    embedding.search.mockRejectedValueOnce(new Error('unavailable'));
    await expect(service.recall('a', dto)).rejects.toThrow('unavailable');
    expect((await service.recall('a', dto)).topicShift).toBe(true);
    expect(embedding.search).toHaveBeenCalledTimes(2);
    expect((await service.recall('a', dto)).topicShift).toBe(false);
  });
  it('isolates identical session keys and clears only the selected user set', async () => {
    const { embedding, service } = context();
    await service.recall(['b', 'a'], dto);
    expect((await service.recall(['a', 'b', 'a'], dto)).topicShift).toBe(false);
    expect((await service.recall('c', dto)).topicShift).toBe(true);
    service.clearSession(['a', 'b'], dto.sessionKey);
    expect((await service.recall('c', dto)).topicShift).toBe(false);
    expect((await service.recall(['b', 'a'], dto)).topicShift).toBe(true);
    expect(embedding.search).toHaveBeenCalledTimes(3);
  });
  it('refills dated search before applying the score gap and result limit', async () => {
    const { prisma, embedding } = context();
    const records = [
      { id: 'old', score: 1, raw: 'old', createdAt: new Date('2020-01-01') },
      {
        id: 'eligible',
        score: 0.6,
        raw: 'fact',
        createdAt: new Date('2026-09-01'),
      },
    ];
    embedding.search.mockImplementation(async (_u, _q, limit) =>
      records.slice(0, limit),
    );
    prisma.memory.findMany.mockImplementation(async ({ where }) =>
      records.filter(
        (m) => where.id.in.includes(m.id) && m.createdAt >= where.createdAt.gte,
      ),
    );
    const parser = {
      parse: () => ({
        semanticQuery: 'fact',
        temporalFilter: {
          start: new Date('2026-09-01'),
          end: new Date('2026-09-07'),
          expression: 'this week',
        },
      }),
    };
    const service = new ContextualRecallService(
      prisma as any,
      embedding as any,
      undefined,
      undefined,
      parser as any,
    );
    expect((await service.recall('a', dto)).memories.map((m) => m.id)).toEqual([
      'eligible',
    ]);
    expect(embedding.search).toHaveBeenCalledTimes(2);
  });
  it('does not commit recalled IDs when bookkeeping fails', async () => {
    const { prisma, embedding, service } = context();
    embedding.search.mockResolvedValue([{ id: 'm', score: 0.9 }]);
    prisma.memory.findMany.mockResolvedValue([{ id: 'm', raw: 'fact' }]);
    prisma.memory.updateMany.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(service.recall('a', dto)).rejects.toThrow('db unavailable');
    expect((await service.recall('a', dto)).memories.map((m) => m.id)).toEqual([
      'm',
    ]);
  });
  it('does not reinsert lexical noise above a stronger reranked match at limit 1', async () => {
    const good = {
      id: 'semantic',
      raw: 'Relevant fact',
      importanceScore: 0.5,
      extraction: {},
      layer: 'SESSION',
    };
    const noise = { ...good, id: 'noise', raw: 'Unrelated keyword' };
    const prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([good, noise]),
        updateMany: jest.fn(),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: noise.id }]),
    };
    const embedding = {
      generateForRecall: jest.fn().mockResolvedValue([1, 0]),
      search: jest.fn().mockResolvedValue([
        { id: good.id, score: 0.99 },
        { id: noise.id, score: 0.1 },
      ]),
    };
    const weights = { applyUsageWeighting: async (m: any) => m };
    const reranker = {
      rerank: async (_q: any, texts: string[]) =>
        texts
          .map((t, index) => ({ index, score: t === good.raw ? 0.9 : 0.01 }))
          .sort((a, b) => b.score - a.score),
    };
    const ranking = new MemoryQueryRankingService(
      prisma as any,
      embedding as any,
      weights as any,
      reranker as any,
    );
    ranking.surfaceInsights = async (m) => m;
    const service = new MemoryQueryService(
      prisma as any,
      embedding as any,
      {
        parse: (q: string) => ({ semanticQuery: q, temporalFilter: null }),
      } as any,
      weights as any,
      ranking,
      {} as any,
    );
    const result = await service.recall('a', {
      query: 'relevant fact',
      limit: 1,
      layers: ['SESSION'],
    } as any);
    expect(result.memories.map((m) => m.id)).toEqual(['semantic']);
  });
});
