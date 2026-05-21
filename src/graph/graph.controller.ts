import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GraphService } from './services/graph.service';
import { EntityService } from './services/entity.service';
import { RelationshipService } from './services/relationship.service';
import { GraphExtractionService } from './services/graph-extraction.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateEntityDto,
  UpdateEntityDto,
  ListEntitiesDto,
} from './dto/entity.dto';
import {
  CreateRelationshipDto,
  UpdateRelationshipDto,
  ListRelationshipsDto,
  TraverseGraphDto,
} from './dto/relationship.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

/**
 * GraphController - REST API for Semantic Memory Graphs
 *
 * Provides endpoints for:
 * - Entity CRUD operations
 * - Relationship CRUD operations
 * - Graph traversal and path finding
 * - Entity search and profiles
 * - Graph statistics
 */
@ApiTags('Graph')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/graph')
export class GraphController {
  constructor(
    private readonly graphService: GraphService,
    private readonly entityService: EntityService,
    private readonly relationshipService: RelationshipService,
    private readonly extractionService: GraphExtractionService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Resolve all user IDs under the authenticated account.
   * Returns null if no accountId is available.
   */
  private async resolveAccountUserIds(req: any): Promise<string[] | null> {
    const accountId = req.accountId ?? req.agent?.accountId;
    if (!accountId) return null;

    const users = await this.prisma.user.findMany({
      where: { accountId, deletedAt: null },
      select: { id: true },
    });
    return users.length > 0 ? users.map((u) => u.id) : null;
  }

  // ==================== Health & Status ====================

  /**
   * Check if graph features are enabled
   */
  @Get('status')
  async getStatus() {
    return {
      enabled: this.graphService.isEnabled(),
      extractionEnabled: this.extractionService.isEnabled(),
    };
  }

  // ==================== Entity Endpoints ====================

  /**
   * List entities for a user
   */
  @Get('entities')
  async listEntities(
    @Req() req: any,
    @Query('userId') userId?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    let userIdOrIds: string | string[] | undefined = userId;
    if (!userId) {
      const accountUserIds = await this.resolveAccountUserIds(req);
      if (accountUserIds) {
        userIdOrIds = accountUserIds;
      } else {
        throw new BadRequestException('userId is required');
      }
    }

    const dto: ListEntitiesDto = {
      userId: userIdOrIds as any,
      type: type as any,
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    };

    return this.entityService.list(dto);
  }

  /**
   * Get a specific entity by ID
   */
  @Get('entities/:id')
  async getEntity(@Param('id') id: string) {
    return this.entityService.getWithRelationships(id);
  }

  /**
   * Create a new entity
   */
  @Post('entities')
  @HttpCode(HttpStatus.CREATED)
  async createEntity(@Body() dto: CreateEntityDto) {
    return this.entityService.create(dto);
  }

  /**
   * Update an entity
   */
  @Put('entities/:id')
  async updateEntity(@Param('id') id: string, @Body() dto: UpdateEntityDto) {
    return this.entityService.update(id, dto);
  }

  /**
   * Delete an entity
   */
  @Delete('entities/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteEntity(@Param('id') id: string) {
    await this.entityService.delete(id);
  }

  /**
   * Search entities
   */
  @Post('entities/search')
  async searchEntities(
    @Body()
    body: {
      userId: string;
      query: string;
      type?: string;
      limit?: number;
    },
  ) {
    if (!body.userId || !body.query) {
      throw new BadRequestException('userId and query are required');
    }

    return this.graphService.searchEntities(body.userId, body.query, {
      type: body.type as any,
      limit: body.limit,
    });
  }

  /**
   * Get entity profile with relationships and memories
   */
  @Get('entities/:userId/profile/:nameOrId')
  async getEntityProfile(
    @Param('userId') userId: string,
    @Param('nameOrId') nameOrId: string,
  ) {
    const profile = await this.graphService.getEntityProfile(userId, nameOrId);
    if (!profile) {
      throw new BadRequestException(`Entity not found: ${nameOrId}`);
    }
    return profile;
  }

  // ==================== Relationship Endpoints ====================

  /**
   * List relationships
   */
  @Get('relationships')
  async listRelationships(
    @Req() req: any,
    @Query('userId') userId?: string,
    @Query('entityId') entityId?: string,
    @Query('type') type?: string,
    @Query('direction') direction?: 'outgoing' | 'incoming' | 'both',
    @Query('limit') limit?: string,
  ) {
    let userIdOrIds: string | string[] | undefined = userId;
    if (!userId) {
      const accountUserIds = await this.resolveAccountUserIds(req);
      if (accountUserIds) {
        userIdOrIds = accountUserIds;
      } else {
        throw new BadRequestException('userId is required');
      }
    }

    const dto: ListRelationshipsDto = {
      userId: userIdOrIds as any,
      entityId,
      type: type as any,
      direction,
      limit: limit ? parseInt(limit, 10) : undefined,
    };

    return this.relationshipService.list(dto);
  }

  /**
   * Get a specific relationship
   */
  @Get('relationships/:id')
  async getRelationship(@Param('id') id: string) {
    return this.relationshipService.findByIdOrFail(id);
  }

  /**
   * Create a new relationship
   */
  @Post('relationships')
  @HttpCode(HttpStatus.CREATED)
  async createRelationship(@Body() dto: CreateRelationshipDto) {
    return this.relationshipService.create(dto);
  }

  /**
   * Update a relationship
   */
  @Put('relationships/:id')
  async updateRelationship(
    @Param('id') id: string,
    @Body() dto: UpdateRelationshipDto,
  ) {
    return this.relationshipService.update(id, dto);
  }

  /**
   * Delete a relationship
   */
  @Delete('relationships/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRelationship(@Param('id') id: string) {
    await this.relationshipService.delete(id);
  }

  // ==================== Graph Query Endpoints ====================

  /**
   * Traverse the graph from a starting entity
   */
  @Post('traverse')
  async traverseGraph(@Body() dto: TraverseGraphDto) {
    if (!dto.userId || !dto.startEntityId) {
      throw new BadRequestException('userId and startEntityId are required');
    }

    return this.relationshipService.traverse(dto);
  }

  /**
   * Find path between two entities
   */
  @Post('path')
  async findPath(@Body() body: { userId: string; from: string; to: string }) {
    if (!body.userId || !body.from || !body.to) {
      throw new BadRequestException('userId, from, and to are required');
    }

    return this.graphService.findPath(body.userId, body.from, body.to);
  }

  /**
   * Find entities by relationship
   */
  @Post('find-by-relationship')
  async findByRelationship(
    @Body()
    body: {
      userId: string;
      relationshipType: string;
      targetEntity: string;
    },
  ) {
    if (!body.userId || !body.relationshipType || !body.targetEntity) {
      throw new BadRequestException(
        'userId, relationshipType, and targetEntity are required',
      );
    }

    return this.graphService.findByRelationship(
      body.userId,
      body.relationshipType,
      body.targetEntity,
    );
  }

  /**
   * Get memories for an entity
   */
  @Get('entities/:id/memories')
  async getEntityMemories(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.graphService.getMemoriesForEntity(
      id,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  /**
   * Get related entities
   */
  @Get('entities/:id/related')
  async getRelatedEntities(
    @Param('id') id: string,
    @Query('depth') depth?: string,
  ) {
    return this.graphService.getRelatedEntities(
      id,
      depth ? parseInt(depth, 10) : 1,
    );
  }

  // ==================== Stats & Admin Endpoints ====================

  /**
   * Get graph statistics for a user
   */
  @Get('stats/:userId')
  async getStats(@Param('userId') userId: string) {
    return this.graphService.getStats(userId);
  }

  /**
   * Trigger graph extraction for a text (for testing)
   */
  @Post('extract')
  async extract(@Body() body: { content: string }) {
    if (!body.content) {
      throw new BadRequestException('content is required');
    }

    return this.extractionService.extract(body.content);
  }

  /**
   * Backfill graph data for existing memories.
   * If userId is omitted, resolves from account context.
   */
  @Post('backfill')
  async backfill(
    @Req() req: any,
    @Body() body: { userId?: string; limit?: number },
  ) {
    const limit = Math.min(Math.max(body.limit ?? 50, 1), 5000);

    // If userId provided, backfill just that user
    if (body.userId) {
      return this.graphService.backfill(body.userId, { limit });
    }

    // Otherwise backfill all users under the account
    const accountUserIds = await this.resolveAccountUserIds(req);
    const userIds = accountUserIds ?? (req.user?.id ? [req.user.id] : null);

    if (!userIds?.length) {
      throw new BadRequestException('userId is required');
    }

    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    for (const uid of userIds) {
      const result = await this.graphService.backfill(uid, { limit });
      totalProcessed += result.processed;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
    }

    return {
      processed: totalProcessed,
      skipped: totalSkipped,
      failed: totalFailed,
      users: userIds.length,
    };
  }
}
