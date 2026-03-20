import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { Agent } from '../common/decorators/user-id.decorator';
import { ImportExecutionService } from './import-execution.service';
import { ImportJobService } from './import-job.service';
import { MappingConfig } from './import.types';

@ApiTags('Profile Import')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/profiles/import')
export class ImportController {
  private readonly logger = new Logger(ImportController.name);

  constructor(
    private readonly executionService: ImportExecutionService,
    private readonly jobService: ImportJobService,
  ) {}

  // ── POST /v1/profiles/import/preview ─────────────────────────────────────────

  @Post('preview')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Dry-run import — preview what would be created' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'config'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'CSV file' },
        config: {
          type: 'string',
          description: 'JSON-encoded MappingConfig',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Preview of profiles and memories that would be created.',
  })
  @ApiResponse({ status: 400, description: 'Invalid CSV or mapping config.' })
  async preview(
    @Agent() agent: any,
    @UploadedFile() file: any,
    @Body('config') configJson: string,
  ) {
    const { buffer, config } = this.parseUpload(file, configJson);
    const userId = await this.resolveUserId(agent);
    return this.executionService.preview(buffer, config, userId);
  }

  // ── POST /v1/profiles/import ──────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Execute bulk import — kicks off async job' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'config'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'CSV file' },
        config: {
          type: 'string',
          description: 'JSON-encoded MappingConfig',
        },
      },
    },
  })
  @ApiResponse({
    status: 202,
    description: 'Import job accepted. Use jobId to poll status.',
  })
  @ApiResponse({ status: 400, description: 'Invalid CSV or mapping config.' })
  async execute(
    @Agent() agent: any,
    @UploadedFile() file: any,
    @Body('config') configJson: string,
  ) {
    const { buffer, config } = this.parseUpload(file, configJson);
    const userId = await this.resolveUserId(agent);
    const { jobId } = await this.executionService.execute(
      buffer,
      config,
      userId,
    );
    return { jobId, status: 'PROCESSING' as const };
  }

  // ── GET /v1/profiles/import/:jobId ───────────────────────────────────────────

  @Get(':jobId')
  @ApiOperation({ summary: 'Get import job status and progress' })
  @ApiParam({
    name: 'jobId',
    description: 'Import job UUID returned from execute endpoint',
  })
  @ApiResponse({
    status: 200,
    description: 'Job status, progress, stats, and errors.',
  })
  @ApiResponse({ status: 404, description: 'Job not found.' })
  async getStatus(@Agent() _agent: any, @Param('jobId') jobId: string) {
    const job = this.jobService.getJob(jobId);
    return {
      status: job.status,
      progress: job.progress,
      stats: job.stats,
      errors: job.errors,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private parseUpload(
    file: any,
    configJson: string | undefined,
  ): { buffer: Buffer; config: MappingConfig } {
    if (!file?.buffer) {
      throw new BadRequestException('A CSV file is required (field: "file")');
    }
    if (!configJson) {
      throw new BadRequestException(
        'A mapping config is required (field: "config")',
      );
    }

    let config: MappingConfig;
    try {
      config = JSON.parse(configJson);
    } catch {
      throw new BadRequestException('Invalid JSON in "config" field');
    }

    if (!config.profileMapping?.name) {
      throw new BadRequestException('config.profileMapping.name is required');
    }

    return { buffer: file.buffer, config };
  }

  /**
   * Resolve to a userId string. If agent has a userId, use it directly.
   * Otherwise fall back to the agent.id (agentId) — consumers can override.
   */
  private async resolveUserId(agent: any): Promise<string> {
    return agent?.userId ?? agent?.id ?? 'unknown';
  }
}
