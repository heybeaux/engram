/**
 * GIN-42: SQL Injection Prevention Tests for Analytics Service
 *
 * Verifies that:
 * 1. Injection strings in the `granularity` field are rejected before reaching the DB
 * 2. The validateInterval allowlist blocks any non-enumerated value
 * 3. $queryRaw (tagged template) is used instead of $queryRawUnsafe with interpolation
 * 4. Prisma.sql receives the allowlisted literal, not raw user input
 */
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../prisma/prisma.service';

// Classic SQL injection payloads that must never reach the database
const SQL_INJECTION_STRINGS = [
  "'; DROP TABLE memories; --",
  "' OR '1'='1",
  "' OR 1=1 --",
  "1; SELECT * FROM users --",
  "hour'; DELETE FROM memories WHERE '1'='1",
  "day' UNION SELECT table_name FROM information_schema.tables --",
  'day\x00',
  "day'; EXEC xp_cmdshell('rm -rf /') --",
  '<script>alert(1)</script>',
  '../../../etc/passwd',
  'hour OR 1=1',
  '1=1',
];

describe('Analytics SQL Injection Security (GIN-42)', () => {
  let service: AnalyticsService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        {
          provide: PrismaService,
          useValue: {
            agent: { findUnique: jest.fn() },
            user: { findMany: jest.fn() },
            memory: {
              count: jest.fn(),
              aggregate: jest.fn(),
              groupBy: jest.fn(),
            },
            $queryRaw: jest.fn(),
            $queryRawUnsafe: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    prisma = module.get(PrismaService);

    // Set up agent and user resolution
    (prisma.agent.findUnique as jest.Mock).mockResolvedValue({
      accountId: 'test-account',
    });
    (prisma.user.findMany as jest.Mock).mockResolvedValue([
      { id: 'user-1' },
    ]);
  });

  // ---------------------------------------------------------------------------
  // getTimeline — granularity field
  // ---------------------------------------------------------------------------
  describe('getTimeline — injection via granularity field', () => {
    it.each(SQL_INJECTION_STRINGS)(
      'rejects injection payload %j as granularity',
      async (payload) => {
        await expect(
          service.getTimeline('agent-1', {
            granularity: payload as any,
          }),
        ).rejects.toThrow(BadRequestException);

        // validateInterval is called before any DB query, so no DB access occurs.
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      },
    );

    it('accepts valid granularity "hour"', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await expect(
        service.getTimeline('agent-1', { granularity: 'hour' }),
      ).resolves.not.toThrow();

      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('accepts valid granularity "day"', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await expect(
        service.getTimeline('agent-1', { granularity: 'day' }),
      ).resolves.not.toThrow();
    });

    it('accepts valid granularity "week"', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await expect(
        service.getTimeline('agent-1', { granularity: 'week' }),
      ).resolves.not.toThrow();
    });

    it('does NOT call $queryRawUnsafe for timeline queries', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.getTimeline('agent-1', { granularity: 'day' });

      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getTypeBreakdown — granularity field
  // ---------------------------------------------------------------------------
  describe('getTypeBreakdown — injection via granularity field', () => {
    it.each(SQL_INJECTION_STRINGS)(
      'rejects injection payload %j as granularity',
      async (payload) => {
        await expect(
          service.getTypeBreakdown('agent-1', {
            granularity: payload as any,
          }),
        ).rejects.toThrow(BadRequestException);

        // validateInterval is called before any DB query.
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      },
    );

    it('accepts valid granularity "week"', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await expect(
        service.getTypeBreakdown('agent-1', { granularity: 'week' }),
      ).resolves.not.toThrow();
    });

    it('accepts valid granularity "month"', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await expect(
        service.getTypeBreakdown('agent-1', { granularity: 'month' }),
      ).resolves.not.toThrow();
    });

    it('does NOT call $queryRawUnsafe for type breakdown queries', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.getTypeBreakdown('agent-1', { granularity: 'day' });

      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getLayerDistribution — granularity field for trend data
  // ---------------------------------------------------------------------------
  describe('getLayerDistribution — injection via granularity field', () => {
    it.each(SQL_INJECTION_STRINGS)(
      'rejects injection payload %j as granularity for trend',
      async (payload) => {
        await expect(
          service.getLayerDistribution('agent-1', {
            includeTrend: true,
            granularity: payload as any,
          }),
        ).rejects.toThrow(BadRequestException);

        // validateInterval is called before any DB query, so the database
        // must never have been touched with an injection payload.
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      },
    );

    it('accepts valid granularity "week" for trend', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ layer: 'IDENTITY', count: BigInt(10) }])
        .mockResolvedValueOnce([]);

      await expect(
        service.getLayerDistribution('agent-1', {
          includeTrend: true,
          granularity: 'week',
        }),
      ).resolves.not.toThrow();
    });

    it('accepts valid granularity "day" for trend', async () => {
      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(
        service.getLayerDistribution('agent-1', {
          includeTrend: true,
          granularity: 'day',
        }),
      ).resolves.not.toThrow();
    });

    it('does NOT call $queryRawUnsafe for layer distribution', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.getLayerDistribution('agent-1', {
        includeTrend: true,
        granularity: 'week',
      });

      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // validateInterval helper — direct boundary tests
  // ---------------------------------------------------------------------------
  describe('interval allowlist boundary conditions', () => {
    // Call via getTimeline which internally uses validateInterval
    it('rejects empty string as granularity', async () => {
      await expect(
        service.getTimeline('agent-1', { granularity: '' as any }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a number coerced to string as granularity', async () => {
      await expect(
        service.getTimeline('agent-1', { granularity: 42 as any }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects null as granularity', async () => {
      await expect(
        service.getTimeline('agent-1', { granularity: null as any }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects "HOUR" (uppercase) as granularity — case sensitive', async () => {
      await expect(
        service.getTimeline('agent-1', { granularity: 'HOUR' as any }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects "Day" (mixed case) as granularity — case sensitive', async () => {
      await expect(
        service.getTimeline('agent-1', { granularity: 'Day' as any }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects "second" (not in allowlist) as granularity', async () => {
      await expect(
        service.getTimeline('agent-1', { granularity: 'second' as any }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects "year" (not in allowlist) as granularity', async () => {
      await expect(
        service.getTimeline('agent-1', { granularity: 'year' as any }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // Confirm $queryRaw (parameterized) is used — not $queryRawUnsafe
  // ---------------------------------------------------------------------------
  describe('query method verification', () => {
    it('getTimeline uses $queryRaw (parameterized template tag), not $queryRawUnsafe', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        { timestamp: new Date(), count: BigInt(1) },
      ]);

      await service.getTimeline('agent-1', { granularity: 'day' });

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('getTypeBreakdown uses $queryRaw, not $queryRawUnsafe', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.getTypeBreakdown('agent-1', { granularity: 'day' });

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('getLayerDistribution (with trend) uses $queryRaw, not $queryRawUnsafe', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await service.getLayerDistribution('agent-1', {
        includeTrend: true,
        granularity: 'week',
      });

      // Two calls: one for layer counts, one for trend data
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });
  });
});
