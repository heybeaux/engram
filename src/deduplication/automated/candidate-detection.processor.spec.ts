import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { CandidateDetectionProcessor, DEDUP_AUTO_JOBS } from './candidate-detection.processor';
import { CandidateDetectionService } from './candidate-detection.service';
import { DedupClassificationService } from './dedup-classification.service';
import { DedupResolutionService } from './dedup-resolution.service';

const mockDetection = {
  detectCandidates: jest.fn(),
};

const mockClassification = {
  processPendingCandidates: jest.fn(),
};

const mockResolution = {
  processClassifiedCandidates: jest.fn(),
};

function makeJob(name: string): Job {
  return { name, data: {} } as unknown as Job;
}

describe('CandidateDetectionProcessor', () => {
  let processor: CandidateDetectionProcessor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidateDetectionProcessor,
        { provide: CandidateDetectionService, useValue: mockDetection },
        { provide: DedupClassificationService, useValue: mockClassification },
        { provide: DedupResolutionService, useValue: mockResolution },
      ],
    }).compile();

    processor = module.get<CandidateDetectionProcessor>(CandidateDetectionProcessor);
    jest.clearAllMocks();
  });

  describe('DETECT_CANDIDATES job', () => {
    it('chains all 3 phases: detection → classification → resolution', async () => {
      mockDetection.detectCandidates.mockResolvedValue({ scanned: 5, created: 2, skipped: 0 });
      mockClassification.processPendingCandidates
        .mockResolvedValueOnce({ processed: 2, errors: 0 })
        .mockResolvedValueOnce({ processed: 0, errors: 0 });
      mockResolution.processClassifiedCandidates
        .mockResolvedValueOnce({ processed: 2, autoMerged: 1, autoConsolidated: 0, queued: 1, skipped: 0, errors: 0 })
        .mockResolvedValueOnce({ processed: 0, autoMerged: 0, autoConsolidated: 0, queued: 0, skipped: 0, errors: 0 });

      const result = await processor.process(makeJob(DEDUP_AUTO_JOBS.DETECT_CANDIDATES));

      expect(mockDetection.detectCandidates).toHaveBeenCalledTimes(1);
      expect(mockClassification.processPendingCandidates).toHaveBeenCalledTimes(2);
      expect(mockResolution.processClassifiedCandidates).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ classifiedTotal: 2, resolvedTotal: 2 });
    });

    it('drains classification backlog across multiple batches', async () => {
      mockDetection.detectCandidates.mockResolvedValue({ scanned: 0, created: 0, skipped: 0 });
      mockClassification.processPendingCandidates
        .mockResolvedValueOnce({ processed: 10, errors: 0 })
        .mockResolvedValueOnce({ processed: 10, errors: 0 })
        .mockResolvedValueOnce({ processed: 0, errors: 0 });
      mockResolution.processClassifiedCandidates
        .mockResolvedValue({ processed: 0, autoMerged: 0, autoConsolidated: 0, queued: 0, skipped: 0, errors: 0 });

      const result = await processor.process(makeJob(DEDUP_AUTO_JOBS.DETECT_CANDIDATES));

      expect(mockClassification.processPendingCandidates).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ classifiedTotal: 20 });
    });
  });

  describe('CLASSIFY_CANDIDATES job', () => {
    it('delegates to classification service', async () => {
      mockClassification.processPendingCandidates.mockResolvedValue({ processed: 5, errors: 0 });

      const result = await processor.process(makeJob(DEDUP_AUTO_JOBS.CLASSIFY_CANDIDATES));

      expect(mockClassification.processPendingCandidates).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ processed: 5, errors: 0 });
    });
  });

  describe('RESOLVE_CANDIDATES job', () => {
    it('delegates to resolution service', async () => {
      const stats = { processed: 3, autoMerged: 2, autoConsolidated: 0, queued: 1, skipped: 0, errors: 0 };
      mockResolution.processClassifiedCandidates.mockResolvedValue(stats);

      const result = await processor.process(makeJob(DEDUP_AUTO_JOBS.RESOLVE_CANDIDATES));

      expect(mockResolution.processClassifiedCandidates).toHaveBeenCalledTimes(1);
      expect(result).toEqual(stats);
    });
  });

  describe('unknown job', () => {
    it('returns null for unrecognized job names', async () => {
      const result = await processor.process(makeJob('unknown:job'));
      expect(result).toBeNull();
    });
  });
});
