import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CsvParserService } from './csv-parser.service';
import { ImportMappingService } from './import-mapping.service';
import { ImportExecutionService, BULK_IMPORT_QUEUE } from './import-execution.service';
import { ImportJobService } from './import-job.service';
import { ImportController } from './import.controller';
import { BulkImportProcessor } from './bulk-import.processor';
import { AccountModule } from '../account/account.module';

const hasRedis = !!(
  process.env.REDIS_URL ||
  process.env.REDIS_HOST ||
  process.env.BULL_REDIS_URL
);

/** Register the BullMQ queue only when Redis is available */
const bullImports = hasRedis
  ? [BullModule.registerQueue({ name: BULK_IMPORT_QUEUE })]
  : [];

/** Register the BullMQ processor only when Redis is available */
const bullProviders = hasRedis ? [BulkImportProcessor] : [];

/**
 * ImportModule
 *
 * Provides the bulk import API for EntityProfiles.
 * Routes:
 *   POST   /v1/profiles/import/preview  — dry-run
 *   POST   /v1/profiles/import          — kick off async job (202 Accepted)
 *   GET    /v1/profiles/import/:jobId   — poll job status
 */
@Module({
  imports: [AccountModule, ...bullImports],
  controllers: [ImportController],
  providers: [
    CsvParserService,
    ImportMappingService,
    ImportExecutionService,
    ImportJobService,
    ...bullProviders,
  ],
  exports: [ImportExecutionService, ImportJobService],
})
export class ImportModule {}
