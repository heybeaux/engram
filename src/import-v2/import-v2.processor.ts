import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { BULK_IMPORT_V2_QUEUE, BulkImportV2JobData } from './import-v2.queue';
import { ImportProcessingService } from './import-processing.service';
import { ImportJobService } from '../import/import-job.service';
import { MappingConfig } from '../import/import.types';

/**
 * BulkImportV2Processor
 *
 * BullMQ worker for the `bulk-import-v2` queue.
 * Reads the import job from the queue, processes all rows, and
 * updates the in-memory job state via ImportJobService.
 */
@Processor(BULK_IMPORT_V2_QUEUE)
export class BulkImportV2Processor extends WorkerHost {
  private readonly logger = new Logger(BulkImportV2Processor.name);

  constructor(
    private readonly processingService: ImportProcessingService,
    private readonly jobService: ImportJobService,
  ) {
    super();
  }

  async process(job: Job<BulkImportV2JobData>): Promise<void> {
    const { jobId, userId, fileBase64, config } = job.data;

    this.logger.log(
      `Processing bulk-import-v2 job: ${jobId} for user: ${userId}`,
    );

    try {
      const fileBuffer = Buffer.from(fileBase64, 'base64');

      // Cast config to internal MappingConfig type (same shape)
      const mappingConfig = config as unknown as MappingConfig;

      const result = await this.processingService.processImport(
        jobId,
        userId,
        fileBuffer,
        mappingConfig,
      );

      this.logger.log(
        `Bulk import [${jobId}] done: ${result.stats.profileCount} profiles, ${result.stats.memoryCount} memories, ${result.stats.errorCount} errors`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Bulk import [${jobId}] failed: ${message}`);
      this.jobService.failJob(jobId, message);
      throw err; // rethrow so BullMQ marks the job as failed
    }
  }
}
