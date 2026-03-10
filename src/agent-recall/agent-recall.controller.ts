import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { AgentRecallService } from './agent-recall.service';
import { BatchRecallDto } from './dto/batch-recall.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { Agent } from '../common/decorators/user-id.decorator';

@ApiTags('Agent Recall')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/agent/recall')
export class AgentRecallController {
  constructor(private readonly service: AgentRecallService) {}

  @Get(':entityName')
  @ApiOperation({
    summary: 'Recall a single entity',
    description:
      'Look up an entity by name with multi-strategy matching (exact, alias, fuzzy, semantic). Returns profile, memories, relationships, and unverified attributes.',
  })
  @ApiParam({
    name: 'entityName',
    description: 'Entity name (URL-encoded)',
    example: 'MAP%20International',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max memories to return (default 10)',
    example: 10,
  })
  @ApiResponse({ status: 200, description: 'Entity recall result.' })
  @ApiResponse({ status: 404, description: 'Entity not found.' })
  async recallOne(
    @Agent() agent: any,
    @Param('entityName') entityName: string,
    @Query('limit') limit?: string,
  ) {
    const decodedName = decodeURIComponent(entityName);
    const memoryLimit = limit ? Math.min(parseInt(limit, 10) || 10, 100) : 10;

    const result = await this.service.recallEntity(
      agent.accountId,
      decodedName,
      memoryLimit,
    );

    if (!result) {
      throw new NotFoundException(
        `No entity found matching "${decodedName}"`,
      );
    }

    return result;
  }

  @Post()
  @ApiOperation({
    summary: 'Batch recall multiple entities',
    description:
      'Recall up to 20 entities in one request. Unknown entities return null in the array.',
  })
  @ApiResponse({ status: 200, description: 'Array of recall results (null for misses).' })
  async recallBatch(@Agent() agent: any, @Body() dto: BatchRecallDto) {
    const limit = dto.limit ?? 10;
    return this.service.recallBatch(agent.accountId, dto.entities, limit);
  }
}
