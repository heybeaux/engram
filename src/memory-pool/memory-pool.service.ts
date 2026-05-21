import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateMemoryPoolDto,
  GrantPoolAccessDto,
  AddMemoryToPoolDto,
  BulkAddMemoriesToPoolDto,
} from './dto/memory-pool.dto';

@Injectable()
export class MemoryPoolService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateMemoryPoolDto) {
    return this.prisma.memoryPool.create({
      data: {
        name: dto.name,
        userId: dto.userId,
        visibility: (dto.visibility ?? 'GLOBAL') as any,
        description: dto.description,
        createdBy: dto.createdBy,
      },
    });
  }

  async listByUser(userId: string, visibility?: string) {
    return this.prisma.memoryPool.findMany({
      where: {
        userId,
        archivedAt: null,
        ...(visibility ? { visibility: visibility as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string, includeRelations = false) {
    const pool = await this.prisma.memoryPool.findUnique({
      where: { id },
      include: includeRelations
        ? {
            memberships: {
              include: {
                memory: { select: { id: true, raw: true, createdAt: true } },
              },
            },
            grants: {
              include: {
                agentSession: {
                  select: { id: true, sessionKey: true, label: true },
                },
              },
            },
          }
        : undefined,
    });
    if (!pool) throw new NotFoundException(`Pool '${id}' not found`);
    return pool;
  }

  async findOrCreatePool(dto: CreateMemoryPoolDto) {
    const existing = await this.prisma.memoryPool.findUnique({
      where: { userId_name: { userId: dto.userId, name: dto.name } },
    });
    if (existing) return existing;
    return this.create(dto);
  }

  async deletePool(id: string) {
    await this.getById(id);
    return this.prisma.memoryPool.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
  }

  async grantAccess(poolId: string, dto: GrantPoolAccessDto) {
    await this.getById(poolId);

    if (!dto.agentSessionId && !dto.agentId) {
      throw new BadRequestException('Provide either agentSessionId or agentId');
    }
    if (dto.agentSessionId && dto.agentId) {
      throw new BadRequestException(
        'Provide only one of agentSessionId or agentId',
      );
    }

    if (dto.agentSessionId) {
      return this.prisma.poolGrant.upsert({
        where: {
          poolId_agentSessionId: { poolId, agentSessionId: dto.agentSessionId },
        },
        update: {
          permission: (dto.permission ?? 'READ') as any,
          grantedBy: dto.grantedBy,
        },
        create: {
          poolId,
          agentSessionId: dto.agentSessionId,
          permission: (dto.permission ?? 'READ') as any,
          grantedBy: dto.grantedBy,
        },
      });
    } else {
      return this.prisma.poolGrant.upsert({
        where: {
          poolId_agentId: { poolId, agentId: dto.agentId! },
        },
        update: {
          permission: (dto.permission ?? 'READ') as any,
          grantedBy: dto.grantedBy,
        },
        create: {
          poolId,
          agentId: dto.agentId!,
          permission: (dto.permission ?? 'READ') as any,
          grantedBy: dto.grantedBy,
        },
      });
    }
  }

  async revokeAccess(poolId: string, agentSessionId: string) {
    return this.prisma.poolGrant.delete({
      where: {
        poolId_agentSessionId: { poolId, agentSessionId },
      },
    });
  }

  async revokeAgentAccess(poolId: string, agentId: string) {
    return this.prisma.poolGrant.delete({
      where: {
        poolId_agentId: { poolId, agentId },
      },
    });
  }

  async addMemory(poolId: string, dto: AddMemoryToPoolDto) {
    await this.getById(poolId);
    return this.prisma.memoryPoolMembership.create({
      data: {
        memoryId: dto.memoryId,
        poolId,
        addedBy: dto.addedBy,
      },
    });
  }

  async removeMemory(poolId: string, memoryId: string) {
    return this.prisma.memoryPoolMembership.delete({
      where: {
        memoryId_poolId: { memoryId, poolId },
      },
    });
  }

  /**
   * Resolve all pool IDs accessible to a given agent session.
   * Rules:
   * 1. All GLOBAL pools for this user
   * 2. All SHARED pools where this session has a PoolGrant (cross-user sharing supported)
   * 3. All PRIVATE pools created by this session
   * 4. All pools granted to this agent identity (persistent, survives session rotation)
   */
  async getAccessiblePoolIds(
    sessionKey: string,
    userId: string,
    agentId?: string,
  ): Promise<string[]> {
    // 1. Global pools
    const globalPools = await this.prisma.memoryPool.findMany({
      where: { userId, visibility: 'GLOBAL', archivedAt: null },
      select: { id: true },
    });

    // 2. Find the agent session to get grants and parent
    const agentSession = await this.prisma.agentSession.findUnique({
      where: { sessionKey },
      include: { poolGrants: { select: { poolId: true } } },
    });

    // Shared pools via session grants — grant is the authorization, no userId filter
    const grantedPoolIds = agentSession?.poolGrants.map((g) => g.poolId) ?? [];

    const sharedPools =
      grantedPoolIds.length > 0
        ? await this.prisma.memoryPool.findMany({
            where: {
              id: { in: grantedPoolIds },
              visibility: 'SHARED',
              archivedAt: null,
            },
            select: { id: true },
          })
        : [];

    // 3. Private pools created by this session
    const privatePools = await this.prisma.memoryPool.findMany({
      where: {
        userId,
        visibility: 'PRIVATE',
        createdBy: sessionKey,
        archivedAt: null,
      },
      select: { id: true },
    });

    // 4. Agent-level grants (persistent across sessions)
    let agentGrantedPoolIds: string[] = [];
    if (agentId) {
      const agentGrants = await this.prisma.poolGrant.findMany({
        where: { agentId },
        select: { poolId: true },
      });
      agentGrantedPoolIds = agentGrants.map((g) => g.poolId);
    }

    const allIds = new Set([
      ...globalPools.map((p) => p.id),
      ...sharedPools.map((p) => p.id),
      ...privatePools.map((p) => p.id),
      ...agentGrantedPoolIds,
    ]);

    return Array.from(allIds);
  }

  async addMemoriesBulk(
    poolId: string,
    dto: BulkAddMemoriesToPoolDto,
  ): Promise<{ added: number; skipped: number }> {
    await this.getById(poolId);

    const data = dto.memoryIds.map((memoryId) => ({
      memoryId,
      poolId,
      addedBy: dto.addedBy,
    }));

    const result = await this.prisma.memoryPoolMembership.createMany({
      data,
      skipDuplicates: true,
    });

    return {
      added: result.count,
      skipped: dto.memoryIds.length - result.count,
    };
  }
}
