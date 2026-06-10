import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import { MemoryJobQueueService, MemoryJob } from './memory-job-queue.service';
import { rlsContext } from '../prisma/rls-context';

/**
 * Processes memory jobs from the in-process queue.
 * Handles extraction (phase 1) and embedding (phase 2) as separate steps
 * so embedding failures don't block extraction.
 *
 * HEY-344: Background job processing
 * HEY-345: Decoupled extraction from embedding with retry
 */
@Injectable()
export class MemoryJobProcessorService implements OnModuleInit {
  private readonly logger = new Logger(MemoryJobProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: MemoryPipelineService,
    private readonly queue: MemoryJobQueueService,
  ) {}

  onModuleInit() {
    this.queue.registerProcessor((job) => this.processJob(job));
    this.logger.log('[JobProcessor] Registered with job queue');
  }

  /**
   * Process a single memory job: extraction + embedding.
   * The pipeline.extractAndEmbed already handles the full flow,
   * but we wrap it for status tracking and RLS context.
   */
  async processJob(job: MemoryJob): Promise<void> {
    this.logger.log(
      `[JobProcessor] Processing memory ${job.memoryId} (attempt ${job.attempts})`,
    );

    job.status = 'extracting';
    job.updatedAt = new Date();

    // Resolve accountId for RLS
    const user = await this.prisma.user.findUnique({
      where: { id: job.userId },
      select: {
        id: true,
        externalId: true,
        displayName: true,
        accountId: true,
      },
    });
    const accountId = user?.accountId;

    const run = async () => {
      await this.pipeline.extractAndEmbed(
        job.memoryId,
        job.raw,
        job.userId,
        job.extractionContext,
      );
    };

    if (accountId) {
      // Ingest H1 fix: do NOT hold a DB connection open across the embed HTTP
      // call.  Previously the entire extractAndEmbed (LLM extraction + embed
      // network call + DB writes) ran inside one $transaction, pinning a pool
      // connection for the full duration and causing pool exhaustion under bulk
      // load.
      //
      // New approach: set app.current_account_id for the session (not LOCAL so
      // it survives outside a transaction), then run extractAndEmbed outside
      // any wrapping transaction. Each Prisma query inside the pipeline gets
      // its own short connection from the pool.
      const sanitized = accountId.replace(/[^a-zA-Z0-9_-]/g, '');
      await this.prisma.$executeRawUnsafe(
        `SET app.current_account_id = '${sanitized}'`,
      );
      await rlsContext.run(this.prisma as any, run);
    } else {
      await run();
    }

    this.logger.log(`[JobProcessor] Completed memory ${job.memoryId}`);
  }
}
