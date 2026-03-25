import { Injectable, Logger } from '@nestjs/common';
import { InjectFlowProducer } from '@nestjs/bullmq';
import { FlowProducer } from 'bullmq';
import { randomUUID } from 'crypto';
import {
  DREAM_CYCLE_QUEUE,
  DREAM_CYCLE_JOBS,
  DreamCycleJobData,
} from './dream-cycle.queue';

@Injectable()
export class DreamCycleQueueProducer {
  private readonly logger = new Logger(DreamCycleQueueProducer.name);

  constructor(
    @InjectFlowProducer(DREAM_CYCLE_QUEUE)
    private readonly flowProducer: FlowProducer,
  ) {}

  async enqueue(
    userId: string,
    options: {
      dryRun?: boolean;
      maxLlmCalls?: number;
      maxMemories?: number;
    } = {},
  ): Promise<string> {
    const runId = `dc-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const jobData: DreamCycleJobData = {
      runId,
      userId,
      dryRun: options.dryRun ?? false,
      maxLlmCalls: options.maxLlmCalls,
      maxMemories: options.maxMemories,
    };
    const defaultOpts = {
      attempts: 3,
      backoff: { type: 'exponential' as const, delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
      // ENG-49: Bump job timeout to 3600s (1hr) to prevent dream cycle timeouts
      // as memory corpus grows and Timeline Synthesis stage adds processing time.
      // Previously defaulted to BullMQ default (no limit on some versions).
      jobId: undefined,
      delay: 0,
      timeout: 3600000, // 1 hour in ms
    };

    await this.flowProducer.add({
      name: DREAM_CYCLE_JOBS.REPORT,
      queueName: DREAM_CYCLE_QUEUE,
      data: jobData,
      opts: defaultOpts,
      children: [
        {
          name: DREAM_CYCLE_JOBS.IDENTITY,
          queueName: DREAM_CYCLE_QUEUE,
          data: jobData,
          opts: defaultOpts,
          children: [
            {
              name: DREAM_CYCLE_JOBS.PATTERNS,
              queueName: DREAM_CYCLE_QUEUE,
              data: jobData,
              opts: defaultOpts,
              children: [
                {
                  name: DREAM_CYCLE_JOBS.TIERING,
                  queueName: DREAM_CYCLE_QUEUE,
                  data: jobData,
                  opts: defaultOpts,
                  children: [
                    {
                      name: DREAM_CYCLE_JOBS.PENDING,
                      queueName: DREAM_CYCLE_QUEUE,
                      data: jobData,
                      opts: defaultOpts,
                    },
                  ],
                },
              ],
            },
            {
              name: DREAM_CYCLE_JOBS.DRIFT,
              queueName: DREAM_CYCLE_QUEUE,
              data: jobData,
              opts: defaultOpts,
            },
          ],
        },
      ],
    });

    this.logger.log(
      `Dream Cycle flow enqueued: runId=${runId} userId=${userId}`,
    );
    return runId;
  }
}
