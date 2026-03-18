import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Headers,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import * as crypto from 'crypto';
import {
  MemoryService,
  MemoryWithExtraction,
  QueryResult,
  ContextResult,
} from './memory.service';
import {
  BackfillService,
  BackfillResult,
  UserIdentityBackfillResult,
} from './backfill.service';
import {
  ConsolidationService,
  ConsolidationResult,
} from './consolidation.service';
import { CreateMemoryDto, CreateMemoryBatchDto } from './dto/create-memory.dto';
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
import { QueryMemoryDto, LoadContextDto } from './dto/query-memory.dto';
import { UpdateMemoryDto } from './dto/update-memory.dto';
import { ContextualRecallService } from './contextual-recall.service';
import {
  ContextualRecallDto,
  ContextualRecallResponseDto,
} from './dto/contextual-recall.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UserId } from '../common/decorators/user-id.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { MemoryJobQueueService } from './memory-job-queue.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import { RetrievalSignalsService } from '../retrieval-signals/retrieval-signals.service';

@ApiTags('memories')
@Controller('v1')
@UseGuards(ApiKeyOrJwtGuard, RateLimitGuard)
export class MemoryController {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly backfillService: BackfillService,
    private readonly consolidationService: ConsolidationService,
    private readonly contextualRecallService: ContextualRecallService,
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly memoryJobQueue: MemoryJobQueueService,
    private readonly memoryPipeline: MemoryPipelineService,
    private readonly retrievalSignals: RetrievalSignalsService,
  ) {}

  /**
   * Resolve user IDs for account-wide search.
   * Works for all authenticated requests (instance keys, regular API keys, JWT).
   * If agentId is provided, scopes to that agent's users only.
   */
  private async resolveAccountUserIds(
    req: any,
    agentId?: string,
  ): Promise<string[] | null> {
    // Derive accountId from request or from the attached agent
    const accountId = req.accountId ?? req.agent?.accountId;
    if (!accountId) return null;

    const where: any = { deletedAt: null };
    if (agentId) {
      // Scope to users from the account that owns this agent
      where.account = { agents: { some: { id: agentId, deletedAt: null } } };
    } else {
      where.accountId = accountId;
    }

    const users = await this.prisma.user.findMany({
      where,
      select: { id: true },
    });
    return users.length > 0 ? users.map((u) => u.id) : null;
  }

  // =========================================================================
  // MEMORY CRUD
  // =========================================================================

  /**
   * POST /v1/memories
   * Create a single memory
   */
  @Post('memories')
  @ApiOperation({
    summary: 'Create a memory',
    description:
      'Store a single memory with automatic extraction and embedding.',
  })
  @ApiResponse({ status: 201, description: 'Memory created successfully.' })
  async remember(
    @UserId() userId: string,
    @Body() dto: CreateMemoryDto,
    @Headers('x-am-agent-id') headerAgentId?: string,
    @Req() req?: any,
  ): Promise<MemoryWithExtraction> {
    // agentId is ALWAYS server-authoritative: use the authenticated agent's id.
    // The x-am-agent-id header is accepted only as an optional hint for cross-agent
    // attribution (e.g. a proxy writing on behalf of another agent), but the guard
    // has already validated the actual calling agent via the API key.
    // This prevents clients from falsely attributing memories to other agents.
    dto.agentId = req?.agent?.id ?? headerAgentId ?? dto.agentId;
    return this.memoryService.remember(userId, dto);
  }

  /**
   * POST /v1/memories/batch
   * Create multiple memories (for conversation import)
   */
  @Post('memories/batch')
  @ApiOperation({
    summary: 'Create memories in batch',
    description:
      'Import multiple memories at once (e.g., conversation history).',
  })
  async rememberAll(
    @UserId() userId: string,
    @Body() dto: CreateMemoryBatchDto,
  ): Promise<{ created: number; failed: number }> {
    return this.memoryService.rememberAll(userId, dto);
  }

  /**
   * POST /v1/memories/batch/async
   * Enqueue memories for async background processing
   */
  @Post('memories/batch/async')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Create memories in batch (async)',
    description:
      'Enqueue multiple memories for background processing. Returns immediately with a job ID for status polling.',
  })
  @ApiResponse({ status: 202, description: 'Batch enqueued for processing.' })
  async rememberAllAsync(
    @UserId() userId: string,
    @Body() dto: CreateMemoryBatchDto,
  ): Promise<{ jobId: string; count: number; status: string }> {
    const memories = dto.memories.map((m) => ({
      memoryId: crypto.randomUUID(),
      raw: m.raw,
    }));
    const jobId = this.memoryJobQueue.createBatch(userId, memories);
    return { jobId, count: memories.length, status: 'processing' };
  }

  /**
   * GET /v1/memories/batch/:jobId/status
   * Get async batch job status
   */
  @Get('memories/batch/:jobId/status')
  @ApiOperation({
    summary: 'Get async batch job status',
    description: 'Poll for the status of an async batch memory creation job.',
  })
  async getBatchJobStatus(@Param('jobId') jobId: string): Promise<{
    jobId: string;
    status: string;
    total: number;
    completed: number;
    failed: number;
    pending: number;
    errors: Array<{ memoryId: string; error: string }>;
    createdAt: Date;
  }> {
    const status = this.memoryJobQueue.getBatchStatus(jobId);
    if (!status) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    return status;
  }

  // =========================================================================
  // BULK IMPORT (fast createMany + async embedding)
  // =========================================================================

  /**
   * POST /v1/memories/bulk
   * Bulk create memories using createMany for fast Postgres insertion.
   * Embeddings are queued asynchronously via EmbeddingQueueProcessor.
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
   * POST /v1/memories/query
   * Semantic search for memories
   */
  @Post('memories/query')
  @ApiOperation({
    summary: 'Search memories',
    description:
      'Semantic search across memories using natural language queries.',
  })
  @ApiTags('search')
  @RateLimit(60)
  async recall(
    @UserId() userId: string,
    @Body() dto: QueryMemoryDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Query('agentId') agentId?: string,
  ): Promise<QueryResult> {
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    const result = await this.memoryService.recall(accountUserIds || userId, dto);

    // ENG-35: Log retrieval query for adaptive retrieval signals
    const accountId = req.accountId ?? req.agent?.accountId;
    if (accountId) {
      try {
        const queryId = await this.retrievalSignals.logQuery({
          accountId,
          queryText: dto.query,
          strategyConfig: { vectorWeight: 0.6, bm25Weight: 0.4, rrfK: 60 },
          resultCount: result.memories.length,
          latencyMs: result.latencyMs,
        });
        res.set('X-Query-Id', queryId);
      } catch {
        // Signal logging must never break retrieval
      }
    }

    return result;
  }

  /**
   * POST /v1/memories/search
   * Alias for /v1/memories/query
   * @deprecated Use POST /v1/memories/query instead. This endpoint will be removed in a future release.
   */
  @Post('memories/search')
  @ApiOperation({
    summary: 'Search memories (alias for /query)',
    deprecated: true,
  })
  @ApiTags('search')
  @RateLimit(60)
  async search(
    @UserId() userId: string,
    @Body() dto: QueryMemoryDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Query('agentId') agentId?: string,
  ): Promise<QueryResult> {
    res.set('Deprecation', 'true');
    res.set('Link', '</v1/memories/query>; rel="successor-version"');
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    return this.memoryService.recall(accountUserIds || userId, dto);
  }

  /**
   * GET /v1/memories/search
   * GET alias for search
   * @deprecated Use POST /v1/memories/query instead. This endpoint will be removed in a future release.
   */
  @Get('memories/search')
  @ApiOperation({
    summary: 'Search memories (GET alias)',
    deprecated: true,
  })
  @ApiTags('search')
  @RateLimit(60)
  async searchGet(
    @UserId() userId: string,
    @Query() dto: QueryMemoryDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Query('agentId') agentId?: string,
  ): Promise<QueryResult> {
    res.set('Deprecation', 'true');
    res.set('Link', '</v1/memories/query>; rel="successor-version"');
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    return this.memoryService.recall(accountUserIds || userId, dto);
  }

  /**
   * POST /v1/recall
   * Alias for /v1/memories/query — semantic search for memories
   * @deprecated Use POST /v1/memories/query instead. This endpoint will be removed in a future release.
   */
  @Post('recall')
  @ApiOperation({
    summary: 'Recall memories (alias for /memories/query)',
    deprecated: true,
  })
  @ApiTags('search')
  @RateLimit(60)
  async recallAlias(
    @UserId() userId: string,
    @Body() dto: QueryMemoryDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Query('agentId') agentId?: string,
  ): Promise<QueryResult> {
    res.set('Deprecation', 'true');
    res.set('Link', '</v1/memories/query>; rel="successor-version"');
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    return this.memoryService.recall(accountUserIds || userId, dto);
  }

  /**
   * POST /v1/recall/contextual
   * Mid-conversation contextual recall with topic shift detection.
   * Returns relevant memories only when a topic shift is detected.
   */
  @Post('recall/contextual')
  async contextualRecall(
    @UserId() userId: string,
    @Body() dto: ContextualRecallDto,
    @Req() req: any,
    @Query('agentId') agentId?: string,
  ): Promise<ContextualRecallResponseDto> {
    const accountUserIds = await this.resolveAccountUserIds(req, agentId);
    return this.contextualRecallService.recall(accountUserIds || userId, dto);
  }

  // =========================================================================
  // EXPORT / IMPORT (HEY-55)
  // =========================================================================

  /**
   * GET /v1/memories
   * List memories with pagination and optional filters
   */
  @Get('memories')
  @ApiOperation({
    summary: 'List memories',
    description:
      'List memories with pagination, ordered by newest first. Supports layer and userId filters.',
  })
  async listMemories(
    @Req() req: any,
    @UserId() userId: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
    @Query('layer') layer?: string,
    @Query('userId') filterUserId?: string,
    @Query('agentId') agentId?: string,
  ): Promise<{
    memories: any[];
    total: number;
    limit: number;
    offset: number;
    page: number;
    totalPages: number;
    userMap: Record<string, string>;
  }> {
    const limit = Math.min(
      Math.max(parseInt(limitStr || '25', 10) || 25, 1),
      100,
    );
    const offset = Math.max(parseInt(offsetStr || '0', 10) || 0, 0);

    const accountUserIds = await this.resolveAccountUserIds(req);
    const userIds = accountUserIds || [userId];

    const where: any = {
      deletedAt: null,
      userId:
        filterUserId && userIds.includes(filterUserId)
          ? filterUserId
          : { in: userIds },
    };

    if (layer) {
      where.layer = layer;
    }

    if (agentId) {
      where.agentId = agentId;
    }

    const [memories, total] = await Promise.all([
      this.prisma.memory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: { extraction: true },
      }),
      this.prisma.memory.count({ where }),
    ]);

    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(total / limit);

    // Resolve display names for all userIds in this page
    const uniqueUserIds = [...new Set(memories.map((m) => m.userId))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: uniqueUserIds } },
      select: { id: true, externalId: true, displayName: true },
    });
    const userMap: Record<string, string> = {};
    for (const u of users) {
      userMap[u.id] = u.displayName || u.externalId || u.id;
    }

    return { memories, total, limit, offset, page, totalPages, userMap };
  }

  /**
   * GET /v1/users
   * List all users under the authenticated account
   */
  @Get('users')
  @ApiOperation({
    summary: 'List users',
    description: 'List all users under the authenticated account.',
  })
  async listUsers(
    @Req() req: any,
    @UserId() userId: string,
  ): Promise<{
    users: Array<{
      id: string;
      externalId: string;
      displayName: string | null;
      accountId: string;
      createdAt: Date;
    }>;
  }> {
    const accountUserIds = await this.resolveAccountUserIds(req);

    const where: any = {
      deletedAt: null,
    };

    if (accountUserIds) {
      where.id = { in: accountUserIds };
    } else {
      where.id = userId;
    }

    const users = await this.prisma.user.findMany({
      where,
      distinct: ['externalId'],
      select: {
        id: true,
        externalId: true,
        displayName: true,
        accountId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return { users };
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

    // Stream in batches to avoid OOM on large exports (HEY-206)
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
   * HEY-354: NDJSON streaming import — processes one memory per line
   * without loading the entire payload into memory.
   * Content-Type: application/x-ndjson
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

    // Read raw body as stream, split on newlines
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
   * HEY-353: Async import — accepts the same format as /import but processes
   * in background via the job queue. Returns 202 with a jobId.
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
  // EMBEDDING STATUS (HEY-345)
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

  /**
   * GET /v1/memories/graph
   * Get memory graph data for visualization
   * NOTE: Must be defined before /memories/:id to avoid route collision
   */
  @Get('memories/graph')
  async getGraph(
    @UserId() userId: string,
    @Req() req: any,
    @Query('limit') limit?: string,
    @Query('includeAgent') includeAgent?: string,
  ): Promise<{
    nodes: any[];
    edges: any[];
    entities: any[];
    stats?: { human: number; agent: number };
  }> {
    // For account-level access, resolve first userId if current one has no data
    const accountUserIds = await this.resolveAccountUserIds(req);
    const effectiveUserId = accountUserIds?.[0] ?? userId;
    return this.memoryService.getGraphData(
      effectiveUserId,
      limit ? parseInt(limit, 10) : 500,
      includeAgent === 'true',
    );
  }

  /**
   * GET /v1/memories/:id
   * Get a single memory by ID
   */
  @Get('memories/:id')
  @ApiOperation({ summary: 'Get a memory by ID' })
  async getMemory(
    @Req() req: any,
    @UserId() userId: string,
    @Param('id') id: string,
  ): Promise<MemoryWithExtraction | null> {
    const accountUserIds = await this.resolveAccountUserIds(req);
    const accountId = req.accountId ?? req.agent?.accountId;
    return this.memoryService.getById(
      id,
      userId,
      accountUserIds ?? undefined,
      accountId,
    );
  }

  /**
   * PATCH /v1/memories/:id
   * Update an existing memory
   *
   * P5-001: Memory Correction API
   *
   * Allows direct editing of:
   * - raw: Memory content (triggers re-embedding)
   * - layer: IDENTITY, PROJECT, SESSION, TASK
   * - importance: Hint or explicit score
   * - extraction: 5W1H fields (who, what, when, where, why, how, topics)
   *
   * Use this for typo fixes, layer promotions, or extraction corrections.
   * For factual corrections that should preserve history, use POST /:id/correct instead.
   */
  @Patch('memories/:id')
  @ApiOperation({
    summary: 'Update a memory',
    description:
      'Edit content, layer, importance, or extraction fields. Triggers re-embedding if content changes.',
  })
  async updateMemory(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateMemoryDto,
  ): Promise<MemoryWithExtraction> {
    return this.memoryService.update(userId, id, dto);
  }

  /**
   * DELETE /v1/memories/:id
   * Soft delete a memory
   */
  @Delete('memories/:id')
  @ApiOperation({
    summary: 'Delete a memory',
    description: 'Soft-delete a memory by ID.',
  })
  @ApiResponse({ status: 204, description: 'Memory deleted.' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMemory(
    @UserId() userId: string,
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<void> {
    const accountUserIds = await this.resolveAccountUserIds(req);
    return this.memoryService.delete(id, userId, accountUserIds ?? undefined);
  }

  // =========================================================================
  // FEEDBACK
  // =========================================================================

  /**
   * POST /v1/memories/:id/used
   * Mark a memory as used (implicit feedback)
   */
  @Post('memories/:id/used')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markUsed(
    @UserId() userId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.memoryService.markUsed(id, userId);
  }

  /**
   * POST /v1/memories/:id/helpful
   * Mark a memory as helpful (explicit feedback)
   */
  @Post('memories/:id/helpful')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markHelpful(
    @UserId() userId: string,
    @Param('id') id: string,
  ): Promise<void> {
    // Stub — use POST /v1/feedback for memory feedback (HEY-227)
    return;
  }

  /**
  // NOTE: POST /v1/memories/:id/correct moved to CorrectionController

  // =========================================================================
  // CONTEXT
  // =========================================================================

  /**
   * POST /v1/context
   * Load context for session start
   */
  @Post('context')
  @ApiOperation({
    summary: 'Load context',
    description: 'Load relevant context for an agent session bootstrap.',
  })
  @ApiTags('context')
  async loadContext(
    @UserId() userId: string,
    @Body() dto: LoadContextDto,
  ): Promise<ContextResult> {
    return this.memoryService.loadContext(userId, dto);
  }

  // =========================================================================
  // BACKFILL (Admin)
  // =========================================================================

  /**
   * GET /v1/memories/backfill/status
   * Check how many memories need backfill
   */
  @Get('memories/backfill/status')
  @UseGuards(AdminGuard)
  async getBackfillStatus(): Promise<{ needsBackfill: number }> {
    const memories = await this.backfillService.findMemoriesNeedingBackfill();
    return { needsBackfill: memories.length };
  }

  /**
   * POST /v1/memories/backfill
   * Run backfill on memories with empty extraction data
   * @param dryRun - If 'true', only report what would be done
   * @param batchSize - Number of memories to process (default 50)
   */
  @Post('memories/backfill')
  @UseGuards(AdminGuard)
  async runBackfill(
    @Query('dryRun') dryRun?: string,
    @Query('batchSize') batchSize?: string,
  ): Promise<BackfillResult> {
    return this.backfillService.backfillExtractions({
      dryRun: dryRun === 'true',
      batchSize: batchSize ? parseInt(batchSize, 10) : 50,
      delayMs: 500, // 500ms delay between extractions to avoid rate limits
    });
  }

  /**
   * POST /v1/backfill/user-identity
   * Replace generic user references (user_xxx, User, the user) with actual name.
   *
   * P5-002: User Identity Backfill
   *
   * @param userId - The user's internal ID
   * @param actualName - The actual name to replace generic references with
   * @param dryRun - If 'true', only report what would be done
   * @param batchSize - Number of memories to process (default 1000)
   */
  @Post('backfill/user-identity')
  @UseGuards(AdminGuard)
  async backfillUserIdentity(
    @Body()
    body: {
      userId: string;
      actualName: string;
      dryRun?: boolean;
      batchSize?: number;
    },
  ): Promise<UserIdentityBackfillResult> {
    const { userId, actualName, dryRun = false, batchSize = 1000 } = body;
    return this.backfillService.backfillUserIdentity(userId, actualName, {
      dryRun,
      batchSize,
    });
  }

  /**
   * GET /v1/backfill/user-identity/lookup
   * Find users by externalId pattern (e.g., 'beaux')
   */
  @Get('backfill/user-identity/lookup')
  @UseGuards(AdminGuard)
  async lookupUserForBackfill(
    @Query('pattern') pattern: string,
  ): Promise<Array<{ id: string; externalId: string }>> {
    if (!pattern) {
      return [];
    }
    return this.backfillService.findUserByExternalIdPattern(pattern);
  }

  // =========================================================================
  // CONSOLIDATION (P5-003)
  // =========================================================================

  /**
   * POST /v1/consolidate
   * Trigger memory consolidation - promotes recurring SESSION patterns to IDENTITY.
   *
   * P5-003: Intelligent Layer Classification - Consolidation Endpoint
   *
   * This finds SESSION memories with 3+ similar occurrences and:
   * - Promotes the canonical (most complete) version to IDENTITY layer
   * - Soft-deletes duplicates with consolidatedInto reference
   *
   * @param dryRun - If 'true', only report what would be done
   * @param minOccurrences - Minimum similar memories to trigger promotion (default 3)
   * @param similarityThreshold - Similarity threshold for clustering (default 0.85)
   */
  @Post('consolidate')
  async consolidate(
    @UserId() userId: string,
    @Query('dryRun') dryRun?: string,
    @Query('minOccurrences') minOccurrences?: string,
    @Query('similarityThreshold') similarityThreshold?: string,
  ): Promise<ConsolidationResult> {
    return this.consolidationService.promoteRecurringPatterns(userId, {
      dryRun: dryRun === 'true',
      minOccurrences: minOccurrences ? parseInt(minOccurrences, 10) : undefined,
      similarityThreshold: similarityThreshold
        ? parseFloat(similarityThreshold)
        : undefined,
    });
  }

  /**
   * GET /v1/consolidate/stats
   * Get consolidation statistics for the current user.
   */
  @Get('consolidate/stats')
  async getConsolidationStats(@UserId() userId: string): Promise<{
    totalMemories: number;
    sessionMemories: number;
    identityMemories: number;
    projectMemories: number;
    consolidatedCount: number;
    potentialClusters: number;
  }> {
    return this.consolidationService.getStats(userId);
  }
}
