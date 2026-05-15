import { BadRequestException } from '@nestjs/common';
import {
  MemoryJobQueueService,
  MAX_BATCH_SIZE,
  MemoryJob,
} from './memory-job-queue.service';

/**
 * GIN-37 regression helpers
 *
 * The original bug: `processNext()` was `async` and guarded concurrency via a
 * plain `activeCount` check that was not protected against re-entrant callers.
 * Multiple simultaneous `.finally()` callbacks (one per finishing job) each
 * entered the scheduling loop and read the same stale `activeCount` before any
 * of them had incremented it, causing more jobs to be dispatched than the
 * `concurrency` cap allowed (double-dispatch / over-dispatch race).
 *
 * The fix introduces a `_scheduling` boolean that makes the loop non-reentrant:
 * only one "tick" of the loop runs at a time. Subsequent callers return
 * immediately and let the running tick pick up new work on its next iteration.
 */

describe('MemoryJobQueueService', () => {
  let service: MemoryJobQueueService;

  beforeEach(() => {
    service = new MemoryJobQueueService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should create a batch and return a batch ID', () => {
    service.registerProcessor(async () => {});
    const batchId = service.createBatch('user-1', [
      { memoryId: 'm1', raw: 'hello' },
      { memoryId: 'm2', raw: 'world' },
    ]);
    expect(batchId).toBeDefined();
    expect(typeof batchId).toBe('string');
    const status = service.getBatchStatus(batchId);
    expect(status).not.toBeNull();
    expect(status!.total).toBe(2);
  });

  it('should reject batches exceeding MAX_BATCH_SIZE', () => {
    service.registerProcessor(async () => {});
    const memories = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({
      memoryId: `m${i}`,
      raw: `memory ${i}`,
    }));
    expect(() => service.createBatch('user-1', memories)).toThrow(
      BadRequestException,
    );
  });

  it('should process all jobs to completion', async () => {
    const processed: string[] = [];
    service.registerProcessor(async (job: MemoryJob) => {
      processed.push(job.memoryId);
    });
    const batchId = service.createBatch('user-1', [
      { memoryId: 'm1', raw: 'a' },
      { memoryId: 'm2', raw: 'b' },
      { memoryId: 'm3', raw: 'c' },
    ]);

    // Wait for processing
    await new Promise((r) => setTimeout(r, 200));

    const status = service.getBatchStatus(batchId);
    expect(status!.status).toBe('completed');
    expect(status!.completed).toBe(3);
    expect(status!.failed).toBe(0);
    expect(processed).toEqual(expect.arrayContaining(['m1', 'm2', 'm3']));
  });

  it('should retry failed jobs and mark as failed after max attempts', async () => {
    let attempts = 0;
    service.registerProcessor(async () => {
      attempts++;
      throw new Error('processing error');
    });

    const batchId = service.createBatch('user-1', [
      { memoryId: 'm1', raw: 'fail' },
    ]);

    // Wait for retries (3 attempts with exponential backoff: 1s, 4s — but test should be fast enough with the first few)
    await new Promise((r) => setTimeout(r, 8000));

    const status = service.getBatchStatus(batchId);
    expect(status!.failed).toBe(1);
    expect(status!.status).toBe('failed');
    expect(status!.errors).toHaveLength(1);
    expect(status!.errors[0].error).toBe('processing error');
    expect(attempts).toBe(3); // maxAttempts = 3
  }, 15000);

  it('should respect concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    service.registerProcessor(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
    });

    service.createBatch(
      'user-1',
      Array.from({ length: 10 }, (_, i) => ({
        memoryId: `m${i}`,
        raw: `memory ${i}`,
      })),
    );

    await new Promise((r) => setTimeout(r, 1000));

    // Default concurrency is 3
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('should return null for unknown batch ID', () => {
    expect(service.getBatchStatus('nonexistent')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // GIN-37 race-condition regression tests
  // -------------------------------------------------------------------------

  /**
   * The core race: when multiple jobs complete at roughly the same time,
   * their `.finally()` callbacks all queue as microtasks. Before the fix,
   * each callback independently entered the scheduling while-loop and all
   * read the same stale `activeCount` (because none had incremented it yet),
   * dispatching more simultaneous jobs than the concurrency limit allows.
   *
   * This test measures the peak number of concurrently executing jobs over
   * many runs. With the bug present the peak would routinely exceed the cap.
   * With the fix it must never exceed it.
   */
  it('GIN-37: never dispatches more concurrent jobs than the concurrency cap (stress)', async () => {
    const CONCURRENCY = 3;
    const TOTAL_JOBS = 30;
    const ITERATIONS = 10;

    // Access the private concurrency field via casting so we can lower it for
    // a tighter test that still exercises the exact code path.
    (service as any).concurrency = CONCURRENCY;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      let activePeak = 0;
      let currentActive = 0;
      let violation = false;

      service.registerProcessor(async () => {
        currentActive++;
        if (currentActive > CONCURRENCY) {
          violation = true;
        }
        activePeak = Math.max(activePeak, currentActive);
        // Yield to the event loop so that any competing `.finally()` callbacks
        // that were queued as microtasks have a chance to run.
        await Promise.resolve();
        await Promise.resolve();
        currentActive--;
      });

      service.createBatch(
        'user-stress',
        Array.from({ length: TOTAL_JOBS }, (_, i) => ({
          memoryId: `stress-${iter}-${i}`,
          raw: `memory ${i}`,
        })),
      );

      // Wait for all jobs to finish.
      await new Promise<void>((resolve) => {
        const check = () => {
          const status = service.getBatchStatus(
            (service as any).batches.keys().next().value,
          );
          if (status && status.pending === 0) {
            resolve();
          } else {
            setTimeout(check, 20);
          }
        };
        setTimeout(check, 20);
      });

      expect(violation).toBe(false);
      expect(activePeak).toBeGreaterThan(0);
      expect(activePeak).toBeLessThanOrEqual(CONCURRENCY);

      // Reset state for next iteration.
      (service as any).batches.clear();
      (service as any).pendingJobs.length = 0;
      (service as any).activeCount = 0;
      (service as any).processor = undefined;
    }
  }, 30000);

  /**
   * Simulates two concurrent `createBatch` calls in the same event-loop turn
   * — the scenario where the old code was most likely to double-dispatch.
   * Both batches are created before any job has started, so processNext() is
   * called twice with activeCount = 0 in the same synchronous frame.
   *
   * The fix's non-reentrant guard ensures the second call is a no-op and lets
   * the first call's loop pick up all available work, so the peak active count
   * still never exceeds the cap.
   */
  it('GIN-37: concurrent createBatch calls in the same tick do not over-dispatch', async () => {
    const CONCURRENCY = 2;
    (service as any).concurrency = CONCURRENCY;

    let peakActive = 0;
    let currentActive = 0;
    let overDispatch = false;

    service.registerProcessor(async () => {
      currentActive++;
      if (currentActive > CONCURRENCY) overDispatch = true;
      peakActive = Math.max(peakActive, currentActive);
      await new Promise((r) => setTimeout(r, 10));
      currentActive--;
    });

    // Both calls are synchronous — processNext() fires twice before any job
    // has actually been dispatched.
    service.createBatch('user-a', [
      { memoryId: 'a1', raw: 'a' },
      { memoryId: 'a2', raw: 'b' },
    ]);
    service.createBatch('user-b', [
      { memoryId: 'b1', raw: 'c' },
      { memoryId: 'b2', raw: 'd' },
    ]);

    await new Promise((r) => setTimeout(r, 300));

    expect(overDispatch).toBe(false);
    expect(peakActive).toBeLessThanOrEqual(CONCURRENCY);
    expect(peakActive).toBeGreaterThan(0);
  });

  /**
   * Verifies that when the scheduling guard blocks a re-entrant call, work is
   * not silently dropped: all jobs that were enqueued while the loop was active
   * still get processed eventually.
   *
   * This is the liveness half of the GIN-37 fix — correctness requires BOTH
   * that we never over-dispatch AND that we never under-deliver.
   */
  it('GIN-37: no jobs are silently dropped when scheduling guard blocks re-entry', async () => {
    const TOTAL = 15;
    const processed: string[] = [];

    service.registerProcessor(async (job: MemoryJob) => {
      // A short async yield makes job completions overlap in microtask timing,
      // maximising the chance that re-entrant processNext() calls are blocked.
      await Promise.resolve();
      processed.push(job.memoryId);
    });

    service.createBatch(
      'user-liveness',
      Array.from({ length: TOTAL }, (_, i) => ({
        memoryId: `live-${i}`,
        raw: `data ${i}`,
      })),
    );

    // Allow enough time for all 15 jobs to complete at concurrency = 3.
    await new Promise((r) => setTimeout(r, 500));

    expect(processed).toHaveLength(TOTAL);
    const status = service.getBatchStatus(
      [...(service as any).batches.keys()][0],
    );
    expect(status!.status).toBe('completed');
    expect(status!.completed).toBe(TOTAL);
  });

  /**
   * Enqueuing individual jobs via `enqueueEmbedding` while a batch is already
   * saturating the concurrency slots is another trigger for the original race.
   * The scheduling guard must handle this without over-dispatch.
   */
  it('GIN-37: enqueueEmbedding during active batch does not exceed concurrency', async () => {
    const CONCURRENCY = 3;
    (service as any).concurrency = CONCURRENCY;

    let currentActive = 0;
    let peakActive = 0;
    let overDispatch = false;

    service.registerProcessor(async () => {
      currentActive++;
      if (currentActive > CONCURRENCY) overDispatch = true;
      peakActive = Math.max(peakActive, currentActive);
      await new Promise((r) => setTimeout(r, 20));
      currentActive--;
    });

    // Start a batch that saturates the concurrency slots.
    service.createBatch(
      'user-batch',
      Array.from({ length: 9 }, (_, i) => ({
        memoryId: `batch-${i}`,
        raw: `data ${i}`,
      })),
    );

    // Enqueue individual jobs while the batch is running — this is the
    // second processNext() invocation path.
    service.enqueueEmbedding('single-1', 'user-single', 'extra 1');
    service.enqueueEmbedding('single-2', 'user-single', 'extra 2');
    service.enqueueEmbedding('single-3', 'user-single', 'extra 3');

    await new Promise((r) => setTimeout(r, 500));

    expect(overDispatch).toBe(false);
    expect(peakActive).toBeLessThanOrEqual(CONCURRENCY);
  });

  it('should report partial status when some jobs fail', async () => {
    let callCount = 0;
    service.registerProcessor(async (job: MemoryJob) => {
      callCount++;
      if (job.memoryId === 'm2') {
        throw new Error('selective failure');
      }
    });

    const batchId = service.createBatch('user-1', [
      { memoryId: 'm1', raw: 'ok' },
      { memoryId: 'm2', raw: 'fail' },
      { memoryId: 'm3', raw: 'ok' },
    ]);

    // Wait for processing including retries for m2
    await new Promise((r) => setTimeout(r, 8000));

    const status = service.getBatchStatus(batchId);
    expect(status!.status).toBe('partial');
    expect(status!.completed).toBe(2);
    expect(status!.failed).toBe(1);
  }, 15000);
});
