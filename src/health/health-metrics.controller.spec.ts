import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { HealthMetricsController } from './health-metrics.controller';
import { HealthMetricsService } from './health-metrics.service';
import { HealthSnapshotService, METRIC_NAMES } from './health-snapshot.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

const mockMetricsService = {
  getLatest: jest.fn(),
  computeAndPersist: jest.fn(),
};

const mockSnapshotService = {
  takeSnapshot: jest.fn(),
  getHistory: jest.fn(),
  getLatestAll: jest.fn(),
};

const makeReq = (
  overrides: Partial<{ accountId: string; agent: { id: string } }> = {},
) => ({
  accountId: 'acc-123',
  agent: { id: 'agent-1' },
  ...overrides,
});

describe('HealthMetricsController', () => {
  let controller: HealthMetricsController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthMetricsController],
      providers: [
        { provide: HealthMetricsService, useValue: mockMetricsService },
        { provide: HealthSnapshotService, useValue: mockSnapshotService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<HealthMetricsController>(HealthMetricsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ── GET /v1/health/metrics ────────────────────────────────────────────────

  describe('getMetrics', () => {
    it('should return latest metrics from the service', async () => {
      const report = { score: 0.95, issues: [] };
      mockMetricsService.getLatest.mockResolvedValue(report);

      const result = await controller.getMetrics();

      expect(mockMetricsService.getLatest).toHaveBeenCalled();
      expect(result).toEqual(report);
    });

    it('should propagate service errors', async () => {
      mockMetricsService.getLatest.mockRejectedValue(new Error('DB error'));

      await expect(controller.getMetrics()).rejects.toThrow('DB error');
    });
  });

  // ── POST /v1/health/metrics/refresh ──────────────────────────────────────

  describe('refreshMetrics', () => {
    it('should call computeAndPersist and return updated report', async () => {
      const report = { score: 0.88, refreshedAt: '2026-03-15T04:00:00Z' };
      mockMetricsService.computeAndPersist.mockResolvedValue(report);

      const result = await controller.refreshMetrics();

      expect(mockMetricsService.computeAndPersist).toHaveBeenCalled();
      expect(result).toEqual(report);
    });

    it('should propagate errors from computeAndPersist', async () => {
      mockMetricsService.computeAndPersist.mockRejectedValue(
        new Error('Compute failed'),
      );

      await expect(controller.refreshMetrics()).rejects.toThrow(
        'Compute failed',
      );
    });
  });

  // ── POST /v1/health/metrics/snapshot ─────────────────────────────────────

  describe('takeSnapshot', () => {
    it('should take a snapshot with accountId and agentId from request', async () => {
      const snapshotResult = { snapshotId: 'snap-1', metrics: [] };
      mockSnapshotService.takeSnapshot.mockResolvedValue(snapshotResult);

      const result = await controller.takeSnapshot(makeReq());

      expect(mockSnapshotService.takeSnapshot).toHaveBeenCalledWith(
        'acc-123',
        'agent-1',
      );
      expect(result).toEqual(snapshotResult);
    });

    it('should default accountId to "unknown" when missing from request', async () => {
      mockSnapshotService.takeSnapshot.mockResolvedValue({});

      await controller.takeSnapshot({ agent: { id: 'agent-1' } });

      expect(mockSnapshotService.takeSnapshot).toHaveBeenCalledWith(
        'unknown',
        'agent-1',
      );
    });

    it('should pass undefined agentId when agent not on request', async () => {
      mockSnapshotService.takeSnapshot.mockResolvedValue({});

      await controller.takeSnapshot({ accountId: 'acc-456' });

      expect(mockSnapshotService.takeSnapshot).toHaveBeenCalledWith(
        'acc-456',
        undefined,
      );
    });

    it('should propagate snapshot service errors', async () => {
      mockSnapshotService.takeSnapshot.mockRejectedValue(
        new Error('Snapshot failed'),
      );

      await expect(controller.takeSnapshot(makeReq())).rejects.toThrow(
        'Snapshot failed',
      );
    });
  });

  // ── GET /v1/health/metrics/history ────────────────────────────────────────

  describe('getHistory', () => {
    it('should return history for a valid metric', async () => {
      const history = [{ value: 0.9, recordedAt: '2026-03-14T00:00:00Z' }];
      mockSnapshotService.getHistory.mockResolvedValue(history);

      const result = await controller.getHistory(
        makeReq(),
        'memory_freshness',
        '30',
      );

      expect(mockSnapshotService.getHistory).toHaveBeenCalledWith(
        'acc-123',
        'memory_freshness',
        30,
      );
      expect(result).toEqual(history);
    });

    it('should default to 30 days when daysStr is not provided', async () => {
      mockSnapshotService.getHistory.mockResolvedValue([]);

      await controller.getHistory(makeReq(), 'dedup_health');

      expect(mockSnapshotService.getHistory).toHaveBeenCalledWith(
        'acc-123',
        'dedup_health',
        30,
      );
    });

    it('should cap days at 365', async () => {
      mockSnapshotService.getHistory.mockResolvedValue([]);

      await controller.getHistory(makeReq(), 'embedding_coverage', '999');

      expect(mockSnapshotService.getHistory).toHaveBeenCalledWith(
        'acc-123',
        'embedding_coverage',
        365,
      );
    });

    it('should enforce minimum of 1 day', async () => {
      mockSnapshotService.getHistory.mockResolvedValue([]);

      await controller.getHistory(makeReq(), 'consolidation_health', '0');

      expect(mockSnapshotService.getHistory).toHaveBeenCalledWith(
        'acc-123',
        'consolidation_health',
        1,
      );
    });

    it('should throw BadRequestException for invalid metric name', async () => {
      await expect(
        controller.getHistory(makeReq(), 'invalid_metric'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException with valid metric list in message', async () => {
      await expect(
        controller.getHistory(makeReq(), 'bad_metric'),
      ).rejects.toThrow('Invalid metric');
    });

    it('should throw BadRequestException for empty metric string', async () => {
      await expect(controller.getHistory(makeReq(), '')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when days is NaN string', async () => {
      await expect(
        controller.getHistory(makeReq(), 'memory_freshness', 'abc'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept all valid METRIC_NAMES', async () => {
      mockSnapshotService.getHistory.mockResolvedValue([]);

      for (const metric of METRIC_NAMES) {
        await expect(
          controller.getHistory(makeReq(), metric, '7'),
        ).resolves.not.toThrow();
      }

      expect(mockSnapshotService.getHistory).toHaveBeenCalledTimes(
        METRIC_NAMES.length,
      );
    });

    it('should use accountId from request', async () => {
      mockSnapshotService.getHistory.mockResolvedValue([]);

      await controller.getHistory(
        makeReq({ accountId: 'custom-acc' }),
        'memory_vitality',
        '14',
      );

      expect(mockSnapshotService.getHistory).toHaveBeenCalledWith(
        'custom-acc',
        'memory_vitality',
        14,
      );
    });
  });

  // ── GET /v1/health/metrics/latest ─────────────────────────────────────────

  describe('getLatest', () => {
    it('should return latest snapshots for all metrics', async () => {
      const latestAll = {
        memory_freshness: { value: 0.9, recordedAt: '2026-03-15' },
        embedding_coverage: null,
        consolidation_health: { value: 0.8, recordedAt: '2026-03-15' },
        dedup_health: null,
        memory_vitality: { value: 0.75, recordedAt: '2026-03-15' },
      };
      mockSnapshotService.getLatestAll.mockResolvedValue(latestAll);

      const result = await controller.getLatest(makeReq());

      expect(mockSnapshotService.getLatestAll).toHaveBeenCalledWith('acc-123');
      expect(result).toEqual(latestAll);
    });

    it('should default accountId to "unknown" when not present', async () => {
      mockSnapshotService.getLatestAll.mockResolvedValue({});

      await controller.getLatest({});

      expect(mockSnapshotService.getLatestAll).toHaveBeenCalledWith('unknown');
    });

    it('should propagate service errors', async () => {
      mockSnapshotService.getLatestAll.mockRejectedValue(new Error('DB error'));

      await expect(controller.getLatest(makeReq())).rejects.toThrow('DB error');
    });
  });
});
