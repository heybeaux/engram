import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { DedupPipelineService } from './dedup-pipeline.service';
import { CandidateDetectionService } from './candidate-detection.service';
import { DedupClassificationService } from './dedup-classification.service';
import { DedupResolutionService } from './dedup-resolution.service';
import { DEDUP_AUTO_DETECTION_QUEUE } from './candidate-detection.processor';

const mockDetection = {
  detectCandidates: jest.fn().mockResolvedValue({ scanned: 10, created: 3, skipped: 0 }),
};

const mockClassification = {
  processPendingCandidates: jest.fn().mockResolvedValue({ processed: 3, errors: 0 }),
};

const mockResolution = {
  processClassifiedCandidates: jest.fn().mockResolvedValue({
    processed: 3,
    autoMerged: 2,
    autoConsolidated: 0,
    queued: 1,
    skipped: 0,
    errors: 0,
  }),
};

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
};

const mockConfig = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: jest.fn((_key: string): any => 'true'),
};

describe('DedupPipelineService', () => {
  let service: DedupPipelineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DedupPipelineService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: CandidateDetectionService, useValue: mockDetection },
        { provide: DedupClassificationService, useValue: mockClassification },
        { provide: DedupResolutionService, useValue: mockResolution },
        { provide: getQueueToken(DEDUP_AUTO_DETECTION_QUEUE), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<DedupPipelineService>(DedupPipelineService);
    jest.clearAllMocks();

    // Re-wire mocks after clearAllMocks
    mockDetection.detectCandidates.mockResolvedValue({ scanned: 10, created: 3, skipped: 0 });
    mockClassification.processPendingCandidates.mockResolvedValue({ processed: 3, errors: 0 });
    mockResolution.processClassifiedCandidates.mockResolvedValue({
      processed: 3,
      autoMerged: 2,
      autoConsolidated: 0,
      queued: 1,
      skipped: 0,
      errors: 0,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockConfig.get as jest.Mock).mockImplementation((_key: string): any => 'true');
    mockQueue.add.mockResolvedValue({ id: 'job-1' });
  });

  describe('runPipeline', () => {
    it('runs all 3 phases in sequence', async () => {
      const result = await service.runPipeline();

      expect(mockDetection.detectCandidates).toHaveBeenCalledTimes(1);
      expect(mockClassification.processPendingCandidates).toHaveBeenCalledTimes(1);
      expect(mockResolution.processClassifiedCandidates).toHaveBeenCalledTimes(1);

      expect(result.skipped).toBe(false);
      expect(result.detection.scanned).toBe(10);
      expect(result.classification.processed).toBe(3);
      expect(result.resolution.autoMerged).toBe(2);
    });

    it('returns skipped result when pipeline is disabled', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig.get as jest.Mock).mockImplementation((key: string): any => {
        if (key === 'DEDUP_PIPELINE_ENABLED') return 'false';
        return undefined;
      });

      const result = await service.runPipeline();

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('DEDUP_PIPELINE_ENABLED=false');
      expect(mockDetection.detectCandidates).not.toHaveBeenCalled();
    });

    it('includes startedAt and finishedAt timestamps', async () => {
      const before = new Date();
      const result = await service.runPipeline();
      const after = new Date();

      expect(result.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.finishedAt.getTime()).toBeGreaterThanOrEqual(result.startedAt.getTime());
      expect(result.finishedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('handleDailyCron', () => {
    it('triggers runPipeline when enabled', async () => {
      const runSpy = jest.spyOn(service, 'runPipeline').mockResolvedValue({
        startedAt: new Date(),
        finishedAt: new Date(),
        detection: { scanned: 0, created: 0, skipped: 0 },
        classification: { processed: 0, errors: 0 },
        resolution: {
          processed: 0,
          autoMerged: 0,
          autoConsolidated: 0,
          queued: 0,
          skipped: 0,
          errors: 0,
        },
        skipped: false,
      });

      await service.handleDailyCron();
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it('skips runPipeline when disabled', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockConfig.get as jest.Mock).mockImplementation((key: string): any => {
        if (key === 'DEDUP_PIPELINE_ENABLED') return 'false';
        return undefined;
      });

      const runSpy = jest.spyOn(service, 'runPipeline');
      await service.handleDailyCron();
      expect(runSpy).not.toHaveBeenCalled();
    });
  });

  describe('enqueueDetection', () => {
    it('adds a job to the detection queue', async () => {
      await service.enqueueDetection();
      expect(mockQueue.add).toHaveBeenCalledWith(
        expect.any(String),
        {},
        expect.objectContaining({ attempts: 3 }),
      );
    });
  });
});
