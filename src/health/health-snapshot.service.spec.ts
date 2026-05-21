import { Test, TestingModule } from '@nestjs/testing';
import {
  HealthSnapshotService,
  MetricName,
  METRIC_NAMES,
  MetricSnapshot,
} from './health-snapshot.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { HealthMetricsService } from './health-metrics.service';

// ── Shared fixtures ─────────────────────────────────────────────────────────

const ACCOUNT_ID = 'test_account_001';
const AGENT_ID = 'test_agent_001';

/** Factory for a fake HealthMetricsService.compute() response */
function makeHealthReport(
  overrides: {
    embeddingPct?: number;
    dupPct?: number;
    stalePct?: number;
    dreamMins?: number | null;
  } = {},
) {
  const {
    embeddingPct = 92,
    dupPct = 4,
    stalePct = 18,
    dreamMins = 60,
  } = overrides;

  return {
    totalMemories: 5000,
    computedAt: new Date().toISOString(),
    metrics: [
      {
        key: 'embedding_coverage_pct',
        label: 'Embedding Coverage',
        value: embeddingPct,
        unit: '%',
        status: 'green' as const,
        description: '',
        computedAt: new Date().toISOString(),
      },
      {
        key: 'duplicate_ratio_pct',
        label: 'Duplicate Ratio',
        value: dupPct,
        unit: '%',
        status: 'green' as const,
        description: '',
        computedAt: new Date().toISOString(),
      },
      {
        key: 'stale_memories_pct',
        label: 'Stale Memories',
        value: stalePct,
        unit: '%',
        status: 'green' as const,
        description: '',
        computedAt: new Date().toISOString(),
      },
      {
        key: 'layer_distribution',
        label: 'Layer Distribution',
        value: { SESSION: 3000, INSIGHT: 1000 },
        status: 'info' as const,
        description: '',
        computedAt: new Date().toISOString(),
      },
      {
        key: 'dream_cycle_sla',
        label: 'Dream Cycle SLA',
        value:
          dreamMins !== null
            ? { minutesSinceLastComplete: dreamMins, stages: {} }
            : { minutesSinceLastComplete: null, stages: {} },
        status: 'green' as const,
        description: '',
        computedAt: new Date().toISOString(),
      },
    ],
  };
}

/** Build a mock HealthMetricSnapshot row */
function makeSnapshot(
  metricName: MetricName,
  value: number,
  createdAt = new Date(),
): MetricSnapshot {
  return {
    id: `snap_${metricName}_${Date.now()}`,
    accountId: ACCOUNT_ID,
    agentId: null,
    metricName,
    value,
    metadata: null,
    createdAt,
  };
}

// ── Mock setup ───────────────────────────────────────────────────────────────

let mockHealthMetrics: { compute: jest.Mock };
let mockPrisma: {
  healthMetricSnapshot: {
    create: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
  };
};

