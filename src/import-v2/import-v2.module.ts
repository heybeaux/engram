import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MulterModule } from '@nestjs/platform-express';
import { ImportV2Controller } from './import-v2.controller';
import { ImportPreviewService } from './import-preview.service';
import { ImportProcessingService } from './import-processing.service';
import { BulkImportV2Processor } from './import-v2.processor';
import { ImportJobService } from '../import/import-job.service';
import { CsvParserService } from '../import/csv-parser.service';
import { ImportMappingService } from '../import/import-mapping.service';
import { EntityProfileModule } from '../entity-profile/entity-profile.module';
import { BULK_IMPORT_V2_QUEUE } from './import-v2.queue';

const hasRedis = !!(
  process.env.REDIS_URL ||
  process.env.REDIS_HOST ||
  process.env.BULL_REDIS_URL
);

const bullImports = hasRedis
  ? [BullModule.registerQueue({ name: BULK_IMPORT_V2_QUEUE })]
  : [];

const bullProviders = hasRedis ? [BulkImportV2Processor] : [];

@Module({
  imports: [
    ...bullImports,
    MulterModule.register({
      limits: {
        fileSize: 10 * 1024 * 1024, // 10 MB max CSV
      },
    }),
    EntityProfileModule,
  ],
  controllers: [ImportV2Controller],
  providers: [
    ImportPreviewService,
    ImportProcessingService,
    ImportJobService,
    CsvParserService,
    ImportMappingService,
    ...bullProviders,
  ],
  exports: [ImportProcessingService, ImportPreviewService, ImportJobService],
})
export class ImportV2Module {}
