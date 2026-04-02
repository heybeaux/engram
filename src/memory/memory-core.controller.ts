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
  HttpCode,
  HttpStatus,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { MemoryService, MemoryWithExtraction } from './memory.service';
import { CreateMemoryDto, CreateMemoryBatchDto } from './dto/create-memory.dto';
import { UpdateMemoryDto } from './dto/update-memory.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UserId } from '../common/decorators/user-id.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryJobQueueService } from './memory-job-queue.service';

@ApiTags('memories')
@Controller('v1')
@UseGuards(ApiKeyOrJwtGuard, RateLimitGuard)
export class MemoryCoreController {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly prisma: PrismaService,
    private readonly memoryJobQueue: MemoryJobQueueService,
  ) {}

  /**
   * Resolve user IDs for account-wide search.
   */
  private async resolveAccountUserIds(
    req: any,
    agentId?: string,
  ): Promise<string[] | null> {
    const accountId = req.accountId ?? req.agent?.accountId;
    if (!accountId) return null;

    const where: any = { deletedAt: null };
    if (agentId) {
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
  // ARCHIVAL
  // =========================================================================

  /**
   * GET /v1/memories/archived
   * List archived memories with pagination
   */
  @Get('memories/archived')
  @ApiOperation({
    summary: 'List archived memories',
    description:
      'List memories that have been archived by the dream cycle, with pagination.',
  })
  async listArchivedMemories(
    @UserId() userId: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
  ): Promise<{
    memories: any[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(
      Math.max(parseInt(limitStr || '25', 10) || 25, 1),
      100,
    );
    const offset = Math.max(parseInt(offsetStr || '0', 10) || 0, 0);

    const where = {
      userId,
      deletedAt: null,
      searchable: false,
      archivedReason: { not: null },
    };

    const [memories, total] = await Promise.all([
      this.prisma.memory.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: offset,
        take: limit,
        include: { extraction: true },
      }),
      this.prisma.memory.count({ where }),
    ]);

    return { memories, total, limit, offset };
  }

  /**
   * POST /v1/memories/:id/unarchive
   * Restore an archived memory to active/searchable state
   */
  @Post('memories/:id/unarchive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Unarchive a memory',
    description:
      'Restore an archived memory, setting searchable=true and clearing archivedReason.',
  })
  async unarchiveMemory(
    @UserId() userId: string,
    @Param('id') id: string,
  ): Promise<{ id: string; searchable: boolean; archivedReason: string | null }> {
    const memory = await this.prisma.memory.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!memory) {
      throw new NotFoundException(`Memory ${id} not found`);
    }

    const updated = await this.prisma.memory.update({
      where: { id },
      data: { searchable: true, archivedReason: null },
    });

    return {
      id: updated.id,
      searchable: updated.searchable,
      archivedReason: updated.archivedReason,
    };
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
}
