import { Injectable, Logger } from '@nestjs/common';
import { InjectFlowProducer } from '@nestjs/bullmq';
import { FlowProducer, FlowJob } from 'bullmq';
import { randomUUID } from 'crypto';
import {
  DREAM_CYCLE_QUEUE,
  DREAM_CYCLE_JOBS,
  DREAM_CYCLE_STAGE_TIMEOUTS,
  DreamCycleJobData,
  DreamCycleJobName,
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
      cursor: { llmCallsUsed: 0 },
    };

    const flow = this.buildFlow(jobData);
    await this.flowProducer.add(flow);

    this.logger.log(
      `Dream Cycle flow enqueued: runId=${runId} userId=${userId}`,
    );
    return runId;
  }

  /**
   * Build the BullMQ FlowJob DAG.
   *
   * Execution order (children complete before parent):
   *   PENDING → TIERING → CONSOLIDATION → PATTERNS → CLUSTERING → DRIFT → IDENTITY → REPORT
   *
   * Each stage is a separate job with independent retry & timeout.
   */
  buildFlow(jobData: DreamCycleJobData): FlowJob {
    return this.job(DREAM_CYCLE_JOBS.REPORT, jobData, [
      this.job(DREAM_CYCLE_JOBS.IDENTITY, jobData, [
        this.job(DREAM_CYCLE_JOBS.DRIFT, jobData, [
          this.job(DREAM_CYCLE_JOBS.CLUSTERING, jobData, [
            this.job(DREAM_CYCLE_JOBS.PATTERNS, jobData, [
              this.job(DREAM_CYCLE_JOBS.CONSOLIDATION, jobData, [
                this.job(DREAM_CYCLE_JOBS.TIERING, jobData, [
                  this.job(DREAM_CYCLE_JOBS.PENDING, jobData),
                ]),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]);
  }

  private job(
    name: DreamCycleJobName,
    data: DreamCycleJobData,
    children?: FlowJob[],
  ): FlowJob {
    const node: FlowJob = {
      name,
      queueName: DREAM_CYCLE_QUEUE,
      data,
      opts: {
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
        // timeout not supported in BullMQ v5 JobsOptions; handled via worker lockDuration
      },
    };
    if (children?.length) {
      node.children = children;
    }
    return node;
  }
}
