import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { EntityProfileService } from './entity-profile.service';
import { AttachmentPipelineService } from './attachment-pipeline.service';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateAttributeDto } from './dto/create-attribute.dto';
import { UpdateAttributeDto } from './dto/update-attribute.dto';
import { ListProfilesDto } from './dto/list-profiles.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { Agent } from '../common/decorators/user-id.decorator';
import { randomUUID } from 'crypto';

@ApiTags('Entity Profiles')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/entity-profiles')
export class EntityProfileController {
  private readonly logger = new Logger(EntityProfileController.name);

  constructor(
    private readonly service: EntityProfileService,
    private readonly pipeline: AttachmentPipelineService,
  ) {}

  // ── Profile CRUD ─────────────────────────────────────────────────────

  @Post()
  @ApiOperation({ summary: 'Create an entity profile' })
  @ApiResponse({ status: 201, description: 'Profile created with attributes.' })
  async create(@Agent() agent: any, @Body() dto: CreateProfileDto) {
    return this.service.create(agent.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List entity profiles with pagination' })
  @ApiResponse({ status: 200, description: 'Paginated profile list.' })
  async list(@Agent() agent: any, @Query() query: ListProfilesDto) {
    return this.service.list(agent.accountId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get entity profile detail' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiResponse({
    status: 200,
    description: 'Profile with attributes and counts.',
  })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async getById(@Agent() agent: any, @Param('id') id: string) {
    return this.service.getById(agent.accountId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update entity profile' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiResponse({ status: 200, description: 'Profile updated.' })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async update(
    @Agent() agent: any,
    @Param('id') id: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.service.update(agent.accountId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete entity profile' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiResponse({ status: 200, description: 'Profile soft-deleted.' })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async remove(@Agent() agent: any, @Param('id') id: string) {
    return this.service.softDelete(agent.accountId, id);
  }

  // ── Attributes ───────────────────────────────────────────────────────

  @Post(':id/attributes')
  @ApiOperation({ summary: 'Add attribute to profile' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiResponse({ status: 201, description: 'Attribute created.' })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async addAttribute(
    @Agent() agent: any,
    @Param('id') id: string,
    @Body() dto: CreateAttributeDto,
  ) {
    return this.service.addAttribute(agent.accountId, id, dto);
  }

  @Patch(':id/attributes/:attrId')
  @ApiOperation({ summary: 'Update profile attribute' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiParam({ name: 'attrId', description: 'Attribute UUID' })
  @ApiResponse({ status: 200, description: 'Attribute updated.' })
  @ApiResponse({ status: 404, description: 'Profile or attribute not found.' })
  async updateAttribute(
    @Agent() agent: any,
    @Param('id') id: string,
    @Param('attrId') attrId: string,
    @Body() dto: UpdateAttributeDto,
  ) {
    return this.service.updateAttribute(agent.accountId, id, attrId, dto);
  }

  @Delete(':id/attributes/:attrId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove attribute from profile' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiParam({ name: 'attrId', description: 'Attribute UUID' })
  @ApiResponse({ status: 200, description: 'Attribute deleted.' })
  @ApiResponse({ status: 404, description: 'Profile or attribute not found.' })
  async removeAttribute(
    @Agent() agent: any,
    @Param('id') id: string,
    @Param('attrId') attrId: string,
  ) {
    return this.service.removeAttribute(agent.accountId, id, attrId);
  }

  // ── Memory links ─────────────────────────────────────────────────────

  @Post(':id/memories')
  @ApiOperation({ summary: 'Attach memory to profile (legacy / simple)' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiResponse({ status: 201, description: 'Memory attached.' })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async attachMemorySimple(
    @Agent() agent: any,
    @Param('id') id: string,
    @Body() body: { memoryId: string; relevanceScore?: number },
  ) {
    return this.service.attachMemory(
      agent.accountId,
      id,
      body.memoryId,
      body.relevanceScore,
    );
  }

  @Delete(':id/memories/:memoryId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Detach memory from profile' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiParam({ name: 'memoryId', description: 'Memory UUID' })
  @ApiResponse({ status: 200, description: 'Memory detached.' })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async detachMemorySimple(
    @Agent() agent: any,
    @Param('id') id: string,
    @Param('memoryId') memoryId: string,
  ) {
    return this.service.detachMemory(agent.accountId, id, memoryId);
  }

  // ── Attachment Pipeline Endpoints ────────────────────────────────────

  @Post(':id/attach')
  @ApiOperation({
    summary: 'Manually attach a memory to a profile via the pipeline',
  })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiResponse({ status: 201, description: 'Memory attached.' })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async attach(
    @Agent() agent: any,
    @Param('id') id: string,
    @Body() body: { memoryId: string; relevanceScore?: number },
  ) {
    // Verify profile ownership, then attach manually
    return this.service.attachMemory(
      agent.accountId,
      id,
      body.memoryId,
      body.relevanceScore ?? 1.0,
    );
  }

  @Post(':id/detach')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually detach a memory from a profile' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiResponse({ status: 200, description: 'Memory detached.' })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async detach(
    @Agent() agent: any,
    @Param('id') id: string,
    @Body() body: { memoryId: string },
  ) {
    return this.service.detachMemory(agent.accountId, id, body.memoryId);
  }

  @Post('backfill')
  @ApiOperation({
    summary: 'Backfill entity profile attachments for all existing memories',
  })
  @ApiResponse({
    status: 201,
    description: 'Backfill job started. Processes in background.',
  })
  async backfill(@Agent() agent: any) {
    const userId = await this.service.getOrCreateUser(agent.id);
    const jobId = randomUUID();

    // Fire-and-forget: run backfill in background
    void this.service.backfillAttachments(userId).then(
      (stats) => {
        this.logger.log(
          `Backfill job ${jobId} complete: ${JSON.stringify(stats)}`,
        );
      },
      (err) => {
        this.logger.error(
          `Backfill job ${jobId} failed: ${(err as Error).message}`,
        );
      },
    );

    return {
      jobId,
      message: 'Backfill job started. Processing in background.',
    };
  }

  @Post('scan')
  @ApiOperation({
    summary: 'Trigger a scan of recent unattached memories for the agent',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max memories to scan (default 50)',
  })
  @ApiResponse({ status: 201, description: 'Scan result.' })
  async scan(@Agent() agent: any, @Query('limit') limit?: string) {
    const userId = await this.service.getOrCreateUser(agent.id);
    const scanLimit = limit ? parseInt(limit, 10) : 50;
    return this.pipeline.scanRecentUnattached(userId, scanLimit);
  }

  @Get(':id/memories')
  @ApiOperation({ summary: 'List attached memories with relevance scores' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Attached memories list.' })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async listMemories(
    @Agent() agent: any,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    // Verify ownership
    await this.service.getById(agent.accountId, id);

    const take = limit ? parseInt(limit, 10) : 25;
    const skip = page ? (parseInt(page, 10) - 1) * take : 0;

    const [memories, total] = await Promise.all([
      this.service['prisma'].entityProfileMemory.findMany({
        where: { profileId: id },
        orderBy: { relevanceScore: 'desc' },
        skip,
        take,
        include: {
          memory: {
            select: {
              id: true,
              raw: true,
              layer: true,
              createdAt: true,
              source: true,
            },
          },
        },
      }),
      this.service['prisma'].entityProfileMemory.count({
        where: { profileId: id },
      }),
    ]);

    return {
      memories,
      total,
      page: page ? parseInt(page, 10) : 1,
      limit: take,
      totalPages: Math.ceil(total / take),
    };
  }
}
