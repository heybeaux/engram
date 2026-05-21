import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { MemoryPoolService } from './memory-pool.service';
import {
  CreateMemoryPoolDto,
  GrantPoolAccessDto,
  AddMemoryToPoolDto,
  BulkAddMemoriesToPoolDto,
} from './dto/memory-pool.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

@ApiTags('memory-pools')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/pools')
export class MemoryPoolController {
  constructor(private readonly service: MemoryPoolService) {}

  @Post()
  @ApiOperation({ summary: 'Create a memory pool' })
  async create(@Body() dto: CreateMemoryPoolDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List pools for a user' })
  async list(
    @Query('userId') userId: string,
    @Query('visibility') visibility?: string,
  ) {
    return this.service.listByUser(userId, visibility);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get pool detail with members and grants' })
  async getById(@Param('id') id: string) {
    return this.service.getById(id, true);
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'Get pool members (memories)' })
  async getMembers(@Param('id') id: string) {
    const pool = (await this.service.getById(id, true)) as any;
    return pool.memberships ?? [];
  }

  @Get(':id/grants')
  @ApiOperation({ summary: 'Get pool grants' })
  async getGrants(@Param('id') id: string) {
    const pool = (await this.service.getById(id, true)) as any;
    return pool.grants ?? [];
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Archive/delete a pool' })
  async deletePool(@Param('id') id: string) {
    return this.service.deletePool(id);
  }

  @Post(':id/grant')
  @ApiOperation({ summary: 'Grant session access to pool' })
  async grant(@Param('id') id: string, @Body() dto: GrantPoolAccessDto) {
    return this.service.grantAccess(id, dto);
  }

  @Delete(':id/grant/:sessionId')
  @ApiOperation({ summary: 'Revoke session access to pool' })
  async revoke(@Param('id') id: string, @Param('sessionId') sessionId: string) {
    return this.service.revokeAccess(id, sessionId);
  }

  @Delete(':id/grant/agent/:agentId')
  @ApiOperation({ summary: 'Revoke agent-level access to pool' })
  async revokeAgent(
    @Param('id') id: string,
    @Param('agentId') agentId: string,
  ) {
    return this.service.revokeAgentAccess(id, agentId);
  }

  @Post(':id/memories/bulk')
  @ApiOperation({ summary: 'Bulk add memories to pool' })
  async addMemoriesBulk(
    @Param('id') id: string,
    @Body() dto: BulkAddMemoriesToPoolDto,
  ) {
    return this.service.addMemoriesBulk(id, dto);
  }

  @Post(':id/memories')
  @ApiOperation({ summary: 'Add memory to pool' })
  async addMemory(@Param('id') id: string, @Body() dto: AddMemoryToPoolDto) {
    return this.service.addMemory(id, dto);
  }

  @Delete(':id/memories/:memoryId')
  @ApiOperation({ summary: 'Remove memory from pool' })
  async removeMemory(
    @Param('id') id: string,
    @Param('memoryId') memoryId: string,
  ) {
    return this.service.removeMemory(id, memoryId);
  }
}
