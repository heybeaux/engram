import { Test } from '@nestjs/testing';
import { HealthMetricsService } from './health-metrics.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';

const mockPrisma = {
  memory: {
    count: jest.fn().mockResolvedValue(6500),
    groupBy: jest.fn().mockResolvedValue([
      { layer: 'SESSION', _count: { layer: 4000 } },
      { layer: 'INSIGHT', _count: { layer: 1500 } },
    ]),
  },
  systemMetric: {
    upsert: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
  },
  $queryRaw: jest.fn(),
};

describe('HealthMetricsService', () => {
  let service: HealthMetricsService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        HealthMetricsService,
        { provide: ServicePrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(HealthMetricsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(service).toBeDefined());

  it('compute() returns a report with 5 metrics', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ pct: 97.5 }])
      .mockResolvedValueOnce([{ pct: 3.2 }])
      .mockResolvedValueOnce([{ pct: 28.4 }])
      .mockResolvedValueOnce([]);
    const report = await service.compute();
    expect(report.metrics).toHaveLength(5);
    expect(report.totalMemories).toBe(6500);
  });

  it('embedding_coverage is green at 98%', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ pct: 98.0 }])
      .mockResolvedValueOnce([{ pct: 2.0 }])
      .mockResolvedValueOnce([{ pct: 15.0 }])
      .mockResolvedValueOnce([]);
    const report = await service.compute();
    expect(
      report.metrics.find((m) => m.key === 'embedding_coverage_pct')?.status,
    ).toBe('green');
  });

  it('duplicate_ratio is red above 15%', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ pct: 90.0 }])
      .mockResolvedValueOnce([{ pct: 20.0 }])
      .mockResolvedValueOnce([{ pct: 10.0 }])
      .mockResolvedValueOnce([]);
    const report = await service.compute();
    expect(
      report.metrics.find((m) => m.key === 'duplicate_ratio_pct')?.status,
    ).toBe('red');
  });

  it('computeAndPersist() calls upsert for each metric', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ pct: 97.5 }])
      .mockResolvedValueOnce([{ pct: 3.2 }])
      .mockResolvedValueOnce([{ pct: 28.4 }])
      .mockResolvedValueOnce([]);
    await service.computeAndPersist();
    expect(mockPrisma.systemMetric.upsert).toHaveBeenCalledTimes(5);
  });

  it('getDreamCycleSla() handles missing table gracefully', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ pct: 97.5 }])
      .mockResolvedValueOnce([{ pct: 3.2 }])
      .mockResolvedValueOnce([{ pct: 28.4 }])
      .mockRejectedValueOnce(
        new Error('relation "dream_cycle_runs" does not exist'),
      );
    const report = await service.compute();
    expect(
      report.metrics.find((m) => m.key === 'dream_cycle_sla')?.value,
    ).toMatchObject({ minutesSinceLastComplete: null });
  });
});