function buildModule() {
  mockHealthMetrics = {
    compute: jest.fn().mockResolvedValue(makeHealthReport()),
  };

  mockPrisma = {
    healthMetricSnapshot: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  return Test.createTestingModule({
    providers: [
      HealthSnapshotService,
      { provide: ServicePrismaService, useValue: mockPrisma },
      { provide: HealthMetricsService, useValue: mockHealthMetrics },
    ],
  }).compile();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('HealthSnapshotService', () => {
  let service: HealthSnapshotService;
  let module: TestingModule;

  beforeEach(async () => {
    module = await buildModule();
    service = module.get(HealthSnapshotService);
    jest.clearAllMocks();

    // Default: create returns a realistic snapshot for each call
    mockPrisma.healthMetricSnapshot.create.mockImplementation(
      ({ data }: { data: Partial<MetricSnapshot> }) =>
        Promise.resolve({
          id: `snap_${data.metricName}_created`,
          accountId: ACCOUNT_ID,
          agentId: null,
          metricName: data.metricName,
          value: data.value,
          metadata: data.metadata ?? null,
          createdAt: new Date(),
          ...data,
        }),
    );
  });

  afterAll(async () => {
    await module.close();
  });

  // ── Test 1: takeSnapshot writes all 5 metrics ───────────────────────────

  it('takeSnapshot() writes all 5 named metrics to the DB', async () => {
    mockHealthMetrics.compute.mockResolvedValue(makeHealthReport());

    const result = await service.takeSnapshot(ACCOUNT_ID);

    // Should call compute once
    expect(mockHealthMetrics.compute).toHaveBeenCalledTimes(1);

    // Should call prisma.create 5 times (one per metric)
    expect(mockPrisma.healthMetricSnapshot.create).toHaveBeenCalledTimes(5);

    // All 5 METRIC_NAMES must be present
    const writtenNames = mockPrisma.healthMetricSnapshot.create.mock.calls.map(
      ([{ data }]: [{ data: { metricName: string } }]) => data.metricName,
    );
    for (const name of METRIC_NAMES) {
      expect(writtenNames).toContain(name);
    }

    // Result shape
    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(result.snapshots).toHaveLength(5);
    expect(result.takenAt).toBeTruthy();
  });

  // ── Test 2: takeSnapshot with agentId sets it on the records ────────────

  it('takeSnapshot() stores agentId when provided', async () => {
    mockHealthMetrics.compute.mockResolvedValue(makeHealthReport());

    await service.takeSnapshot(ACCOUNT_ID, AGENT_ID);

    const calls = mockPrisma.healthMetricSnapshot.create.mock.calls;
    for (const [{ data }] of calls as [{ data: { agentId: string } }][]) {
      expect(data.agentId).toBe(AGENT_ID);
    }
  });

  // ── Test 3: getHistory returns DB rows for the given metric ─────────────

  it('getHistory() returns sorted rows for a given metric and time window', async () => {
    const rows = [
      makeSnapshot('embedding_coverage', 88, new Date('2026-03-01')),
      makeSnapshot('embedding_coverage', 91, new Date('2026-03-05')),
      makeSnapshot('embedding_coverage', 94, new Date('2026-03-08')),
    ];
    mockPrisma.healthMetricSnapshot.findMany.mockResolvedValue(rows);

    const history = await service.getHistory(
      ACCOUNT_ID,
      'embedding_coverage',
      30,
    );

    expect(history).toHaveLength(3);
    expect(history[0].metricName).toBe('embedding_coverage');
    expect(history[0].value).toBe(88);

    // Verify the query filters by accountId, metricName, and date range
    const [{ where }] = mockPrisma.healthMetricSnapshot.findMany.mock
      .calls[0] as [
      {
        where: {
          accountId: string;
          metricName: string;
          createdAt: { gte: Date };
        };
      },
    ];
    expect(where.accountId).toBe(ACCOUNT_ID);
    expect(where.metricName).toBe('embedding_coverage');
    expect(where.createdAt?.gte).toBeInstanceOf(Date);
  });

  // ── Test 4: getLatestAll returns null for metrics with no history ────────

  it('getLatestAll() returns null for every metric when no snapshots exist', async () => {
    mockPrisma.healthMetricSnapshot.findFirst.mockResolvedValue(null);

    const latest = await service.getLatestAll(ACCOUNT_ID);

    expect(Object.keys(latest)).toHaveLength(METRIC_NAMES.length);
    for (const name of METRIC_NAMES) {
      expect(latest[name]).toBeNull();
    }
  });

  // ── Test 5: getLatestAll returns the most recent row per metric ──────────

  it('getLatestAll() returns the most recent snapshot for each metric', async () => {
    const latestSnapshots: Record<MetricName, MetricSnapshot> = {
      memory_freshness: makeSnapshot('memory_freshness', 82),
      embedding_coverage: makeSnapshot('embedding_coverage', 95),
      consolidation_health: makeSnapshot('consolidation_health', 100),
      dedup_health: makeSnapshot('dedup_health', 96),
      memory_vitality: makeSnapshot('memory_vitality', 88),
    };

    mockPrisma.healthMetricSnapshot.findFirst.mockImplementation(
      ({ where }: { where: { metricName: MetricName } }) =>
        Promise.resolve(latestSnapshots[where.metricName] ?? null),
    );

    const latest = await service.getLatestAll(ACCOUNT_ID);

    expect(latest.memory_freshness?.value).toBe(82);
    expect(latest.embedding_coverage?.value).toBe(95);
    expect(latest.consolidation_health?.value).toBe(100);
    expect(latest.dedup_health?.value).toBe(96);
    expect(latest.memory_vitality?.value).toBe(88);
  });

  // ── Test 6: score derivations are correct ───────────────────────────────

  it('takeSnapshot() correctly derives scores from raw metric values', async () => {
    mockHealthMetrics.compute.mockResolvedValue(
      makeHealthReport({
        embeddingPct: 90, // embedding_coverage → 90
        dupPct: 10, // dedup_health → 100 - 10 = 90
        stalePct: 25, // memory_freshness → 100 - 25 = 75
        dreamMins: 30 * 60, // 30h → yellow → 65
      }),
    );

    await service.takeSnapshot(ACCOUNT_ID);

    const calls = mockPrisma.healthMetricSnapshot.create.mock.calls;
    const written = Object.fromEntries(
      (calls as [{ data: { metricName: MetricName; value: number } }][]).map(
        ([{ data }]) => [data.metricName, data.value],
      ),
    ) as Record<MetricName, number>;

    expect(written.embedding_coverage).toBeCloseTo(90, 1);
    expect(written.dedup_health).toBeCloseTo(90, 1);
    expect(written.memory_freshness).toBeCloseTo(75, 1);
    expect(written.consolidation_health).toBe(65);

    // memory_vitality = 90*0.35 + 90*0.25 + 75*0.20 + 65*0.20 = 31.5+22.5+15+13 = 82
    expect(written.memory_vitality).toBeCloseTo(82, 0);
  });

  // ── Test 7: multiple different metrics in history query ─────────────────

  it('getHistory() can retrieve each of the 5 metric types independently', async () => {
    const metricValues: Record<MetricName, number> = {
      memory_freshness: 75,
      embedding_coverage: 95,
      consolidation_health: 65,
      dedup_health: 92,
      memory_vitality: 85,
    };

    mockPrisma.healthMetricSnapshot.findMany.mockImplementation(
      ({ where }: { where: { metricName: MetricName } }) =>
        Promise.resolve([
          makeSnapshot(where.metricName, metricValues[where.metricName] ?? 0),
        ]),
    );

    for (const name of METRIC_NAMES) {
      const history = await service.getHistory(ACCOUNT_ID, name, 7);
      expect(history).toHaveLength(1);
      expect(history[0].metricName).toBe(name);
      expect(history[0].value).toBe(metricValues[name]);
    }
  });
});
