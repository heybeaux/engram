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
    // Restore the default mockResolvedValue defaults that mockImplementation
    // in other tests can otherwise overwrite for the lifetime of the suite.
    mockPrisma.memory.count.mockResolvedValue(6500);
    mockPrisma.memory.groupBy.mockResolvedValue([
      { layer: 'SESSION', _count: { layer: 4000 } },
      { layer: 'INSIGHT', _count: { layer: 1500 } },
    ]);
    mockPrisma.systemMetric.upsert.mockResolvedValue({});
    mockPrisma.systemMetric.findMany.mockResolvedValue([]);
    mockPrisma.$queryRaw.mockReset();
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

  it('handleScheduledRefresh() calls computeAndPersist', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ pct: 97.5 }])
      .mockResolvedValueOnce([{ pct: 3.2 }])
      .mockResolvedValueOnce([{ pct: 28.4 }])
      .mockResolvedValueOnce([]);
    await service.handleScheduledRefresh();
    expect(mockPrisma.systemMetric.upsert).toHaveBeenCalledTimes(5);
  });

  it('handleScheduledRefresh() swallows errors', async () => {
    mockPrisma.memory.count.mockRejectedValueOnce(new Error('DB down'));
    await expect(service.handleScheduledRefresh()).resolves.toBeUndefined();
  });

  it('compute() single-flights concurrent callers (issue #262)', async () => {
    // Simulate slow queries so three callers overlap in flight.
    const deferred: Array<() => void> = [];
    mockPrisma.$queryRaw.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.push(() => resolve([{ pct: 1.0 }]));
        }),
    );
    mockPrisma.memory.count.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.push(() => resolve(100));
        }),
    );
    mockPrisma.memory.groupBy.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.push(() => resolve([]));
        }),
    );

    const p1 = service.compute();
    const p2 = service.compute();
    const p3 = service.compute();

    // All three callers should share the same underlying promise.
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    // Resolve the deferred queries so the in-flight compute completes.
    // (count + 4 $queryRaw + groupBy = 6 deferred calls — wait for them to register.)
    await new Promise((r) => setImmediate(r));
    deferred.forEach((fn) => fn());

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);

    // Each underlying query should have been called exactly once across the
    // three concurrent compute() invocations.
    expect(mockPrisma.memory.count).toHaveBeenCalledTimes(1);
    expect(mockPrisma.memory.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('compute() releases the in-flight slot after completion', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ pct: 97.5 }])
      .mockResolvedValueOnce([{ pct: 3.2 }])
      .mockResolvedValueOnce([{ pct: 28.4 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ pct: 97.5 }])
      .mockResolvedValueOnce([{ pct: 3.2 }])
      .mockResolvedValueOnce([{ pct: 28.4 }])
      .mockResolvedValueOnce([]);
    await service.compute();
    await service.compute();
    // Sequential (non-overlapping) callers each get a fresh compute.
    expect(mockPrisma.memory.count).toHaveBeenCalledTimes(2);
  });

  it('compute() releases the in-flight slot after a failure', async () => {
    // Other parallel queries need *something* to resolve to so the rejection
    // from count() is the one that surfaces.
    mockPrisma.$queryRaw.mockResolvedValue([{ pct: 0 }]);
    mockPrisma.memory.count.mockRejectedValueOnce(new Error('boom'));
    await expect(service.compute()).rejects.toThrow('boom');
    // Second call after failure should NOT reuse the rejected promise.
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ pct: 97.5 }])
      .mockResolvedValueOnce([{ pct: 3.2 }])
      .mockResolvedValueOnce([{ pct: 28.4 }])
      .mockResolvedValueOnce([]);
    const report = await service.compute();
    expect(report.metrics).toHaveLength(5);
  });

  it('getDreamCycleSla() reads completed stage runs', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ pct: 97.5 }])
      .mockResolvedValueOnce([{ pct: 3.2 }])
      .mockResolvedValueOnce([{ pct: 28.4 }])
      .mockResolvedValueOnce([
        { stage: 'pending', minutes_since_ok: 12.2 },
        { stage: 'identity', minutes_since_ok: 31.7 },
      ]);
    const report = await service.compute();
    expect(
      report.metrics.find((m) => m.key === 'dream_cycle_sla')?.value,
    ).toMatchObject({
      minutesSinceLastComplete: 32,
      stages: { pending: 12, identity: 32 },
    });
  });

  it('getDreamCycleSla() handles missing table gracefully', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ pct: 97.5 }])
      .mockResolvedValueOnce([{ pct: 3.2 }])
      .mockResolvedValueOnce([{ pct: 28.4 }])
      .mockRejectedValueOnce(
        new Error('relation "dream_cycle_stage_runs" does not exist'),
      );
    const report = await service.compute();
    expect(
      report.metrics.find((m) => m.key === 'dream_cycle_sla')?.value,
    ).toMatchObject({ minutesSinceLastComplete: null });
  });
});
