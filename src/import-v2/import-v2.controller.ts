import {
  Controller,
  Post,
  Get,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Body,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { Agent } from '../common/decorators/user-id.decorator';
import { ImportPreviewService } from './import-preview.service';
import { ImportJobService } from '../import/import-job.service';
import { EntityProfileService } from '../entity-profile/entity-profile.service';
import { MappingConfigDto } from './dto/mapping-config.dto';
import { BULK_IMPORT_V2_QUEUE, BulkImportV2JobData } from './import-v2.queue';
import { MappingConfig } from '../import/import.types';

@ApiTags('Profiles — Bulk Import v2')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/profiles/import')
export class ImportV2Controller {
  private readonly logger = new Logger(ImportV2Controller.name);

  constructor(
    private readonly previewService: ImportPreviewService,
    private readonly jobService: ImportJobService,
    private readonly profileService: EntityProfileService,
    @Optional()
    @InjectQueue(BULK_IMPORT_V2_QUEUE)
    private readonly importQueue?: Queue,
  ) {}

  private get hasRedis(): boolean {
    return !!(
      process.env.REDIS_URL ||
      process.env.REDIS_HOST ||
      process.env.BULL_REDIS_URL
    );
  }

  // ── POST /v1/profiles/import/preview ──────────────────────────────────────

  @Post('preview')
  @ApiOperation({
    summary: 'Preview a CSV import without writing to DB',
    description:
      'Upload a CSV file with a mapping config to see what profiles/memories would be created. Returns first 100 rows.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'CSV file' },
        mapping: { type: 'string', description: 'MappingConfig as JSON string' },
      },
      required: ['file', 'mapping'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Preview result with profiles, memories, errors and stats',
  })
  @UseInterceptors(FileInterceptor('file'))
  async preview(
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    @Body('mapping') mappingJson: string,
  ) {
    if (!file) {
      throw new BadRequestException('A CSV file is required (field: "file")');
    }
    if (!mappingJson) {
      throw new BadRequestException('A mapping config is required (field: "mapping")');
    }

    let config: MappingConfig;
    try {
      config = JSON.parse(mappingJson) as MappingConfig;
    } catch {
      throw new BadRequestException('mapping must be valid JSON');
    }

    this.validateMappingConfig(config);

    return this.previewService.preview(file.buffer, config);
  }

  // ── POST /v1/profiles/import ───────────────────────────────────────────────

  @Post()
  @ApiOperation({
    summary: 'Start a bulk profile import',
    description: 'Upload a CSV and mapping config. Returns a jobId for async processing.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'CSV file' },
        mapping: { type: 'string', description: 'MappingConfig as JSON string' },
      },
      required: ['file', 'mapping'],
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Import job queued',
    schema: {
      example: { jobId: 'uuid-here', status: 'PROCESSING' },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async startImport(
    @Agent() agent: any,
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    @Body('mapping') mappingJson: string,
  ) {
    if (!file) {
      throw new BadRequestException('A CSV file is required (field: "file")');
    }
    if (!mappingJson) {
      throw new BadRequestException('A mapping config is required (field: "mapping")');
    }

    let config: MappingConfig;
    try {
      config = JSON.parse(mappingJson) as MappingConfig;
    } catch {
      throw new BadRequestException('mapping must be valid JSON');
    }

    this.validateMappingConfig(config);

    // Get userId from agent
    const userId = await this.profileService.getOrCreateUser(agent.id);

    // Create job record
    const { jobId } = this.jobService.createJob(userId);

    // Enqueue BullMQ job (if Redis is available)
    if (this.hasRedis && this.importQueue) {
      const jobData: BulkImportV2JobData = {
        jobId,
        userId,
        agentId: agent.id,
        fileBase64: file.buffer.toString('base64'),
        config: config as any,
      };

      await this.importQueue.add(
        'bulk-import:process',
        jobData,
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
        },
      );

      this.logger.log(`Queued bulk-import-v2 job: ${jobId}`);
    } else {
      this.logger.warn('Redis not available — import job created but not enqueued');
      this.jobService.failJob(jobId, 'Redis is not configured; async processing unavailable');
    }

    return { jobId, status: 'PROCESSING' };
  }

  // ── GET /v1/profiles/import/:jobId ────────────────────────────────────────

  @Get(':jobId')
  @ApiOperation({ summary: 'Get import job status' })
  @ApiParam({ name: 'jobId', description: 'Import job UUID' })
  @ApiResponse({
    status: 200,
    description: 'Job status with progress and stats',
    schema: {
      example: {
        status: 'PROCESSING',
        progress: 0.75,
        stats: { profileCount: 75, memoryCount: 60, errorCount: 2 },
        errors: [],
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJobStatus(@Param('jobId') jobId: string) {
    const job = this.jobService.getJob(jobId);
    return {
      status: job.status,
      progress: job.progress,
      stats: job.stats,
      errors: job.errors,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private validateMappingConfig(config: MappingConfig): void {
    if (!config?.profileMapping?.name) {
      throw new BadRequestException(
        'mapping.profileMapping.name is required (must reference a CSV column)',
      );
    }
  }
}
