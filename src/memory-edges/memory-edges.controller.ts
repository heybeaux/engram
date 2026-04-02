import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { MemoryEdgesService } from './memory-edges.service';
import {
  CreateMemoryEdgeDto,
  GetEdgesQueryDto,
  FindRelatedDto,
} from './memory-edges.dto';

@ApiTags('Memory Edges')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/memory-edges')
export class MemoryEdgesController {
  constructor(private readonly memoryEdgesService: MemoryEdgesService) {}

  private getAgentId(req: any): string {
    const agentId = req.agent?.id;
    if (!agentId) {
      throw new BadRequestException('Agent context required');
    }
    return agentId;
  }

  @Post()
  async createEdge(@Body() dto: CreateMemoryEdgeDto, @Req() req: any) {
    const agentId = this.getAgentId(req);
    return this.memoryEdgesService.createEdge(dto, agentId);
  }

  @Get(':memoryId')
  async getEdgesForMemory(
    @Param('memoryId') memoryId: string,
    @Query() query: GetEdgesQueryDto,
    @Req() req: any,
  ) {
    const agentId = this.getAgentId(req);
    return this.memoryEdgesService.getEdgesForMemory(
      memoryId,
      agentId,
      query.direction,
      query.edgeTypes,
    );
  }

  @Delete(':id')
  async deleteEdge(@Param('id') id: string, @Req() req: any) {
    const agentId = this.getAgentId(req);
    return this.memoryEdgesService.deleteEdge(id, agentId);
  }

  @Post('find-related')
  async findRelated(@Body() dto: FindRelatedDto, @Req() req: any) {
    const agentId = this.getAgentId(req);
    return this.memoryEdgesService.findRelated(
      dto.nodeId,
      dto.depth ?? 1,
      dto.edgeTypes ?? [],
      agentId,
    );
  }
}
