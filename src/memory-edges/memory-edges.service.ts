import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMemoryEdgeDto } from './memory-edges.dto';

@Injectable()
export class MemoryEdgesService {
  constructor(private readonly prisma: PrismaService) {}

  async createEdge(dto: CreateMemoryEdgeDto, agentId: string) {
    return (this.prisma as any).memoryEdge.create({
      data: {
        sourceId: dto.sourceId,
        targetId: dto.targetId,
        edgeType: dto.edgeType,
        weight: dto.weight ?? 0.5,
        confidence: dto.confidence ?? 0.5,
        temporalStart: dto.temporalStart
          ? new Date(dto.temporalStart)
          : undefined,
        temporalEnd: dto.temporalEnd ? new Date(dto.temporalEnd) : undefined,
        createdBy: dto.createdBy,
        metadata: dto.metadata ?? {},
        agentId,
      },
      include: { source: true, target: true },
    });
  }

  async getEdgesForMemory(
    memoryId: string,
    agentId: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'both',
    edgeTypes?: string[],
  ) {
    const where: any = { agentId };

    if (edgeTypes?.length) {
      where.edgeType = { in: edgeTypes };
    }

    if (direction === 'outgoing') {
      where.sourceId = memoryId;
    } else if (direction === 'incoming') {
      where.targetId = memoryId;
    } else {
      where.OR = [{ sourceId: memoryId }, { targetId: memoryId }];
    }

    return (this.prisma as any).memoryEdge.findMany({
      where,
      include: { source: true, target: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteEdge(id: string, agentId: string) {
    const edge = await (this.prisma as any).memoryEdge.findFirst({
      where: { id, agentId },
    });

    if (!edge) {
      throw new NotFoundException(`Edge ${id} not found`);
    }

    return (this.prisma as any).memoryEdge.delete({ where: { id } });
  }

  async findRelated(
    nodeId: string,
    depth: number,
    edgeTypes: string[],
    agentId: string,
  ) {
    const visited = new Set<string>();
    const queue: Array<{ id: string; currentDepth: number; path: string[] }> = [
      { id: nodeId, currentDepth: 0, path: [nodeId] },
    ];
    const results: Array<{
      memoryId: string;
      depth: number;
      path: string[];
      edgeType: string;
    }> = [];

    while (queue.length > 0) {
      const { id, currentDepth, path } = queue.shift()!;
      if (visited.has(id) || currentDepth >= depth) continue;
      visited.add(id);

      const where: any = {
        agentId,
        OR: [{ sourceId: id }, { targetId: id }],
      };

      if (edgeTypes.length > 0) {
        where.edgeType = { in: edgeTypes };
      }

      const edges = await (this.prisma as any).memoryEdge.findMany({
        where,
        include: { source: true, target: true },
      });

      for (const edge of edges) {
        const neighborId = edge.sourceId === id ? edge.targetId : edge.sourceId;
        if (!visited.has(neighborId)) {
          const newPath = [...path, neighborId];
          results.push({
            memoryId: neighborId,
            depth: currentDepth + 1,
            path: newPath,
            edgeType: edge.edgeType,
          });
          queue.push({
            id: neighborId,
            currentDepth: currentDepth + 1,
            path: newPath,
          });
        }
      }
    }

    return results;
  }
}
