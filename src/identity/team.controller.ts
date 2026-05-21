import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { TeamProfileService } from './team-profile.service';
import { CreateIdentityTeamDto } from './dto/team.dto';

class UpdateTeamDto {
  name?: string;
  description?: string;
}

class ModifyMembersDto {
  agentIds: string[];
}

class RecordCollaborationDto {
  agentA: string;
  agentB: string;
  taskDescription: string;
  success: boolean;
}

@ApiTags('teams')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/teams')
export class TeamController {
  constructor(private readonly teamService: TeamProfileService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a team' })
  async create(@Body() dto: CreateIdentityTeamDto) {
    return this.teamService.createTeam(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all teams' })
  async list() {
    return this.teamService.listTeams();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a team by ID' })
  @ApiParam({ name: 'id' })
  async getById(@Param('id') id: string) {
    return this.teamService.getTeam(id);
  }

  @Patch(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update a team' })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() dto: UpdateTeamDto) {
    return this.teamService.updateTeam(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a team' })
  @ApiParam({ name: 'id' })
  async delete(@Param('id') id: string) {
    return this.teamService.deleteTeam(id);
  }

  @Post(':id/members')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add members to a team' })
  @ApiParam({ name: 'id' })
  async addMembers(@Param('id') id: string, @Body() dto: ModifyMembersDto) {
    return this.teamService.addMembers(id, dto.agentIds);
  }

  @Delete(':id/members')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove members from a team' })
  @ApiParam({ name: 'id' })
  async removeMembers(@Param('id') id: string, @Body() dto: ModifyMembersDto) {
    return this.teamService.removeMembers(id, dto.agentIds);
  }

  @Get(':id/capabilities')
  @ApiOperation({ summary: 'Get team capabilities' })
  @ApiParam({ name: 'id' })
  async capabilities(@Param('id') id: string) {
    return this.teamService.getTeamCapabilities(id);
  }

  @Post(':id/collaboration')
  @HttpCode(201)
  @ApiOperation({ summary: 'Record a collaboration event' })
  @ApiParam({ name: 'id' })
  async recordCollaboration(
    @Param('id') id: string,
    @Body() dto: RecordCollaborationDto,
  ) {
    return this.teamService.recordCollaboration(id, dto);
  }
}
