/**
 * Research: RECALL_RERANK_SCALE_FIX / RECALL_NO_RESCUE.
 *
 * The defect under test: `applyReranking` rescales every candidate to a
 * post-rerank scale (≤ ~1.0), and the sticky keyword re-add then re-injects
 * rescued candidates at their RAW pre-rerank band scores (1.25 / 1.15 / 1.05).
 * Raw values are sorted against rescaled ones, the band always wins, and the
 * page therefore depends on `limit` in a non-monotonic way: at `limit=K` the
 * page is band hits, at `limit=poolSize` the same query returns a purely
 * reranked ordering because nothing was "missing" to re-add.
 *
 * These tests pin both the defect (flag off — shipped behaviour must not move)
 * and the invariant the fix buys (flag on — prefix property in `limit`).
 */
import { MemoryQueryService } from './memory-query.service';
import { MemoryQueryRankingService } from './memory-query-ranking.service';
import { MemoryQueryContextService } from './memory-query-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { TemporalParserService } from './temporal/temporal-parser.service';
import { RecallWeightService } from './recall-weight.service';

const QUERY = 'benchmark project fact user creation endpoint';
const POOL_SIZE = 40;

/** Candidate i: descending cosine, so the pure-semantic order is m0, m1, … */
function candidateId(i: number): string {
  return `m${String(i).padStart(3, '0')}`;
}

interface Harness {
  service: MemoryQueryService;
  prisma: any;
}

/**
 * Stand-in for the TEI cross-encoder. Scores by semantic position (candidate 0
 * best), which is the regime the production reranker is in: it overwrites the
 * incoming score entirely, so lexical band values never reach the output scale.
 */
function fakeReranker(): any {
  return {
    rerank: (_q: string, texts: string[]) =>
      Promise.resolve(
        texts.map((t, index) => ({
          index,
          score: 1 - Number(/^memory (\d+)/.exec(t)?.[1] ?? index) * 0.01,
        })),
      ),
  };
}

/**
 * Builds a service over a fixed 40-candidate pool.
 *
 * The lexically-rescued candidates are deliberately the WORST semantic ones
 * (the tail of the pool), which is the situation the corpus actually exhibits:
 * off-topic distractors that happen to restate the query's vocabulary.
 */
function harness(opts: { reranker?: boolean } = {}): Harness {
  const memories = Array.from({ length: POOL_SIZE }, (_, i) => ({
    id: candidateId(i),
    raw: `memory ${i} about ${QUERY}`,
    userId: 'user-1',
    importanceScore: 0.5,
    effectiveScore: 0.5,
    createdAt: new Date(2026, 0, 1 + i),
    extraction: {},
  }));

  // Bottom 10 of the pool are the lexical "rescue" hits.
  const rescuedIds = memories.slice(POOL_SIZE - 10).map((m) => m.id);

  const prisma = {
    memory: {
      findMany: jest.fn().mockResolvedValue(memories),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // First call is FTS (returns {id, ts_rank}); later calls are the ILIKE
    // rescue ({id, match_count}). Returning FTS rows for both is fine — the
    // ILIKE loop only reads `match_count`, which is undefined → clamped.
    $queryRawUnsafe: jest.fn().mockImplementation(() =>
      Promise.resolve(
        rescuedIds.map((id, i) => ({
          id,
          ts_rank: 1 - i * 0.01,
          match_count: 3,
        })),
      ),
    ),
  } as any as PrismaService;

  const embedding = {
    generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    generateForRecall: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    search: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          memories.map((m, i) => ({ id: m.id, score: 0.9 - i * 0.01 })),
        ),
      ),
  } as any as EmbeddingService;

  const temporalParser = {
    parse: jest.fn().mockReturnValue({
      semanticQuery: QUERY,
      temporalFilter: null,
    }),
  } as any as TemporalParserService;

  const recallWeightService = {
    recallWeight: jest.fn().mockReturnValue(1.0),
    applyUsageWeighting: jest
      .fn()
      .mockImplementation((mems: any[]) => Promise.resolve(mems)),
  } as any as RecallWeightService;

  const rankingService = new MemoryQueryRankingService(
    prisma,
    embedding,
    recallWeightService,
    opts.reranker ? fakeReranker() : undefined,
  );
  // Insight surfacing / graph merge are separate stages with their own
  // `limit`-dependent fetches; neutralise them so this test isolates the
  // rerank ↔ re-add interaction.
  jest
    .spyOn(rankingService, 'surfaceInsights')
    .mockImplementation((existing: any) => Promise.resolve(existing));

  const contextService = new MemoryQueryContextService(prisma);

  const service = new MemoryQueryService(
    prisma,
    embedding,
    temporalParser,
    recallWeightService,
    rankingService,
    contextService,
  );

  return { service, prisma };
}

