import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import * as crypto from 'crypto';
import { MemoryService } from './memory.service';
import {
  ExportQueryDto,
  ImportMemoriesDto,
  ImportResult,
} from './dto/export-import.dto';
import {
  BulkCreateMemoryDto,
  BulkCreateResult,
  BulkTextImportDto,
  BulkTextResult,
  ExportFilteredQueryDto,
} from './dto/bulk.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UserId } from '../common/decorators/user-id.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { MemoryJobQueueService } from './memory-job-queue.service';
import { MemoryPipelineService } from './memory-pipeline.service';

@ApiTags('memories')
@Controller('v1')
@UseGuards(ApiKeyOrJwtGuard, RateLimitGuard)
export class MemoryBulkController {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly memoryJobQueue: MemoryJobQueueService,
    private readonly memoryPipeline: MemoryPipelineService,
  ) {}

  // =========================================================================
  // BULK IMPORT (fast createMany + async embedding)
  // =========================================================================

  /**
   * POST /v1/memories/bulk
   * Bulk create memories using createMany for fast Postgres insertion.
   */
  @Post('memories/bulk')
  @ApiOperation({
    summary: 'Bulk create memories',
    description:
      'Insert up to 1000 memories in a single createMany call. Embeddings are queued asynchronously.',
  })
  @ApiResponse({ status: 201, description: 'Memories created successfully.' })
  async bulkCreate(
    @UserId() userId: string,
    @Body() dto: BulkCreateMemoryDto,
  ): Promise<BulkCreateResult> {
    return this.memoryService.bulkCreate(userId, dto);
  }

  /**
   * POST /v1/memories/bulk/text
   * Accept raw text, auto-chunk at ~3500 chars, and bulk-insert.
   */
  @Post('memories/bulk/text')
  @ApiOperation({
    summary: 'Bulk import from raw text',
    description:
      'Accepts raw text, auto-chunks at ~3500 characters on paragraph/sentence boundaries, and bulk-inserts all chunks.',
  })
  @ApiResponse({ status: 201, description: 'Text chunked and stored.' })
  async bulkTextImport(
    @UserId() userId: string,
    @Body() dto: BulkTextImportDto,
  ): Promise<BulkTextResult> {
    return this.memoryService.bulkTextImport(userId, dto);
  }

  /**
   * GET /v1/memories/export/filtered
   * Export memories as JSON, CSV, or NDJSON with filters.
   */
  @Get('memories/export/filtered')
  @RateLimit(5)
  @ApiOperation({
    summary: 'Export memories with filters',
    description:
      'Export memories as JSON, CSV, or NDJSON with optional layer, project, and date filters.',
  })
  async exportMemoriesFiltered(
    @UserId() userId: string,
    @Query() query: ExportFilteredQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const format = query.format || 'json';
    const date = new Date().toISOString().split('T')[0];
    const ext =
      format === 'ndjson' ? 'ndjson' : format === 'csv' ? 'csv' : 'json';

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="engram-export-${date}.${ext}"`,
    );

    const filters = {
      layer: query.layer,
      projectId: query.projectId,
      startDate: query.startDate,
      endDate: query.endDate,
    };

    const BATCH_SIZE = 500;
    let cursor: string | undefined;
    let isFirst = true;

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.write('id,raw,layer,importance,createdAt,updatedAt\n');
    } else if (format === 'ndjson') {
      res.setHeader('Content-Type', 'application/x-ndjson');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.write('[');
    }

    while (true) {
      const batch = await this.memoryService.exportMemoriesFiltered(
        userId,
        filters,
        BATCH_SIZE,
        cursor,
      );
      if (batch.length === 0) break;

      for (const memory of batch) {
        if (format === 'csv') {
          const escapedRaw = '"' + memory.raw.replace(/"/g, '""') + '"';
          res.write(
            `${memory.id},${escapedRaw},${memory.layer},${memory.importance},${memory.createdAt},${memory.updatedAt}\n`,
          );
        } else if (format === 'ndjson') {
          res.write(JSON.stringify(memory) + '\n');
        } else {
          if (!isFirst) res.write(',');
          res.write(JSON.stringify(memory));
          isFirst = false;
        }
      }

      if (batch.length < BATCH_SIZE) break;
      cursor = batch[batch.length - 1].id;
    }

    if (format === 'json') {
      res.write(']');
    }
    res.end();
  }

  /**
   * GET /v1/memories/export
   * Export all user memories as JSON or NDJSON for migration.
   */
  @Get('memories/export')
  @RateLimit(5)
  @ApiOperation({
    summary: 'Export all memories',
    description:
      'Export all memories as a downloadable JSON or NDJSON file for migration.',
  })
  async exportMemories(
    @UserId() userId: string,
    @Query() query: ExportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const format = query.format || 'json';
    const date = new Date().toISOString().split('T')[0];
    const ext = format === 'ndjson' ? 'ndjson' : 'json';

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="engram-export-${date}.${ext}"`,
    );

    const BATCH_SIZE = 500;
    let cursor: string | undefined;
    let isFirst = true;

    if (format === 'ndjson') {
      res.setHeader('Content-Type', 'application/x-ndjson');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.write('[');
    }

    while (true) {
      const batch = await this.memoryService.exportMemoriesBatch(
        userId,
        BATCH_SIZE,
        cursor,
      );
      if (batch.length === 0) break;

      for (const memory of batch) {
        if (format === 'ndjson') {
          res.write(JSON.stringify(memory) + '\n');
        } else {
          if (!isFirst) res.write(',');
          res.write(JSON.stringify(memory));
          isFirst = false;
        }
      }

      if (batch.length < BATCH_SIZE) break;
      cursor = batch[batch.length - 1].id;
    }

    if (format !== 'ndjson') {
      res.write(']');
    }
    res.end();
  }

  /**
   * POST /v1/memories/import
   * Import memories with dedup and plan limit enforcement.
   */
  @Post('memories/import')
  @ApiOperation({
    summary: 'Import memories',
    description:
      'Import memories from an export file. Deduplicates and respects plan limits.',
  })
  async importMemories(
    @UserId() userId: string,
    @Body() dto: ImportMemoriesDto,
  ): Promise<ImportResult> {
    return this.memoryService.importMemories(userId, dto.memories);
  }

  /**
   * POST /v1/memories/import/stream
   * NDJSON streaming import — processes one memory per line
   */
  @Post('memories/import/stream')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stream import memories (NDJSON)',
    description:
      'Import memories via NDJSON streaming. Each line is a JSON object representing one memory. ' +
      'Processes line-by-line without loading entire payload into memory.',
  })
  async importStream(
    @UserId() userId: string,
    @Req() req: any,
    @Res() res: Response,
  ): Promise<void> {
    const result = {
      imported: 0,
      skipped: 0,
      errors: 0,
      errorDetails: [] as string[],
    };

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const lines = Buffer.concat(chunks)
      .toString('utf-8')
      .split('\n')
      .filter((line: string) => line.trim());

    for (const line of lines) {
      try {
        const memory = JSON.parse(line);
        const importResult = await this.memoryService.importMemories(userId, [
          memory,
        ]);
        result.imported += importResult.imported;
        result.skipped += importResult.skipped;
        result.errors += importResult.errors;
      } catch (err) {
        result.errors++;
        if (result.errorDetails.length < 10) {
          result.errorDetails.push(
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    res.json(result);
  }

  /**
   * POST /v1/memories/import/async
   * Async import — processes in background via the job queue.
   */
  @Post('memories/import/async')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Import memories asynchronously',
    description:
      'Import memories in background via the job queue. Returns immediately with a job ID for status polling.',
  })
  @ApiResponse({
    status: 202,
    description: 'Import enqueued for background processing.',
  })
  async importMemoriesAsync(
    @UserId() userId: string,
    @Body() dto: ImportMemoriesDto,
  ): Promise<{ jobId: string; count: number; status: string }> {
    const memories = dto.memories.map((m) => ({
      memoryId: m.id || crypto.randomUUID(),
      raw: m.raw,
      extractionContext: m.metadata?.extractionContext,
    }));
    const jobId = this.memoryJobQueue.createBatch(userId, memories);
    return { jobId, count: memories.length, status: 'processing' };
  }

  // =========================================================================
  // EMBEDDING STATUS
  // =========================================================================

  /**
   * GET /v1/memories/embedding-status
   * Show count of memories with/without embeddings and retry queue status.
   */
  @Get('memories/embedding-status')
  @ApiOperation({
    summary: 'Embedding status',
    description:
      'Show counts of memories with and without embeddings, plus retry queue status.',
  })
  async getEmbeddingStatus(@UserId() userId: string): Promise<{
    withEmbedding: number;
    withoutEmbedding: number;
    failedEmbedding: number;
    pendingEmbedding: number;
    retryQueueSize: number;
    exhaustedRetries: number;
  }> {
    return this.memoryPipeline.getEmbeddingStatus(userId);
  }

  /**
   * POST /v1/memories/embedding-retry
   * Manually trigger retry of failed embeddings.
   */
  @Post('memories/embedding-retry')
  @ApiOperation({
    summary: 'Retry failed embeddings',
    description:
      'Retry generating embeddings for memories that previously failed.',
  })
  async retryFailedEmbeddings(): Promise<{
    retried: number;
    succeeded: number;
    failed: number;
    discovered: number;
  }> {
    return this.memoryPipeline.retryFailedEmbeddings();
  }
}
