import {
  gatedLexicalRescue,
  isGatedLexicalRescueEnabled,
  LEXICAL_RESCUE_LIMIT,
  LEXICAL_RESCUE_WINDOW,
} from './lexical-rescue.util';
import { MemoryQueryService } from './memory-query.service';
import { MemoryQueryRankingService } from './memory-query-ranking.service';

const rows = (n: number, prefix = 'w') =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

describe('gatedLexicalRescue (ENG-36 F2)', () => {
  it('excludes hidden rows in both window and trigram rescue', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockImplementation((sql: string) => {
        expect(sql).toContain('user_hidden = false');
        return Promise.resolve([]);
      }),
    };
    const result = await gatedLexicalRescue(prisma, ['user-1'], ['hidden']);
    expect(result.rows).toEqual([]);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  const saved = process.env.RECALL_LEXICAL_RESCUE_GATED;
  afterEach(() => {
    if (saved === undefined) delete process.env.RECALL_LEXICAL_RESCUE_GATED;
    else process.env.RECALL_LEXICAL_RESCUE_GATED = saved;
  });

  it('is off unless the flag is exactly "true"', () => {
    delete process.env.RECALL_LEXICAL_RESCUE_GATED;
    expect(isGatedLexicalRescueEnabled()).toBe(false);
    process.env.RECALL_LEXICAL_RESCUE_GATED = '1';
    expect(isGatedLexicalRescueEnabled()).toBe(false);
    process.env.RECALL_LEXICAL_RESCUE_GATED = 'true';
    expect(isGatedLexicalRescueEnabled()).toBe(true);
  });

  it('stops at the importance window when it fills the limit (common terms)', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue(rows(LEXICAL_RESCUE_LIMIT)),
    };
    const out = await gatedLexicalRescue(prisma, ['u1'], ['work', 'open']);
    expect(out.path).toBe('window');
    expect(out.rows).toHaveLength(LEXICAL_RESCUE_LIMIT);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, users, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain(`LIMIT ${LEXICAL_RESCUE_WINDOW}`);
    expect(sql).toContain('LOWER(raw) LIKE $2 OR LOWER(raw) LIKE $3');
    // Same order inside and outside the window, with a total-order tiebreak.
    expect(
      sql.match(/ORDER BY importance_score DESC, created_at DESC, id ASC/g),
    ).toHaveLength(2);
    expect(users).toEqual(['u1']);
    expect(params).toEqual(['%work%', '%open%']);
  });

  it('falls through to the trigram ILIKE query when the window is short (rare terms)', async () => {
    const prisma = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce(rows(3))
        .mockResolvedValueOnce(rows(7, 't')),
    };
    const out = await gatedLexicalRescue(prisma, ['u1', 'u2'], ['kali']);
    expect(out.path).toBe('trigram');
    expect(out.rows).toEqual(rows(7, 't'));
    const [sql, users, ...params] = prisma.$queryRawUnsafe.mock.calls[1];
    expect(sql).toContain('raw ILIKE $2');
    expect(sql).not.toContain('LOWER(raw)');
    expect(sql).toContain(`LIMIT ${LEXICAL_RESCUE_LIMIT}`);
    expect(sql).toContain("embedding_status != 'DUPLICATE'");
    expect(users).toEqual(['u1', 'u2']);
    expect(params).toEqual(['%kali%']);
  });
});

describe('MemoryQueryService lexical rescue flag wiring (ENG-36 F2)', () => {
  const saved = process.env.RECALL_LEXICAL_RESCUE_GATED;
  afterEach(() => {
    if (saved === undefined) delete process.env.RECALL_LEXICAL_RESCUE_GATED;
    else process.env.RECALL_LEXICAL_RESCUE_GATED = saved;
  });

  async function rescueSql(userId: string | null, extra = {}) {
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
    return prisma.$queryRawUnsafe.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => /LIKE \$|ILIKE \$/.test(sql));
  }

  it('flag off: resolved users keep the single LOWER(raw) LIKE scan', async () => {
    delete process.env.RECALL_LEXICAL_RESCUE_GATED;
    const sqls = await rescueSql('user-a');
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain('LOWER(raw) LIKE');
    expect(sqls[0]).not.toContain(`LIMIT ${LEXICAL_RESCUE_WINDOW}`);
  });

  it('flag on: resolved users take the window then trigram path', async () => {
    process.env.RECALL_LEXICAL_RESCUE_GATED = 'true';
    const sqls = await rescueSql('user-a');
    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toContain(`LIMIT ${LEXICAL_RESCUE_WINDOW}`);
    expect(sqls[1]).toContain('raw ILIKE $2');
  });

  it('flag on: pool-only recall is unchanged', async () => {
    process.env.RECALL_LEXICAL_RESCUE_GATED = 'true';
    const sqls = await rescueSql(null, { poolIds: ['pool-1'] });
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain('LOWER(m.raw) LIKE');
  });
});
