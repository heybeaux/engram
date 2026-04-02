import { Test, TestingModule } from '@nestjs/testing';
import { DreamCycleQueueProducer } from './dream-cycle-queue.producer';
import { getFlowProducerToken } from '@nestjs/bullmq';
import { DREAM_CYCLE_QUEUE, DREAM_CYCLE_JOBS } from './dream-cycle.queue';

const mockFlowProducer = {
  add: jest.fn().mockResolvedValue({}),
};

describe('DreamCycleQueueProducer', () => {
  let producer: DreamCycleQueueProducer;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DreamCycleQueueProducer,
        {
          provide: getFlowProducerToken(DREAM_CYCLE_QUEUE),
          useValue: mockFlowProducer,
        },
      ],
    }).compile();

    producer = module.get<DreamCycleQueueProducer>(DreamCycleQueueProducer);
  });

  describe('enqueue', () => {
    it('should return a runId with correct prefix', async () => {
      const runId = await producer.enqueue('user-1');
      expect(runId).toMatch(/^dc-\d+-[a-f0-9]{8}$/);
    });

    it('should call flowProducer.add once', async () => {
      await producer.enqueue('user-2');
      expect(mockFlowProducer.add).toHaveBeenCalledTimes(1);
    });

    it('should pass correct userId in job data', async () => {
      await producer.enqueue('user-abc');
      const call = mockFlowProducer.add.mock.calls[0][0];
      expect(call.data.userId).toBe('user-abc');
    });

    it('should default dryRun to false', async () => {
      await producer.enqueue('user-1');
      const call = mockFlowProducer.add.mock.calls[0][0];
      expect(call.data.dryRun).toBe(false);
    });

    it('should pass dryRun=true when specified', async () => {
      await producer.enqueue('user-1', { dryRun: true });
      const call = mockFlowProducer.add.mock.calls[0][0];
      expect(call.data.dryRun).toBe(true);
    });

    it('should pass maxLlmCalls and maxMemories when provided', async () => {
      await producer.enqueue('user-1', { maxLlmCalls: 10, maxMemories: 50 });
      const call = mockFlowProducer.add.mock.calls[0][0];
      expect(call.data.maxLlmCalls).toBe(10);
      expect(call.data.maxMemories).toBe(50);
    });

    it('should leave maxLlmCalls/maxMemories undefined by default', async () => {
      await producer.enqueue('user-1');
      const call = mockFlowProducer.add.mock.calls[0][0];
      expect(call.data.maxLlmCalls).toBeUndefined();
      expect(call.data.maxMemories).toBeUndefined();
    });

    it('should enqueue REPORT job at the top level', async () => {
      await producer.enqueue('user-1');
      const call = mockFlowProducer.add.mock.calls[0][0];
      expect(call.name).toBe(DREAM_CYCLE_JOBS.REPORT);
      expect(call.queueName).toBe(DREAM_CYCLE_QUEUE);
    });

    it('should nest ARCHIVAL under REPORT as a child', async () => {
      await producer.enqueue('user-1');
      const call = mockFlowProducer.add.mock.calls[0][0];
      const archivalJob = call.children.find(
        (c: any) => c.name === DREAM_CYCLE_JOBS.ARCHIVAL,
      );
      expect(archivalJob).toBeDefined();
    });

    it('should nest IDENTITY under ARCHIVAL as a child', async () => {
      await producer.enqueue('user-1');
      const call = mockFlowProducer.add.mock.calls[0][0];
      const archivalJob = call.children.find(
        (c: any) => c.name === DREAM_CYCLE_JOBS.ARCHIVAL,
      );
      const identityJob = archivalJob?.children?.find(
        (c: any) => c.name === DREAM_CYCLE_JOBS.IDENTITY,
      );
      expect(identityJob).toBeDefined();
    });

    it('should nest PATTERNS under IDENTITY (via DRIFT → CLUSTERING)', async () => {
      await producer.enqueue('user-1');
      const call = mockFlowProducer.add.mock.calls[0][0];
      const archivalJob = call.children.find(
        (c: any) => c.name === DREAM_CYCLE_JOBS.ARCHIVAL,
      );
      const identityJob = archivalJob?.children?.find(
        (c: any) => c.name === DREAM_CYCLE_JOBS.IDENTITY,
      );
      // IDENTITY → DRIFT → CLUSTERING → PATTERNS
      const driftJob = identityJob?.children?.find((c: any) => c.name === DREAM_CYCLE_JOBS.DRIFT);
      const clusteringJob = driftJob?.children?.find((c: any) => c.name === DREAM_CYCLE_JOBS.CLUSTERING);
      const patternsJob = clusteringJob?.children?.find((c: any) => c.name === DREAM_CYCLE_JOBS.PATTERNS);
      expect(patternsJob).toBeDefined();
    });

    it('should include DRIFT under IDENTITY', async () => {
      await producer.enqueue('user-1');
      const call = mockFlowProducer.add.mock.calls[0][0];
      const archivalJob = call.children.find(
        (c: any) => c.name === DREAM_CYCLE_JOBS.ARCHIVAL,
      );
      const identityJob = archivalJob?.children?.find(
        (c: any) => c.name === DREAM_CYCLE_JOBS.IDENTITY,
      );
      const driftJob = identityJob.children.find(
        (c: any) => c.name === DREAM_CYCLE_JOBS.DRIFT,
      );
      expect(driftJob).toBeDefined();
    });

    it('should configure retry with exponential backoff (3 attempts)', async () => {
      await producer.enqueue('user-1');
      const call = mockFlowProducer.add.mock.calls[0][0];
      expect(call.opts.attempts).toBe(3);
      expect(call.opts.backoff.type).toBe('exponential');
    });

    it('should generate a unique runId each time', async () => {
      const id1 = await producer.enqueue('user-1');
      const id2 = await producer.enqueue('user-1');
      expect(id1).not.toBe(id2);
    });

    it('should propagate flowProducer.add errors', async () => {
      mockFlowProducer.add.mockRejectedValueOnce(new Error('Queue unavailable'));
      await expect(producer.enqueue('user-1')).rejects.toThrow(
        'Queue unavailable',
      );
    });
  });
});
