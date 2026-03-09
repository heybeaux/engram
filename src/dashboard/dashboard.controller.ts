import {
  Controller,
  Get,
  Delete,
  Param,
  Query,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  DashboardService,
  StatsResponse,
  MemoriesListResponse,
  UsersListResponse,
  UserDetailResponse,
  HealthResponse,
} from './dashboard.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { InternalOnlyGuard } from '../common/guards/internal-only.guard';
import { Agent } from '../common/decorators/user-id.decorator';
import { ListMemoriesDto } from './dto/list-memories.dto';

@ApiTags('Dashboard')
@Controller('v1')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  // NOTE: GET /health is served by HealthController (k8s/load balancer probe)

  /**
   * GET /v1/stats
   * Dashboard overview statistics
   */
  @Get('stats')
  @UseGuards(ApiKeyOrJwtGuard)
  async getStats(@Agent() agent: any): Promise<StatsResponse> {
    return this.dashboardService.getStats(agent.id, agent.accountId);
  }

  /**
   * GET /v1/memories
   * List memories with pagination and filters
   */
  @Get('memories')
  @UseGuards(ApiKeyOrJwtGuard)
  async listMemories(
    @Agent() agent: any,
    @Query() dto: ListMemoriesDto,
  ): Promise<MemoriesListResponse> {
    return this.dashboardService.listMemories(agent.id, dto);
  }

  /**
   * GET /v1/users
   * List all users with memory stats
   */
  @Get('users')
  @UseGuards(InternalOnlyGuard, ApiKeyOrJwtGuard)
  async listUsers(@Agent() agent: any): Promise<UsersListResponse> {
    return this.dashboardService.listUsers(agent.id, agent.accountId);
  }

  /**
   * GET /v1/users/:id
   * User detail with stats
   */
  @Get('users/:id')
  @UseGuards(InternalOnlyGuard, ApiKeyOrJwtGuard)
  async getUserDetail(@Param('id') id: string): Promise<UserDetailResponse> {
    const user = await this.dashboardService.getUserDetail(id);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  /**
   * DELETE /v1/users/:id
   * Delete a user and optionally their memories
   */
  @Delete('users/:id')
  @UseGuards(InternalOnlyGuard, ApiKeyOrJwtGuard)
  async deleteUser(
    @Param('id') id: string,
    @Query('deleteMemories') deleteMemories?: string,
  ): Promise<{ deleted: boolean; memoriesDeleted?: number }> {
    const result = await this.dashboardService.deleteUser(
      id,
      deleteMemories === 'true',
    );
    if (!result) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return result;
  }
}
