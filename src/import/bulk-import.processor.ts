import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import {
  ImportExecutionService,
  BULK_IMPORT_QUEUE,
  BULK_IMPORT_JOB,
} from './import-execution.service';
import { BulkImportJobData } from './import.types';

/**
 * BulkImportProcessor
 *
 * BullMQ worker for the bulk-import-v2 queue.
 * Delegates actual processing to ImportExecutionService.processJob().
 */
@Processor(BULK_IMPORT_QUEUE)
export class BulkImportProcessor extends WorkerHost {
  private readonly logger = new Logger(BulkImportProcessor.name);

  constructor(private readonly executionService: ImportExecutionService) {
    super();
  }

  async process(job: Job<BulkImportJobData>): Promise<void> {
    switch (job.name) {
      case BULK_IMPORT_JOB:
        this.logger.log(
          `Processing bulk import job: ${job.id} (jobId=${job.data.jobId})`,
        );
        return this.executionService.processJob(job.data);

      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }
}
