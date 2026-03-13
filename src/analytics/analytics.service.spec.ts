import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let prisma: PrismaService;

  const mockAgentId = 'test-agent-id';
  const mockUserId = 'test-user-id';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        {
          provide: PrismaService,
          useValue: {
            agent: {
              findUnique: jest.fn(),
            },
            user: {
              findMany: jest.fn(),
            },
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
    prisma = module.get<PrismaService>(PrismaService);

    // getUserIdsForAgent now resolves agent.accountId first
    jest
      .spyOn(prisma.agent, 'findUnique')
      .mockResolvedValue({ accountId: 'mock-account-id' } as any);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getTimeline', () => {
    it('should return empty data when no users exist', async () => {
      jest.spyOn(prisma.user, 'findMany').mockResolvedValue([]);

      const result = await service.getTimeline(mockAgentId, {
        granularity: 'day',
      });

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.granularity).toBe('day');
    });

    it('should return timeline data with correct granularity', async () => {
      jest
        .spyOn(prisma.user, 'findMany')
        .mockResolvedValue([{ id: mockUserId } as any]);

      const mockData = [
        { timestamp: new Date('2026-02-01'), count: BigInt(5) },
        { timestamp: new Date('2026-02-02'), count: BigInt(10) },
      ];
      jest.spyOn(prisma, '$queryRawUnsafe').mockResolvedValue(mockData);

      const result = await service.getTimeline(mockAgentId, {
        granularity: 'day',
        start: '2026-02-01',
        end: '2026-02-05',
      });

      expect(result.data).toHaveLength(2);
      expect(result.data[0].count).toBe(5);
      expect(result.data[1].count).toBe(10);
      expect(result.total).toBe(15);
    });

    it('should include cumulative when requested', async () => {
      jest
        .spyOn(prisma.user, 'findMany')
        .mockResolvedValue([{ id: mockUserId } as any]);

      const mockData = [
        { timestamp: new Date('2026-02-01'), count: BigInt(5) },
        { timestamp: new Date('2026-02-02'), count: BigInt(10) },
        { timestamp: new Date('2026-02-03'), count: BigInt(3) },
      ];
      jest.spyOn(prisma, '$queryRawUnsafe').mockResolvedValue(mockData);

      const result = await service.getTimeline(mockAgentId, {
        granularity: 'day',
        cumulative: true,
      });

      expect(result.data[0].cumulative).toBe(5);
      expect(result.data[1].cumulative).toBe(15);
      expect(result.data[2].cumulative).toBe(18);
    });
  });

  describe('getTypeBreakdown', () => {
    it('should return empty data when no users exist', async () => {
      jest.spyOn(prisma.user, 'findMany').mockResolvedValue([]);

      const result = await service.getTypeBreakdown(mockAgentId, {});

      expect(result.data).toEqual([]);
      expect(result.summary.dominant).toBeNull();
    });

    it('should calculate type distribution correctly', async () => {
      jest
        .spyOn(prisma.user, 'findMany')
        .mockResolvedValue([{ id: mockUserId } as any]);

      const mockData = [
        {
          timestamp: new Date('2026-02-01'),
          memory_type: 'FACT',
          count: BigInt(10),
        },
        {
          timestamp: new Date('2026-02-01'),
          memory_type: 'PREFERENCE',
          count: BigInt(5),
        },
        {
          timestamp: new Date('2026-02-01'),
          memory_type: 'LESSON',
          count: BigInt(2),
        },
      ];
      jest.spyOn(prisma, '$queryRawUnsafe').mockResolvedValue(mockData);

      const result = await service.getTypeBreakdown(mockAgentId, {
        granularity: 'week',
      });

      expect(result.data).toHaveLength(1);
      expect(result.summary.dominant).toBe('FACT');
      expect(result.summary.distribution.FACT.count).toBe(10);
    });
  });

  describe('getLayerDistribution', () => {
    it('should return empty data when no users exist', async () => {
      jest.spyOn(prisma.user, 'findMany').mockResolvedValue([]);

      const result = await service.getLayerDistribution(mockAgentId, {});

      expect(result.current).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should calculate layer percentages correctly', async () => {
      jest
        .spyOn(prisma.user, 'findMany')
        .mockResolvedValue([{ id: mockUserId } as any]);

      const mockLayerData = [
        { layer: 'IDENTITY', count: BigInt(50) },
        { layer: 'PROJECT', count: BigInt(30) },
        { layer: 'SESSION', count: BigInt(20) },
      ];
      jest.spyOn(prisma, '$queryRaw').mockResolvedValue(mockLayerData);

      const result = await service.getLayerDistribution(mockAgentId, {
        includeTrend: false,
      });

      expect(result.total).toBe(100);
      expect(
        result.current.find((l) => l.layer === 'IDENTITY')?.percentage,
      ).toBe(50);
      expect(
        result.current.find((l) => l.layer === 'PROJECT')?.percentage,
      ).toBe(30);
      expect(
        result.current.find((l) => l.layer === 'SESSION')?.percentage,
      ).toBe(20);
    });

    it('should include INSIGHT layer in distribution', async () => {
      jest
        .spyOn(prisma.user, 'findMany')
        .mockResolvedValue([{ id: mockUserId } as any]);

      const mockLayerData = [
        { layer: 'IDENTITY', count: BigInt(30) },
        { layer: 'PROJECT', count: BigInt(20) },
        { layer: 'SESSION', count: BigInt(20) },
        { layer: 'TASK', count: BigInt(15) },
        { layer: 'INSIGHT', count: BigInt(15) },
      ];
      jest.spyOn(prisma, '$queryRaw').mockResolvedValue(mockLayerData);

      const result = await service.getLayerDistribution(mockAgentId, {
        includeTrend: false,
      });

      expect(result.total).toBe(100);
      expect(result.current.find((l) => l.layer === 'INSIGHT')).toBeDefined();
      expect(
        result.current.find((l) => l.layer === 'INSIGHT')?.percentage,
      ).toBe(15);
      expect(result.current.find((l) => l.layer === 'TASK')?.percentage).toBe(
        15,
      );
    });

    it('should include trend data when requested', async () => {
      jest
        .spyOn(prisma.user, 'findMany')
        .mockResolvedValue([{ id: mockUserId } as any]);

      // First call for current distribution
      const mockLayerData = [{ layer: 'IDENTITY', count: BigInt(50) }];

      // Second call for trend
      const mockTrendData = [
        {
          timestamp: new Date('2026-02-01'),
          layer: 'IDENTITY',
          count: BigInt(10),
        },
        {
          timestamp: new Date('2026-02-08'),
          layer: 'IDENTITY',
          count: BigInt(15),
        },
      ];

      jest.spyOn(prisma, '$queryRaw').mockResolvedValue(mockLayerData);
      jest.spyOn(prisma, '$queryRawUnsafe').mockResolvedValue(mockTrendData);

      const result = await service.getLayerDistribution(mockAgentId, {
        includeTrend: true,
        granularity: 'week',
      });

      expect(result.trend).toBeDefined();
      expect(result.trend?.data).toHaveLength(2);
      expect(result.trend?.granularity).toBe('week');
    });
  });

  describe('getSummary', () => {
    it('should return zeros when no users exist', async () => {
      jest.spyOn(prisma.user, 'findMany').mockResolvedValue([]);

      const result = await service.getSummary(mockAgentId);

      expect(result.totalMemories).toBe(0);
      expect(result.memoriesToday).toBe(0);
      expect(result.memoriesThisWeek).toBe(0);
      expect(result.avgImportance).toBe(0);
    });

    it('should aggregate all summary stats', async () => {
      jest
        .spyOn(prisma.user, 'findMany')
        .mockResolvedValue([{ id: mockUserId } as any]);
      jest
        .spyOn(prisma.memory, 'count')
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(5) // today
        .mockResolvedValueOnce(25); // this week
      jest.spyOn(prisma.memory, 'aggregate').mockResolvedValue({
        _avg: { importanceScore: 0.75 },
      } as any);
      jest.spyOn(prisma, '$queryRawUnsafe').mockResolvedValue([]);
      jest.spyOn(prisma, '$queryRaw').mockResolvedValue([]);
      jest.spyOn(prisma.memory, 'groupBy').mockResolvedValue([]);

      const result = await service.getSummary(mockAgentId);

      expect(result.totalMemories).toBe(100);
      expect(result.memoriesToday).toBe(5);
      expect(result.memoriesThisWeek).toBe(25);
      expect(result.avgImportance).toBe(0.75);
      expect(result.lastUpdated).toBeDefined();
    });
  });
});
