import { NotFoundException } from '@nestjs/common';
import { ImportJobService } from './import-job.service';
import { ImportStats, RowError } from './import.types';

describe('ImportJobService', () => {
  let service: ImportJobService;

  beforeEach(() => {
    service = new ImportJobService();
  });

  // ── createJob ──────────────────────────────────────────────────────────────

  describe('createJob', () => {
    it('should create a job and return a jobId', () => {
      const result = service.createJob('user-1');
      expect(result).toHaveProperty('jobId');
      expect(typeof result.jobId).toBe('string');
      expect(result.jobId.length).toBeGreaterThan(0);
    });

    it('should initialize job with PROCESSING status', () => {
      const { jobId } = service.createJob('user-1');
      const job = service.getJob(jobId);
      expect(job.status).toBe('PROCESSING');
    });

    it('should initialize progress to 0', () => {
      const { jobId } = service.createJob('user-1');
      const job = service.getJob(jobId);
      expect(job.progress).toBe(0);
    });

    it('should initialize stats to zero counts', () => {
      const { jobId } = service.createJob('user-1');
      const job = service.getJob(jobId);
      expect(job.stats).toEqual({
        profileCount: 0,
        memoryCount: 0,
        errorCount: 0,
      });
    });

    it('should initialize errors as empty array', () => {
      const { jobId } = service.createJob('user-1');
      const job = service.getJob(jobId);
      expect(job.errors).toEqual([]);
    });

    it('should store the userId on the job', () => {
      const { jobId } = service.createJob('user-abc');
      const job = service.getJob(jobId);
      expect(job.userId).toBe('user-abc');
    });

    it('should generate unique jobIds for concurrent jobs', () => {
      const a = service.createJob('user-1');
      const b = service.createJob('user-1');
      expect(a.jobId).not.toBe(b.jobId);
    });

    it('should increment size for each created job', () => {
      expect(service.size).toBe(0);
      service.createJob('user-1');
      expect(service.size).toBe(1);
      service.createJob('user-2');
      expect(service.size).toBe(2);
    });
  });

  // ── getJob ─────────────────────────────────────────────────────────────────

  describe('getJob', () => {
    it('should return a copy of the job state', () => {
      const { jobId } = service.createJob('user-1');
      const job = service.getJob(jobId);
      expect(job.jobId).toBe(jobId);
    });

    it('should throw NotFoundException for unknown jobId', () => {
      expect(() => service.getJob('nonexistent')).toThrow(NotFoundException);
    });

    it('should throw NotFoundException with descriptive message', () => {
      expect(() => service.getJob('bad-id')).toThrow(
        'Import job not found: bad-id',
      );
    });

    it('should return a shallow copy (mutations do not affect stored state)', () => {
      const { jobId } = service.createJob('user-1');
      const job = service.getJob(jobId);
      job.status = 'COMPLETED';
      // original should still be PROCESSING
      const fresh = service.getJob(jobId);
      expect(fresh.status).toBe('PROCESSING');
    });
  });

  // ── updateProgress ─────────────────────────────────────────────────────────

  describe('updateProgress', () => {
    it('should update the progress value', () => {
      const { jobId } = service.createJob('user-1');
      service.updateProgress(jobId, 0.5, {});
      const job = service.getJob(jobId);
      expect(job.progress).toBe(0.5);
    });

    it('should merge partial stats', () => {
      const { jobId } = service.createJob('user-1');
      service.updateProgress(jobId, 0.3, { profileCount: 5 });
      const job = service.getJob(jobId);
      expect(job.stats.profileCount).toBe(5);
      expect(job.stats.memoryCount).toBe(0); // unchanged
    });

    it('should clamp progress to max 1.0', () => {
      const { jobId } = service.createJob('user-1');
      service.updateProgress(jobId, 1.9, {});
      const job = service.getJob(jobId);
      expect(job.progress).toBe(1);
    });

    it('should clamp progress to min 0.0', () => {
      const { jobId } = service.createJob('user-1');
      service.updateProgress(jobId, -0.5, {});
      const job = service.getJob(jobId);
      expect(job.progress).toBe(0);
    });

    it('should throw NotFoundException for unknown jobId', () => {
      expect(() => service.updateProgress('bad', 0.5, {})).toThrow(
        NotFoundException,
      );
    });

    it('should update updatedAt timestamp', () => {
      const { jobId } = service.createJob('user-1');
      const before = service.getJob(jobId).updatedAt;
      // Small delay to ensure timestamp difference
      jest.useFakeTimers();
      jest.advanceTimersByTime(100);
      service.updateProgress(jobId, 0.1, {});
      jest.useRealTimers();
      const after = service.getJob(jobId).updatedAt;
      expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  // ── addError ───────────────────────────────────────────────────────────────

  describe('addError', () => {
    it('should append an error to the job errors list', () => {
      const { jobId } = service.createJob('user-1');
      const error: RowError = { rowNumber: 3, message: 'Bad row' };
      service.addError(jobId, error);
      const job = service.getJob(jobId);
      expect(job.errors).toHaveLength(1);
      expect(job.errors[0]).toEqual(error);
    });

    it('should increment errorCount in stats', () => {
      const { jobId } = service.createJob('user-1');
      service.addError(jobId, { rowNumber: 1, message: 'err 1' });
      service.addError(jobId, { rowNumber: 2, message: 'err 2' });
      const job = service.getJob(jobId);
      expect(job.stats.errorCount).toBe(2);
    });

    it('should accumulate multiple errors in order', () => {
      const { jobId } = service.createJob('user-1');
      service.addError(jobId, { rowNumber: 1, message: 'first' });
      service.addError(jobId, { rowNumber: 2, message: 'second' });
      const job = service.getJob(jobId);
      expect(job.errors[0].message).toBe('first');
      expect(job.errors[1].message).toBe('second');
    });

    it('should throw NotFoundException for unknown jobId', () => {
      expect(() =>
        service.addError('bad', { rowNumber: 1, message: 'x' }),
      ).toThrow(NotFoundException);
    });
  });

  // ── completeJob ────────────────────────────────────────────────────────────

  describe('completeJob', () => {
    it('should mark job as COMPLETED', () => {
      const { jobId } = service.createJob('user-1');
      const stats: ImportStats = {
        profileCount: 10,
        memoryCount: 50,
        errorCount: 0,
      };
      service.completeJob(jobId, stats);
      const job = service.getJob(jobId);
      expect(job.status).toBe('COMPLETED');
    });

    it('should set progress to 1 on completion', () => {
      const { jobId } = service.createJob('user-1');
      service.completeJob(jobId, {
        profileCount: 1,
        memoryCount: 1,
        errorCount: 0,
      });
      const job = service.getJob(jobId);
      expect(job.progress).toBe(1);
    });

    it('should store the final stats', () => {
      const { jobId } = service.createJob('user-1');
      const stats: ImportStats = {
        profileCount: 5,
        memoryCount: 25,
        errorCount: 2,
      };
      service.completeJob(jobId, stats);
      const job = service.getJob(jobId);
      expect(job.stats).toEqual(stats);
    });

    it('should throw NotFoundException for unknown jobId', () => {
      const stats: ImportStats = {
        profileCount: 0,
        memoryCount: 0,
        errorCount: 0,
      };
      expect(() => service.completeJob('bad', stats)).toThrow(
        NotFoundException,
      );
    });
  });

  // ── failJob ────────────────────────────────────────────────────────────────

  describe('failJob', () => {
    it('should mark job as FAILED', () => {
      const { jobId } = service.createJob('user-1');
      service.failJob(jobId, 'Unexpected crash');
      const job = service.getJob(jobId);
      expect(job.status).toBe('FAILED');
    });

    it('should append a job-level error with rowNumber 0', () => {
      const { jobId } = service.createJob('user-1');
      service.failJob(jobId, 'DB unavailable');
      const job = service.getJob(jobId);
      expect(job.errors).toHaveLength(1);
      expect(job.errors[0].rowNumber).toBe(0);
      expect(job.errors[0].message).toContain('DB unavailable');
    });

    it('should include the reason in the error message', () => {
      const { jobId } = service.createJob('user-1');
      service.failJob(jobId, 'timeout');
      const job = service.getJob(jobId);
      expect(job.errors[0].message).toContain('timeout');
    });

    it('should throw NotFoundException for unknown jobId', () => {
      expect(() => service.failJob('bad', 'reason')).toThrow(NotFoundException);
    });

    it('should preserve existing row errors when failing', () => {
      const { jobId } = service.createJob('user-1');
      service.addError(jobId, { rowNumber: 5, message: 'row-level error' });
      service.failJob(jobId, 'fatal');
      const job = service.getJob(jobId);
      expect(job.errors).toHaveLength(2);
      expect(job.errors[0].rowNumber).toBe(5);
    });
  });

  // ── size ───────────────────────────────────────────────────────────────────

  describe('size getter', () => {
    it('should return 0 for an empty service', () => {
      expect(service.size).toBe(0);
    });

    it('should return the correct count after adding jobs', () => {
      service.createJob('user-1');
      service.createJob('user-2');
      service.createJob('user-3');
      expect(service.size).toBe(3);
    });
  });

  // ── edge cases / lifecycle ─────────────────────────────────────────────────

  describe('lifecycle edge cases', () => {
    it('should allow progress updates after errors are added', () => {
      const { jobId } = service.createJob('user-1');
      service.addError(jobId, { rowNumber: 1, message: 'err' });
      service.updateProgress(jobId, 0.8, { memoryCount: 100 });
      const job = service.getJob(jobId);
      expect(job.progress).toBe(0.8);
      expect(job.stats.memoryCount).toBe(100);
      expect(job.errors).toHaveLength(1);
    });

    it('should handle zero-value progress update (0.0) correctly', () => {
      const { jobId } = service.createJob('user-1');
      service.updateProgress(jobId, 0, {});
      const job = service.getJob(jobId);
      expect(job.progress).toBe(0);
    });

    it('should handle exact 1.0 progress without clamping side effects', () => {
      const { jobId } = service.createJob('user-1');
      service.updateProgress(jobId, 1.0, {});
      const job = service.getJob(jobId);
      expect(job.progress).toBe(1);
    });

    it('should allow completeJob after partial progress updates', () => {
      const { jobId } = service.createJob('user-1');
      service.updateProgress(jobId, 0.5, { profileCount: 3 });
      service.completeJob(jobId, {
        profileCount: 10,
        memoryCount: 40,
        errorCount: 1,
      });
      const job = service.getJob(jobId);
      expect(job.status).toBe('COMPLETED');
      expect(job.stats.profileCount).toBe(10); // overwritten by final stats
    });
  });
});