async function page(
  service: MemoryQueryService,
  limit: number,
): Promise<Array<{ id: string; score: number }>> {
  const res = await service.recall('user-1', { query: QUERY, limit } as any);
  return res.memories.map((m) => ({ id: m.id, score: m.score as number }));
}

async function pageIds(
  service: MemoryQueryService,
  limit: number,
): Promise<string[]> {
  return (await page(service, limit)).map((m) => m.id);
}

/**
 * Scale consistency: a memory's score must not depend on the `limit` it was
 * asked for. Any difference means two different scales were emitted for the
 * same candidate — which is exactly the raw-band re-injection defect.
 */
async function scaleDrift(
  service: MemoryQueryService,
  limit: number,
): Promise<number> {
  const shallow = await page(service, limit);
  const deep = new Map((await page(service, POOL_SIZE)).map((m) => [m.id, m]));
  let worst = 0;
  for (const m of shallow) {
    const d = deep.get(m.id);
    if (!d) continue;
    worst = Math.max(worst, Math.abs(m.score - d.score));
  }
  return worst;
}

describe('recall ranking: limit-monotonicity (RECALL_RERANK_SCALE_FIX)', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  describe('default (all research flags off) — shipped behaviour', () => {
    beforeEach(() => {
      delete process.env.RECALL_RERANK_SCALE_FIX;
      delete process.env.RECALL_RELATIVE_RESCUE;
      delete process.env.RECALL_NO_RESCUE;
    });

    it('emits two different scales for the same memory (the defect)', async () => {
      const { service } = harness({ reranker: true });
      // Raw band (~1.05–1.25) in the small page vs rescaled (<1) when deep.
      expect(await scaleDrift(service, 5)).toBeGreaterThan(0.1);
    });

    it('is NOT monotonic in limit (documents the defect)', async () => {
      const { service } = harness({ reranker: true });
      const shallow = await pageIds(service, 5);
      const deep = await pageIds(service, POOL_SIZE);
      expect(shallow).not.toEqual(deep.slice(0, shallow.length));
      // The small page is the lexical tail — the WORST semantic candidates —
      // re-added at raw band scores that outrank every rescaled score.
      expect(shallow.every((id) => Number(id.slice(1)) >= POOL_SIZE - 10)).toBe(
        true,
      );
    });
  });

  describe('RECALL_RERANK_SCALE_FIX=true', () => {
    beforeEach(() => {
      process.env.RECALL_RERANK_SCALE_FIX = 'true';
      delete process.env.RECALL_RELATIVE_RESCUE;
      delete process.env.RECALL_NO_RESCUE;
    });

    it.each([
      ['with cross-encoder', true],
      ['fallback blend only', false],
    ])(
      'top-K of limit=K is the prefix of the deep ranking (%s)',
      async (_label, reranker) => {
        const { service } = harness({ reranker });
        const deep = await pageIds(service, POOL_SIZE);

        for (const k of [1, 3, 5, 10, 20]) {
          const ids = await pageIds(service, k);
          expect(ids).toHaveLength(k);
          expect(ids).toEqual(deep.slice(0, k));
        }
      },
    );

    it('emits one consistent scale: a memory scores the same at any limit', async () => {
      const { service } = harness({ reranker: true });
      expect(await scaleDrift(service, 5)).toBeLessThan(1e-9);
      expect(await scaleDrift(service, 10)).toBeLessThan(1e-9);
    });

    it('puts the best semantic candidates on the page, not the lexical tail', async () => {
      const { service } = harness({ reranker: true });
      expect(await pageIds(service, 5)).toEqual(
        [0, 1, 2, 3, 4].map(candidateId),
      );
    });

    it('still keeps rescued candidates in the pool (sticky, just not raw)', async () => {
      const { service } = harness({ reranker: true });
      const deep = await pageIds(service, POOL_SIZE);
      expect(deep).toHaveLength(POOL_SIZE);
      for (let i = POOL_SIZE - 10; i < POOL_SIZE; i++) {
        expect(deep).toContain(candidateId(i));
      }
    });
  });

  describe('RECALL_NO_RESCUE=true (vector-only control)', () => {
    beforeEach(() => {
      process.env.RECALL_NO_RESCUE = 'true';
      delete process.env.RECALL_RERANK_SCALE_FIX;
      delete process.env.RECALL_RELATIVE_RESCUE;
    });

    it('issues no lexical rescue SQL at all', async () => {
      const { service, prisma } = harness();
      await pageIds(service, 10);
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('returns the pure semantic ordering', async () => {
      const { service } = harness();
      const page = await pageIds(service, 5);
      expect(page).toEqual([0, 1, 2, 3, 4].map(candidateId));
    });
  });
});
