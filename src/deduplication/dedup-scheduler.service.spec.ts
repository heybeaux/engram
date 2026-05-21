import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DedupSchedulerService } from './dedup-scheduler.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { DedupQueueProducer } from './dedup-queue.producer';
import { CandidateStatus } from './dto/deduplication.dto';

describe('DedupSchedulerService', () => {
  let service: DedupSchedulerService;

  const mockPrisma = {
    dedupConfig: {
      findFirst: jest.fn(),
    },
    mergeCandidate: {
      count: jest.fn(),
    },
  };

  const mockProducer = {
    enqueueBatch: jest.fn(),
    enqueueBacklog: jest.fn(),
  };

  const mockConfig = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const values: Record<string, string> = {
        DEDUP_PIPELINE_ENABLED: 'true',
        DEDUP_BACKLOG_THRESHOLD: '1000',
      };
      return values[key] ?? defaultValue;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DedupSchedulerService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: DedupQueueProducer, useValue: mockProducer },
      ],
    }).compile();

    service = module.get<DedupSchedulerService>(DedupSchedulerService);
  });

  describe('handleScheduledDedup', () => {
    it('should enqueue batch job when enabled and config exists', async () => {
      mockPrisma.dedupConfig.findFirst.mockResolvedValue({
        id: 'config-1',
        batchEnabled: true,
      });

      await service.handleScheduledDedup();

      expect(mockProducer.enqueueBatch).toHaveBeenCalledWith({
        trigger: 'cron',
        batchSize: 50,
      });
    });

    it('should skip when pipeline is disabled', async () => {
      // Create a new instance with disabled config
      const disabledConfig = {
        get: jest.fn((key: string, defaultValue?: string) => {
          if (key === 'DEDUP_PIPELINE_ENABLED') return 'false';
          if (key === 'DEDUP_BACKLOG_THRESHOLD') return '1000';
          return defaultValue;
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DedupSchedulerService,
          { provide: ConfigService, useValue: disabledConfig },
          { provide: ServicePrismaService, useValue: mockPrisma },
          { provide: DedupQueueProducer, useValue: mockProducer },
        ],
      }).compile();

      const disabledService = module.get<DedupSchedulerService>(
        DedupSchedulerService,
      );

      await disabledService.handleScheduledDedup();

      expect(mockProducer.enqueueBatch).not.toHaveBeenCalled();
    });

    it('should skip when no users have batchEnabled', async () => {
      mockPrisma.dedupConfig.findFirst.mockResolvedValue(null);

      await service.handleScheduledDedup();

      expect(mockProducer.enqueueBatch).not.toHaveBeenCalled();
    });
  });

  describe('handleBacklogDrain', () => {
    it('should enqueue drain when pending exceeds threshold', async () => {
      mockPrisma.mergeCandidate.count.mockResolvedValue(1500);

      await service.handleBacklogDrain();

      expect(mockProducer.enqueueBatch).toHaveBeenCalledWith({
        trigger: 'backlog-drain',
        batchSize: 100,
      });
    });

    it('should skip when pending is below threshold', async () => {
      mockPrisma.mergeCandidate.count.mockResolvedValue(500);

      await service.handleBacklogDrain();

      expect(mockProducer.enqueueBatch).not.toHaveBeenCalled();
    });

    it('should skip when pipeline is disabled', async () => {
      const disabledConfig = {
        get: jest.fn((key: string, defaultValue?: string) => {
          if (key === 'DEDUP_PIPELINE_ENABLED') return 'false';
          if (key === 'DEDUP_BACKLOG_THRESHOLD') return '1000';
          return defaultValue;
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DedupSchedulerService,
          { provide: ConfigService, useValue: disabledConfig },
          { provide: ServicePrismaService, useValue: mockPrisma },
          { provide: DedupQueueProducer, useValue: mockProducer },
        ],
      }).compile();

      const disabledService = module.get<DedupSchedulerService>(
        DedupSchedulerService,
      );
      mockPrisma.mergeCandidate.count.mockResolvedValue(5000);

      await disabledService.handleBacklogDrain();

      expect(mockProducer.enqueueBatch).not.toHaveBeenCalled();
    });
  });

  describe('getPendingCount', () => {
    it('should return count of pending candidates', async () => {
      mockPrisma.mergeCandidate.count.mockResolvedValue(7468);

      const count = await service.getPendingCount();

      expect(count).toBe(7468);
      expect(mockPrisma.mergeCandidate.count).toHaveBeenCalledWith({
        where: { status: CandidateStatus.PENDING },
      });
    });
  });

  describe('triggerManualDrain', () => {
    it('should enqueue batch and backlog jobs', async () => {
      mockPrisma.mergeCandidate.count.mockResolvedValue(200);

      const result = await service.triggerManualDrain();

      expect(result).toEqual({ enqueued: true, pendingCount: 200 });
      expect(mockProducer.enqueueBatch).toHaveBeenCalledWith({
        trigger: 'manual',
        batchSize: 100,
      });
      expect(mockProducer.enqueueBacklog).toHaveBeenCalled();
    });

    it('should return enqueued=false when no pending candidates', async () => {
      mockPrisma.mergeCandidate.count.mockResolvedValue(0);

      const result = await service.triggerManualDrain();

      expect(result).toEqual({ enqueued: false, pendingCount: 0 });
      expect(mockProducer.enqueueBatch).not.toHaveBeenCalled();
    });
  });
});
