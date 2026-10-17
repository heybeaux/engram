import { MemoryQueryService } from './memory-query.service';
import { MemoryQueryRankingService } from './memory-query-ranking.service';

// ENG-27: the BM25/FTS pass must match and rank on the stored search_vector
// column (GIN idx_memories_search_vector). An inline to_tsvector(raw) cannot use
// that index and re-parses every row of the user on each recall.
describe('Recall FTS uses the indexed search_vector column', () => {
  async function ftsSql(userId: string | null, extra: Record<string, unknown>) {
    const prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    };
    const embedding = {
      generateForRecall: jest.fn().mockResolvedValue([1, 0]),
      search: jest.fn().mockResolvedValue([]),
    };
    const weights = { applyUsageWeighting: async (m: any) => m };
    const ranking = new MemoryQueryRankingService(
      prisma as any,
      embedding as any,
      weights as any,
      { rerank: async () => [] } as any,
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
    await service.recall(userId, {
      query: 'coffee preference',
      limit: 5,
      ...extra,
    } as any);
    const calls = prisma.$queryRawUnsafe.mock.calls.map((c) => String(c[0]));
    const fts = calls.filter((sql) => sql.includes('websearch_to_tsquery'));
    expect(fts).toHaveLength(1);
    return fts[0];
  }

  it.each([
    ['resolved user', 'user-a', {}, 'search_vector @@'],
    ['pool-only', null, { poolIds: ['pool-1'] }, 'm.search_vector @@'],
    ['unscoped', null, {}, 'search_vector @@'],
  ])('%s branch', async (_name, userId, extra, predicate) => {
    const sql = await ftsSql(userId, extra);
    expect(sql).toContain(predicate);
    expect(sql).toMatch(/ts_rank\((m\.)?search_vector,/);
    expect(sql).not.toContain('to_tsvector(');
    expect(sql).toContain('user_hidden = false');
  });
});
