import { DriftAnalysisJobService } from './drift-analysis-job.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { EnsembleService } from './ensemble.service';
import { DriftDetectionService } from './drift-detection.service';

describe('DriftAnalysisJobService', () => {
  let service: DriftAnalysisJobService;
  let prisma: jest.Mocked<ServicePrismaService>;
  let ensembleService: jest.Mocked<EnsembleService>;
  let driftDetectionService: jest.Mocked<DriftDetectionService>;

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      memory: { findMany: jest.fn().mockResolvedValue([]) },
      driftSnapshot: { create: jest.fn() },
    } as any;

    ensembleService = {
      getConfig: jest
        .fn()
        .mockReturnValue({ models: ['model-a'], fusionMethod: 'rrf', k: 60 }),
      embedAll: jest.fn(),
    } as any;

    driftDetectionService = {
      getThresholds: jest.fn().mockReturnValue({ drift: 0.1, alert: 0.2 }),
      measureBatchDrift: jest.fn(),
      summarizeDrift: jest.fn(),
    } as any;

    service = new DriftAnalysisJobService(
      prisma,
      ensembleService,
      driftDetectionService,
    );
  });

  it('should return no-op result when an account has no memories', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'user-1' }] as any);
    prisma.memory.findMany.mockResolvedValue([]);

    const result = await service.analyzeNow('acc-123');

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc-123', deletedAt: null },
      select: { id: true },
    });
    expect(result.snapshots).toHaveLength(0);
    expect(result.summary).toBe('No memories to analyze');
  });

  it('should analyze drift and persist snapshots scoped to account users', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'user-1' }] as any);
    prisma.memory.findMany.mockResolvedValue([
      { id: 'm1', raw: 'test' },
    ] as any);
    ensembleService.embedAll.mockResolvedValue({
      embeddings: [
        {
          model: 'model-a',
          embedding: [0.1, 0.2],
          dimensions: 2,
          latencyMs: 5,
        },
      ],
      totalMs: 5,
    } as any);
    driftDetectionService.measureBatchDrift.mockResolvedValue([
      { cosineDrift: 0.05, flagged: false },
    ] as any);
    driftDetectionService.summarizeDrift.mockReturnValue({
      avgCosineDrift: 0.05,
      maxCosineDrift: 0.08,
    } as any);
    prisma.driftSnapshot.create.mockResolvedValue({} as any);

    const progress: Array<{
      current: number;
      total: number;
      message?: string;
    }> = [];
    const result = await service.analyzeNow(
      'acc-123',
      (current, total, message) => {
        progress.push({ current, total, message });
      },
    );

    expect(prisma.memory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, userId: { in: ['user-1'] } },
        take: 100,
      }),
    );
    expect(driftDetectionService.measureBatchDrift).toHaveBeenCalledWith(
      [{ id: 'm1', raw: 'test' }],
      [[0.1, 0.2]],
      'model-a',
    );
    expect(prisma.driftSnapshot.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc-123',
        modelId: 'model-a',
        avgDrift: 0.05,
        maxDrift: 0.08,
        sampleCount: 1,
        alertLevel: 'normal',
      },
    });
    expect(result.snapshots).toHaveLength(1);
    expect(result.summary).toContain('normal');
    expect(progress.at(-1)).toEqual(
      expect.objectContaining({ current: 1, total: 1 }),
    );
  });

  it('should flag critical drift', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'user-1' }] as any);
    prisma.memory.findMany.mockResolvedValue([
      { id: 'm1', raw: 'test' },
    ] as any);
    ensembleService.embedAll.mockResolvedValue({
      embeddings: [
        { model: 'model-a', embedding: [0.1], dimensions: 1, latencyMs: 5 },
      ],
      totalMs: 5,
    } as any);
    driftDetectionService.measureBatchDrift.mockResolvedValue([
      { cosineDrift: 0.3, flagged: true },
    ] as any);
    driftDetectionService.summarizeDrift.mockReturnValue({
      avgCosineDrift: 0.3,
      maxCosineDrift: 0.5,
    } as any);
    prisma.driftSnapshot.create.mockResolvedValue({} as any);

    const result = await service.analyzeNow('acc-123');

    expect(result.snapshots[0].alertLevel).toBe('critical');
    expect(result.summary).toContain('critical');
  });

  it('should dedupe repeated enqueue calls while a job is active', () => {
    const first = service.enqueue('acc-123');
    const second = service.enqueue('acc-123');

    expect(second.jobId).toBe(first.jobId);
    expect(['queued', 'running']).toContain(second.status);
  });

  it('should return a queued job immediately', () => {
    const result = service.enqueue('acc-123');

    expect(result.jobId).toMatch(/^drift_/);
    expect(result.status).toBe('queued');
    expect(result.progress.message).toContain('Queued');
  });
});
