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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { EntityProfileService } from './entity-profile.service';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateAttributeDto } from './dto/create-attribute.dto';
import { UpdateAttributeDto } from './dto/update-attribute.dto';
import { ListProfilesDto } from './dto/list-profiles.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { Agent } from '../common/decorators/user-id.decorator';

@ApiTags('Entity Profiles')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/profiles')
export class EntityProfileController {
  constructor(private readonly service: EntityProfileService) {}

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
  @ApiResponse({ status: 200, description: 'Profile with attributes and counts.' })
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

  // ── Memory links ────────────────────────────────────────────────────

  @Post(':id/memories')
  @ApiOperation({ summary: 'Attach memory to profile' })
  @ApiParam({ name: 'id', description: 'Profile UUID' })
  @ApiResponse({ status: 201, description: 'Memory attached.' })
  @ApiResponse({ status: 404, description: 'Profile not found.' })
  async attachMemory(
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
  async detachMemory(
    @Agent() agent: any,
    @Param('id') id: string,
    @Param('memoryId') memoryId: string,
  ) {
    return this.service.detachMemory(agent.accountId, id, memoryId);
  }
}
