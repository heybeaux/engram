/**
 * Research: RECALL_LEXICAL_COVERAGE_FLOOR / RECALL_RESCUE_SQL_TIEBREAK.
 *
 * Two defects, measured on the noisy mnemon corpus and written up in
 * docs/research/memory-formation-query-transform/06-finding-rescue-admission.md.
 *
 * Defect A — one 71-character junk memory held rank 0 on 20/20 benchmark
 * queries. NOT `ts_rank` short-document bias, as originally hypothesised: the
 * `OR`-joined ILIKE rescue promotes a row matching ONE of eight extracted terms
 * into the (1.00, 1.10] band, above every cosine hit. The coverage floor alone
 * takes gold@1 from 0/20 to 14/20.
 *
 * Defect B — the rescue SQL has no tiebreak, so which member of a cluster of
 * equally-ranked rows survives `LIMIT 100` / `LIMIT 20` is decided by Postgres'
 * physical row order and changes across restarts. Measured on repeat runs of
 * the same build: 28 and 104 top-10 slot changes with the flag off, 0 and 0
 * with it on.
 *
 * Every test pins BOTH states: flag off must reproduce shipped behaviour
 * exactly, flag on must fix the defect.
 */
import { MemoryQueryService } from './memory-query.service';
import { MemoryQueryRankingService } from './memory-query-ranking.service';
import { MemoryQueryContextService } from './memory-query-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { TemporalParserService } from './temporal/temporal-parser.service';
import { RecallWeightService } from './recall-weight.service';

/** Eight rescue terms survive extraction (length >= 4, not a stop word). */
const QUERY = 'benchmark project fact user creation endpoint schema validation';
const POOL_SIZE = 10;

/** The junk memory's stand-in: matches exactly one of the eight terms. */
const JUNK_ID = 'junk';

interface Harness {
  service: MemoryQueryService;
  ranking: MemoryQueryRankingService;
  sql: string[];
}

function harness(): Harness {
  const memories = [
    ...Array.from({ length: POOL_SIZE }, (_, i) => ({
      id: `m${String(i).padStart(3, '0')}`,
      raw: `memory ${i} about ${QUERY}`,
      userId: 'user-1',
      importanceScore: 0.5,
      effectiveScore: 0.5,
      createdAt: new Date(2026, 0, 1 + i),
      extraction: {},
    })),
    {
      id: JUNK_ID,
      raw: 'benchmark is a person known to cmt69v4ei000e82c9zkmqraa4.',
      userId: 'user-1',
      importanceScore: 0.5,
      effectiveScore: 0.5,
      createdAt: new Date(2026, 0, 1),
      extraction: {},
    },
  ];

  const sql: string[] = [];
  const prisma = {
    memory: {
      findMany: jest.fn().mockResolvedValue(memories),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $queryRawUnsafe: jest.fn().mockImplementation((statement: string) => {
      sql.push(statement);
      // FTS finds nothing (websearch_to_tsquery is AND-joined, and the junk row
      // shares only one term), so the ILIKE pass is the only rescue in play.
      if (statement.includes('ts_rank')) return Promise.resolve([]);
      return Promise.resolve([{ id: JUNK_ID, match_count: 1 }]);
    }),
  } as any as PrismaService;

  const embedding = {
    generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    generateForRecall: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    // Junk is the WORST semantic match in the pool. Anything that puts it on
    // top did so lexically.
    search: jest.fn().mockImplementation(() =>
      Promise.resolve([
        ...Array.from({ length: POOL_SIZE }, (_, i) => ({
          id: `m${String(i).padStart(3, '0')}`,
          score: 0.9 - i * 0.01,
        })),
        { id: JUNK_ID, score: 0.1 },
      ]),
    ),
  } as any as EmbeddingService;

  const temporalParser = {
    parse: jest
      .fn()
      .mockReturnValue({ semanticQuery: QUERY, temporalFilter: null }),
  } as any as TemporalParserService;

  const recallWeightService = {
    recallWeight: jest.fn().mockReturnValue(1.0),
    applyUsageWeighting: jest
      .fn()
      .mockImplementation((mems: any[]) => Promise.resolve(mems)),
  } as any as RecallWeightService;

  const ranking = new MemoryQueryRankingService(
    prisma,
    embedding,
    recallWeightService,
  );
  jest
    .spyOn(ranking, 'surfaceInsights')
    .mockImplementation((existing: any) => Promise.resolve(existing));

  const service = new MemoryQueryService(
    prisma,
    embedding,
    temporalParser,
    recallWeightService,
    ranking,
    new MemoryQueryContextService(prisma),
  );

  return { service, ranking, sql };
}

async function pageIds(service: MemoryQueryService): Promise<string[]> {
  const res = await service.recall('user-1', {
    query: QUERY,
    limit: 5,
  } as any);
  return res.memories.map((m) => m.id);
}

describe('recall ranking: defect A + B research flags', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  describe('RECALL_LEXICAL_COVERAGE_FLOOR (defect A, part 1)', () => {
    it('flag OFF: one matched term of eight still wins rank 0 (the defect)', async () => {
      delete process.env.RECALL_LEXICAL_COVERAGE_FLOOR;
      const { service } = harness();
      const ids = await pageIds(service);
      expect(ids[0]).toBe(JUNK_ID);
    });

    it('flag ON: the one-term match is not promoted above the cosine ceiling', async () => {
      process.env.RECALL_LEXICAL_COVERAGE_FLOOR = 'true';
      const { service } = harness();
      const ids = await pageIds(service);
      expect(ids[0]).toBe('m000');
      expect(ids).not.toContain(JUNK_ID);
    });

    it('flag ON: the row is demoted, not deleted — it stays in the deep pool', async () => {
      process.env.RECALL_LEXICAL_COVERAGE_FLOOR = 'true';
      const { service } = harness();
      const res = await service.recall('user-1', {
        query: QUERY,
        limit: 50,
      } as any);
      expect(res.memories.map((m) => m.id)).toContain(JUNK_ID);
    });
  });

  describe('RECALL_RESCUE_SQL_TIEBREAK (defect B)', () => {
    it('flag OFF: rescue SQL emits no id tiebreak (shipped statements)', async () => {
      delete process.env.RECALL_RESCUE_SQL_TIEBREAK;
      const { service, sql } = harness();
      await pageIds(service);
      expect(sql.length).toBeGreaterThan(0);
      for (const statement of sql) {
        expect(statement).not.toMatch(/id ASC/);
      }
    });

    it('flag ON: every rescue ORDER BY ends with a unique-key tiebreak', async () => {
      process.env.RECALL_RESCUE_SQL_TIEBREAK = 'true';
      const { service, sql } = harness();
      await pageIds(service);
      const ordered = sql.filter((s) => s.includes('ORDER BY'));
      expect(ordered.length).toBeGreaterThan(0);
      for (const statement of ordered) {
        expect(statement).toMatch(/ORDER BY[^;]*?id ASC\s*\n?\s*LIMIT/);
      }
    });
  });

  describe('all flags off', () => {
    it('leaves the shipped ordering untouched', async () => {
      delete process.env.RECALL_LEXICAL_COVERAGE_FLOOR;
      delete process.env.RECALL_RESCUE_SQL_TIEBREAK;
      const { service, sql } = harness();
      const ids = await pageIds(service);
      expect(ids[0]).toBe(JUNK_ID);
      expect(sql.join('\n')).not.toMatch(/id ASC/);
    });
  });
});
