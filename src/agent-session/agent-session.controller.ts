import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AgentSessionService } from './agent-session.service';
import {
  CreateAgentSessionDto,
  UpdateAgentSessionDto,
} from './dto/agent-session.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { UserId } from '../common/decorators/user-id.decorator';

@ApiTags('agent-sessions')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/agent-sessions')
export class AgentSessionController {
  constructor(private readonly service: AgentSessionService) {}

  @Post()
  @ApiOperation({ summary: 'Register or upsert an agent session' })
  async upsert(
    @Body() dto: CreateAgentSessionDto,
    @UserId() authenticatedUserId: string | null,
  ) {
    // HTTP callers often send the external X-AM-User-ID value in dto.userId.
    // Pools are keyed by the resolved internal User.id, so prefer the
    // authenticated user id whenever a session asks for user-owned pool wiring.
    const normalizedDto = authenticatedUserId
      ? { ...dto, userId: authenticatedUserId }
      : dto;
    return this.service.upsert(normalizedDto);
  }

  @Get(':key')
  @ApiOperation({ summary: 'Get agent session by key' })
  async getByKey(@Param('key') key: string) {
    return this.service.getByKey(key);
  }

  @Patch(':key')
  @ApiOperation({ summary: 'Update agent session status' })
  async update(@Param('key') key: string, @Body() dto: UpdateAgentSessionDto) {
    return this.service.updateStatus(key, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List agent sessions' })
  async list(
    @Query('parentKey') parentKey?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (parentKey) {
      const sessions = await this.service.listByParent(parentKey);
      return { sessions, total: sessions.length };
    }
    return this.service.list({
      status: status as any,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }
}
