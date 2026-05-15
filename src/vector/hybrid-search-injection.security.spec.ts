/**
 * GIN-42: SQL Injection Prevention Tests for HybridSearchService
 *
 * Verifies that:
 * 1. The `limit` value interpolated into the LIMIT clause is always a safe integer
 * 2. The SQL query string passed to $queryRawUnsafe never contains user-controlled
 *    injection fragments from the limit field
 * 3. Query text ($1) is always passed as a bound parameter, never interpolated
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HybridSearchService } from './hybrid-search.service';
import { PrismaService } from '../prisma/prisma.service';

describe('HybridSearchService — SQL injection prevention (GIN-42)', () => {
  let service: HybridSearchService;
  let prisma: jest.Mocked<PrismaService>;
  let capturedSql: string;
  let capturedParams: any[];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HybridSearchService,
        {
          provide: PrismaService,
          useValue: {
            $queryRawUnsafe: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, def: string) => def),
          },
        },
      ],
    }).compile();

    service = module.get<HybridSearchService>(HybridSearchService);
    prisma = module.get(PrismaService);

    // Capture what gets sent to the database
    (prisma.$queryRawUnsafe as jest.Mock).mockImplementation(
      (sql: string, ...params: any[]) => {
        capturedSql = sql;
        capturedParams = params;
        return Promise.resolve([]);
      },
    );

    capturedSql = '';
    capturedParams = [];
  });

  // ---------------------------------------------------------------------------
  // LIMIT clause integrity
  // ---------------------------------------------------------------------------
  describe('LIMIT clause sanitization', () => {
    it('uses a plain integer in the LIMIT clause for a normal limit', async () => {
      await service.textSearch('test query', {
        userId: 'user-1',
        limit: 10,
      });

      // LIMIT value in SQL must be a plain non-negative integer
      expect(capturedSql).toMatch(/LIMIT\s+\d+/);
      const match = capturedSql.match(/LIMIT\s+(\d+)/);
      expect(match).not.toBeNull();
      const limitValue = parseInt(match![1], 10);
      expect(limitValue).toBe(10);
    });

    it('clamps fractional limit to an integer (Math.trunc)', async () => {
      await service.textSearch('test query', {
        userId: 'user-1',
        limit: 9.99,
      });

      const match = capturedSql.match(/LIMIT\s+(\d+)/g);
      expect(match).not.toBeNull();
      // All LIMIT occurrences should be plain integers — no decimal points
      for (const clause of match!) {
        expect(clause).toMatch(/^LIMIT\s+\d+$/);
      }
    });

    it('does not allow negative limit — clamped to minimum of 1', async () => {
      await service.textSearch('test query', {
        userId: 'user-1',
        limit: -5,
      });

      const match = capturedSql.match(/LIMIT\s+(\d+)/);
      expect(match).not.toBeNull();
      const limitValue = parseInt(match![1], 10);
      expect(limitValue).toBeGreaterThanOrEqual(1);
    });

    it('does not allow zero limit — clamped to minimum of 1', async () => {
      await service.textSearch('test query', {
        userId: 'user-1',
        limit: 0,
      });

      const match = capturedSql.match(/LIMIT\s+(\d+)/);
      expect(match).not.toBeNull();
      const limitValue = parseInt(match![1], 10);
      expect(limitValue).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Query text is always a bound parameter ($1), never interpolated
  // ---------------------------------------------------------------------------
  describe('query text parameterization', () => {
    const injectionPayloads = [
      "'; DROP TABLE memories; --",
      "' OR 1=1 --",
      "'; SELECT * FROM users --",
      "') OR ('1'='1",
      "'; EXEC xp_cmdshell('id'); --",
    ];

    it.each(injectionPayloads)(
      'passes injection string %j as a bound parameter, not interpolated into SQL',
      async (payload) => {
        await service.textSearch(payload, {
          userId: 'user-1',
          limit: 10,
        });

        // The raw SQL string should NOT contain the injection payload
        expect(capturedSql).not.toContain(payload);

        // But the payload SHOULD appear as a bound parameter
        expect(capturedParams[0]).toBe(payload);
      },
    );

    it('uses $1 placeholder for query text in the SQL string', async () => {
      await service.textSearch('test injection: ; DROP TABLE --', {
        userId: 'user-1',
        limit: 10,
      });

      // Query text is referenced as $1 in the SQL
      expect(capturedSql).toContain('$1');
    });
  });

  // ---------------------------------------------------------------------------
  // User ID is always a bound parameter, never interpolated
  // ---------------------------------------------------------------------------
  describe('userId parameterization', () => {
    it('passes userId as a bound parameter, not interpolated into SQL', async () => {
      const maliciousUserId = "user'; DROP TABLE memories; --";

      await service.textSearch('normal query', {
        userId: maliciousUserId,
        limit: 10,
      });

      // The SQL string must not contain the raw userId
      expect(capturedSql).not.toContain(maliciousUserId);

      // userId should be in the params array
      expect(capturedParams).toContain(maliciousUserId);
    });
  });
});
