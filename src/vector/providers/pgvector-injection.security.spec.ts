/**
 * GIN-42: SQL Injection Prevention Tests for PgVectorProvider
 *
 * Verifies that:
 * 1. The `limit` value interpolated into LIMIT clauses is always a safe integer
 * 2. User-controlled filter values (userId, projectId, poolIds) are always
 *    passed as bound parameters, never interpolated into SQL strings
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PgVectorProvider } from './pgvector.provider';
import { PrismaService } from '../../prisma/prisma.service';

describe('PgVectorProvider — SQL injection prevention (GIN-42)', () => {
  let provider: PgVectorProvider;
  let prisma: jest.Mocked<PrismaService>;
  let capturedSql: string;
  let capturedParams: any[];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PgVectorProvider,
        {
          provide: PrismaService,
          useValue: {
            $executeRawUnsafe: jest.fn().mockResolvedValue(1),
            $queryRawUnsafe: jest.fn(),
            $executeRaw: jest.fn(),
          },
        },
      ],
    }).compile();

    provider = module.get<PgVectorProvider>(PgVectorProvider);
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

    // Force skipFallback so we get a deterministic single-query shape
    jest.spyOn(provider, 'shouldSkipLegacyFallback').mockResolvedValue(true);
  });

  // ---------------------------------------------------------------------------
  // LIMIT clause integrity in search()
  // ---------------------------------------------------------------------------
  describe('LIMIT clause sanitization in search()', () => {
    const embedding = new Array(1536).fill(0.1);

    it('uses a plain integer for a normal limit', async () => {
      await provider.search(embedding, { userId: 'user-1', limit: 10 });

      const limitMatches = capturedSql.match(/LIMIT\s+(\d+)/g) ?? [];
      expect(limitMatches.length).toBeGreaterThan(0);
      for (const clause of limitMatches) {
        expect(clause).toMatch(/^LIMIT\s+\d+$/);
      }
    });

    it('clamps fractional limit to integer (Math.trunc)', async () => {
      await provider.search(embedding, { userId: 'user-1', limit: 7.7 });

      const match = capturedSql.match(/LIMIT\s+(\d+)/);
      expect(match).not.toBeNull();
      const limitValue = parseInt(match![1], 10);
      // Math.trunc(7.7) = 7
      expect(limitValue).toBe(7);
    });

    it('clamps negative limit to minimum of 1', async () => {
      await provider.search(embedding, { userId: 'user-1', limit: -100 });

      const match = capturedSql.match(/LIMIT\s+(\d+)/);
      expect(match).not.toBeNull();
      const limitValue = parseInt(match![1], 10);
      expect(limitValue).toBeGreaterThanOrEqual(1);
    });

    it('clamps zero limit to minimum of 1', async () => {
      await provider.search(embedding, { userId: 'user-1', limit: 0 });

      const match = capturedSql.match(/LIMIT\s+(\d+)/);
      expect(match).not.toBeNull();
      const limitValue = parseInt(match![1], 10);
      expect(limitValue).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Filter values are bound parameters, not interpolated strings
  // ---------------------------------------------------------------------------
  describe('filter value parameterization in search()', () => {
    const embedding = new Array(1536).fill(0.1);

    it('passes userId as a bound parameter', async () => {
      const maliciousUserId = "user'; DROP TABLE memories; --";

      await provider.search(embedding, {
        userId: maliciousUserId,
        limit: 5,
      });

      expect(capturedSql).not.toContain(maliciousUserId);
      expect(capturedParams).toContain(maliciousUserId);
    });

    it('passes projectId as a bound parameter', async () => {
      const maliciousProjectId = "proj'; SELECT * FROM users; --";

      await provider.search(embedding, {
        userId: 'user-1',
        limit: 5,
        filter: { projectId: maliciousProjectId },
      });

      expect(capturedSql).not.toContain(maliciousProjectId);
      expect(capturedParams).toContain(maliciousProjectId);
    });

    it('passes pool IDs as bound parameters', async () => {
      const maliciousPoolId = "pool'; TRUNCATE memories; --";

      await provider.search(embedding, {
        userId: 'user-1',
        limit: 5,
        filter: { poolIds: [maliciousPoolId] },
      });

      expect(capturedSql).not.toContain(maliciousPoolId);
      expect(capturedParams).toContain(maliciousPoolId);
    });

  });
});
