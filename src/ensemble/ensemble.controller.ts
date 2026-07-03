/**
 * Ensemble Controller
 *
 * API endpoints for multi-model ensemble retrieval.
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import {
  IsOptional,
  IsArray,
  IsString,
  IsIn,
  IsNumber,
  IsObject,
} from 'class-validator';
import { EnsembleService } from './ensemble.service';
import { NightlyReembedService } from './nightly-reembed.service';
import { DriftDetectionService } from './drift-detection.service';
import { DriftAnalysisJobService } from './drift-analysis-job.service';
import type { DriftAnalysisJobStatus } from './drift-analysis-job.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ModelId,
  EnsembleQueryResult,
  FusedResult,
  EnsembleConfig,
  ModelInfo,
  CoverageStats,
  MemoryEmbeddingStatus,
  ABTestResult,
} from './ensemble.types';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

// ============================================================================
// DTOs
// ============================================================================

class EnsembleQueryDto {
  @IsString()
  query: string;

  @IsString()
  userId: string;

  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsNumber()
  k?: number;

  @IsOptional()
  @IsArray()
  models?: ModelId[];

  @IsOptional()
  @IsObject()
  weights?: Record<ModelId, number>;
}

class EnsembleUpsertDto {
  @IsString()
  memoryId: string;

  @IsString()
  content: string;

  @IsString()
  userId: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

class CompareQueryDto {
  @IsString()
  query: string;

  @IsString()
  userId: string;

  @IsOptional()
  @IsNumber()
  limit?: number;
}

// ============================================================================
// Response Types
// ============================================================================

interface StatusResponse {
  enabled: boolean;
  models: ModelId[];
  config: EnsembleConfig;
}

interface FusedResultResponse extends Omit<FusedResult, 'modelScores'> {
  modelScores: Record<ModelId, { rank: number; score: number }>;
}

interface EnsembleQueryResponse extends Omit<EnsembleQueryResult, 'results'> {
  results: FusedResultResponse[];
}

// ============================================================================
// Controller
// ============================================================================

class ReembedDto {
  @IsOptional()
  @IsArray()
  models?: ModelId[];

  @IsOptional()
  @IsString()
  @IsIn(['incremental', 'full'])
  mode?: 'incremental' | 'full';

  @IsOptional()
  @IsArray()
  memoryIds?: string[];
}

@ApiTags('ensemble')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/ensemble')
export class EnsembleController {
  private readonly logger = new Logger(EnsembleController.name);
  constructor(
    private readonly ensembleService: EnsembleService,
    private readonly nightlyReembedService: NightlyReembedService,
    private readonly driftDetectionService: DriftDetectionService,
    private readonly driftAnalysisJobService: DriftAnalysisJobService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Get ensemble status and configuration
   */
  @Get('status')
  @ApiOperation({ summary: 'Get ensemble retrieval status' })
  @ApiResponse({ status: 200, description: 'Ensemble status' })
  getStatus(): StatusResponse {
    const config = this.ensembleService.getConfig();
    return {
      enabled: this.ensembleService.isEnabled(),
      models: config.models,
      config,
    };
  }

  /**
   * Query memories using ensemble retrieval
   */
  @Post('query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Query memories with multi-model ensemble' })
  @ApiResponse({ status: 200, description: 'Fused query results' })
  async query(@Body() dto: EnsembleQueryDto): Promise<EnsembleQueryResponse> {
    if (!this.ensembleService.isEnabled()) {
      throw new BadRequestException('Ensemble retrieval is not enabled');
    }

    if (!dto.query || !dto.userId) {
      throw new BadRequestException('query and userId are required');
    }

    const result = await this.ensembleService.query({
      query: dto.query,
      userId: dto.userId,
      limit: dto.limit ? Math.min(dto.limit, 1000) : undefined,
      k: dto.k ? Math.min(dto.k, 1000) : undefined,
      models: dto.models,
      weights: dto.weights,
    });

    // Convert Map to object for JSON serialization
    return {
      ...result,
      results: result.results.map((r) => ({
        ...r,
        modelScores: Object.fromEntries(r.modelScores) as Record<
          ModelId,
          { rank: number; score: number }
        >,
      })),
    };
  }

  /**
   * Upsert a memory with multi-model embeddings
   */
  @Post('upsert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upsert memory with ensemble embeddings' })
  @ApiResponse({ status: 200, description: 'Memory upserted' })
  async upsert(@Body() dto: EnsembleUpsertDto): Promise<{ success: boolean }> {
    if (!this.ensembleService.isEnabled()) {
      throw new BadRequestException('Ensemble retrieval is not enabled');
    }

    if (!dto.memoryId || !dto.content || !dto.userId) {
      throw new BadRequestException(
        'memoryId, content, and userId are required',
      );
    }

    await this.ensembleService.upsert({
      memoryId: dto.memoryId,
      content: dto.content,
      userId: dto.userId,
      metadata: dto.metadata,
    });

    return { success: true };
  }

  /**
   * Compare ensemble vs single-model retrieval (debugging)
   */
  @Post('compare')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compare ensemble vs single-model retrieval' })
  @ApiResponse({ status: 200, description: 'Comparison results' })
  async compare(@Body() dto: CompareQueryDto): Promise<{
    ensemble: EnsembleQueryResponse;
    singleModel: Record<
      ModelId,
      Array<{ memoryId: string; rank: number; score: number }>
    >;
  }> {
    if (!this.ensembleService.isEnabled()) {
      throw new BadRequestException('Ensemble retrieval is not enabled');
    }

    if (!dto.query || !dto.userId) {
      throw new BadRequestException('query and userId are required');
    }

    const result = await this.ensembleService.compare(
      dto.query,
      dto.userId,
      dto.limit ?? 10,
    );

    return {
      ensemble: {
        ...result.ensemble,
        results: result.ensemble.results.map((r) => ({
          ...r,
          modelScores: Object.fromEntries(r.modelScores) as Record<
            ModelId,
            { rank: number; score: number }
          >,
        })),
      },
      singleModel: Object.fromEntries(
        Array.from(result.singleModel.entries()).map(([model, results]) => [
          model,
          results.map((r) => ({
            memoryId: r.memoryId,
            rank: r.rank,
            score: r.score,
          })),
        ]),
      ) as Record<
        ModelId,
        Array<{ memoryId: string; rank: number; score: number }>
      >,
    };
  }

  /**
   * Generate embeddings for text (utility endpoint)
   */
  @Post('embed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate embeddings for text' })
  @ApiResponse({ status: 200, description: 'Embeddings from all models' })
  async embed(@Body() dto: { text: string }): Promise<{
    embeddings: Array<{
      model: ModelId;
      dimensions: number;
      latencyMs: number;
    }>;
    totalMs: number;
  }> {
    if (!dto.text) {
      throw new BadRequestException('text is required');
    }

    const result = await this.ensembleService.embedAll(dto.text);

    return {
      embeddings: result.embeddings.map((e) => ({
        model: e.model,
        dimensions: e.dimensions,
        latencyMs: e.latencyMs,
        // Note: Not returning actual vectors to keep response small
      })),
      totalMs: result.totalMs,
    };
  }

  /**
   * Get all registered models with status and configuration
   */
  @Get('models')
  @ApiOperation({ summary: 'List all registered ensemble models' })
  @ApiResponse({
    status: 200,
    description: 'List of models with their configuration',
  })
  async getModels(): Promise<ModelInfo[]> {
    return this.ensembleService.getModels();
  }

  /**
   * Get embedding coverage statistics
   * Transforms perModel object to array format for dashboard compatibility
   */
  @Get('coverage')
  @ApiOperation({ summary: 'Get embedding coverage statistics' })
  @ApiResponse({ status: 200, description: 'Coverage stats per model' })
  async getCoverage() {
    const stats = await this.ensembleService.getCoverage();

    // Transform perModel from Record to array for dashboard compatibility
    const perModelArray = Object.entries(stats.perModel).map(
      ([model, modelStats]) => ({
        model,
        status: 'active' as const,
        embeddedCount: modelStats.embeddingCount,
        totalMemories: stats.totalMemories,
        coveragePercentage: modelStats.coveragePercent,
      }),
    );

    return {
      totalMemories: stats.totalMemories,
      modelsConfigured: Object.keys(stats.perModel).length,
      fullCoverageCount: stats.memoriesWithAllModels,
      fullCoveragePercentage: stats.coveragePercent,
      perModel: perModelArray,
    };
  }

  /**
   * Get embeddings status for a specific memory
   */
  @Get('memories/:id/embeddings')
  @ApiOperation({ summary: 'Get embedding status for a specific memory' })
  @ApiResponse({
    status: 200,
    description: 'Embedding status per model for the memory',
  })
  async getMemoryEmbeddings(
    @Param('id') memoryId: string,
  ): Promise<{ memoryId: string; embeddings: MemoryEmbeddingStatus[] }> {
    if (!memoryId) {
      throw new BadRequestException('Memory ID is required');
    }

    const embeddings = await this.ensembleService.getMemoryEmbeddings(memoryId);
    return { memoryId, embeddings };
  }

  /**
   * Get A/B test results
   */
  @Get('ab-results')
  @ApiOperation({ summary: 'Get A/B test results' })
  @ApiQuery({
    name: 'testId',
    required: false,
    description: 'Filter by test ID',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max results to return',
  })
  @ApiResponse({ status: 200, description: 'A/B test results' })
  async getABTestResults(
    @Query('testId') testId?: string,
    @Query('limit') limit?: string,
  ): Promise<{ results: ABTestResult[]; count: number }> {
    const limitNum = Math.min(limit ? parseInt(limit, 10) : 100, 1000);
    const results = await this.ensembleService.getABTestResults(
      testId,
      limitNum,
    );
    return { results, count: results.length };
  }

  /**
   * Trigger re-embedding for specified models
   */
  @Post('reembed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger batch re-embedding for models' })
  @ApiResponse({ status: 200, description: 'Re-embed job started' })
  async triggerReembed(@Body() dto: ReembedDto): Promise<{
    jobId: string;
    message: string;
  }> {
    const mode = dto.mode ?? 'incremental';
    const jobId = await this.nightlyReembedService.startManualJob({
      mode,
      models: dto.models,
      memoryIds: dto.memoryIds,
    });
    return {
      jobId,
      message: `Re-embed job ${jobId} started in ${mode} mode`,
    };
  }

  /**
   * Get active re-embed job status
   */
  @Get('reembed/status')
  @ApiOperation({ summary: 'Get active re-embed job status' })
  @ApiResponse({
    status: 200,
    description: 'Job status or null if no active job',
  })
  getReembedStatus() {
    return this.nightlyReembedService.getActiveJobStatus();
  }

  /**
   * Re-embed specific memories with specific models (direct endpoint)
   */
  @Post('reembed/targeted')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-embed specific memories with specific models' })
  @ApiResponse({ status: 200, description: 'Targeted re-embed job started' })
  async targetedReembed(
    @Body() dto: { memoryIds: string[]; models: ModelId[] },
  ): Promise<{
    jobId: string;
    total: number;
    message: string;
  }> {
    if (!dto.memoryIds || dto.memoryIds.length === 0) {
      throw new BadRequestException('memoryIds is required');
    }
    if (!dto.models || dto.models.length === 0) {
      throw new BadRequestException('models is required');
    }

    // Start processing asynchronously
    const jobId = `targeted-${Date.now()}`;
    this.processTargetedReembed(jobId, dto.memoryIds, dto.models);

    return {
      jobId,
      total: dto.memoryIds.length,
      message: `Processing ${dto.memoryIds.length} memories for models: ${dto.models.join(', ')}`,
    };
  }

  // ==========================================================================
  // Drift Detection Endpoints
  // ==========================================================================

  /**
   * Get latest drift analysis per model
   */
  @Get('drift')
  @ApiOperation({ summary: 'Get latest drift snapshot per model' })
  @ApiResponse({ status: 200, description: 'Latest drift per model' })
  async getLatestDrift(@Req() req: any): Promise<{
    perModel: Array<{
      modelId: string;
      avgDrift: number;
      maxDrift: number;
      sampleCount: number;
      alertLevel: string;
      createdAt: Date;
    }>;
    thresholds: { drift: number; alert: number };
  }> {
    const where = this.driftSnapshotWhere(req.accountId ?? null);
    const models = await this.prisma.driftSnapshot.findMany({
      where,
      distinct: ['modelId'],
      select: { modelId: true },
      orderBy: { modelId: 'asc' },
    });

    const perModel: Array<{
      modelId: string;
      avgDrift: number;
      maxDrift: number;
      sampleCount: number;
      alertLevel: string;
      createdAt: Date;
    }> = [];
    for (const { modelId } of models) {
      const snapshot = await this.prisma.driftSnapshot.findFirst({
        where: { ...where, modelId },
        orderBy: { createdAt: 'desc' },
      });
      if (snapshot) {
        perModel.push({
          modelId: snapshot.modelId,
          avgDrift: snapshot.avgDrift,
          maxDrift: snapshot.maxDrift,
          sampleCount: snapshot.sampleCount,
          alertLevel: snapshot.alertLevel,
          createdAt: snapshot.createdAt,
        });
      }
    }

    return {
      perModel,
      thresholds: this.driftDetectionService.getThresholds(),
    };
  }

  /**
   * Get drift snapshots over time (for charting)
   */
  @Get('drift/history')
  @ApiOperation({ summary: 'Get drift history for charting' })
  @ApiQuery({
    name: 'modelId',
    required: false,
    description: 'Filter by model',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max snapshots to return',
  })
  @ApiQuery({
    name: 'since',
    required: false,
    description: 'ISO date to filter from',
  })
  @ApiResponse({ status: 200, description: 'Drift snapshots over time' })
  async getDriftHistory(
    @Query('modelId') modelId?: string,
    @Query('limit') limit?: string,
    @Query('since') since?: string,
    @Req() req?: any,
  ): Promise<{
    snapshots: Array<{
      id: string;
      modelId: string;
      avgDrift: number;
      maxDrift: number;
      sampleCount: number;
      alertLevel: string;
      createdAt: Date;
    }>;
    count: number;
  }> {
    const where: any = this.driftSnapshotWhere(req?.accountId ?? null);
    if (modelId) where.modelId = modelId;
    if (since) where.createdAt = { gte: new Date(since) };

    const snapshots = await this.prisma.driftSnapshot.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit ? parseInt(limit, 10) : 100, 1000),
    });

    return { snapshots, count: snapshots.length };
  }

  /**
   * Queue a drift analysis job and return immediately.
   */
  @Post('drift/analyze')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Queue drift analysis and persist results asynchronously',
  })
  @ApiResponse({ status: 202, description: 'Drift analysis job queued' })
  analyzeDrift(@Req() req: any): DriftAnalysisJobStatus {
    return this.driftAnalysisJobService.enqueue(req.accountId ?? null);
  }

  /**
   * Get async drift analysis job status.
   */
  @Get('drift/analyze/jobs/:jobId')
  @ApiOperation({ summary: 'Get drift analysis job status' })
  @ApiResponse({ status: 200, description: 'Drift analysis job status' })
  getDriftAnalyzeJob(
    @Param('jobId') jobId: string,
    @Req() req: any,
  ): DriftAnalysisJobStatus {
    return this.driftAnalysisJobService.getStatusOrThrow(
      jobId,
      req.accountId ?? null,
    );
  }

  private driftSnapshotWhere(accountId: string | null): { accountId?: string } {
    return accountId ? { accountId } : {};
  }

  private async processTargetedReembed(
    jobId: string,
    memoryIds: string[],
    models: ModelId[],
  ): Promise<void> {
    this.logger.log(
      `[${jobId}] Starting targeted re-embed for ${memoryIds.length} memories`,
    );

    // Process in batches of 50
    const batchSize = 50;
    let processed = 0;
    let errors = 0;

    for (let i = 0; i < memoryIds.length; i += batchSize) {
      const batchIds = memoryIds.slice(i, i + batchSize);

      try {
        // Call the batch embedding method which handles storage
        await this.ensembleService.embedBatchForMemories(batchIds, models);
        processed += batchIds.length;
        this.logger.log(
          `[${jobId}] Processed ${processed}/${memoryIds.length}`,
        );
      } catch (error) {
        this.logger.error(`[${jobId}] Batch error:`, error);
        errors += batchIds.length;
      }
    }

    this.logger.log(
      `[${jobId}] Completed: ${processed} processed, ${errors} errors`,
    );
  }
}
