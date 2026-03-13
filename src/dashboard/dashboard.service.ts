import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryLayer } from '@prisma/client';
import { ListMemoriesDto } from './dto/list-memories.dto';

export interface StatsResponse {
  totalMemories: number;
  memoryTrend: number;
  totalUsers: number;
  userTrend: number;
  healthScore: number;
  memoryByLayer: Array<{ layer: string; count: number; percentage: number }>;
  apiRequests: Array<{ day: string; requests: number }>;
  recentActivity: Array<{ id: string; action: string; time: string }>;
}

export interface MemoriesListResponse {
  memories: any[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface UsersListResponse {
  users: Array<{
    id: string;
    externalId: string;
    memoryCount: number;
    lastActive: string;
    createdAt: string;
  }>;
}

export interface UserDetailResponse {
  id: string;
  externalId: string;
  memoryCount: number;
  memoriesByLayer: Record<string, number>;
  lastActive: string;
  createdAt: string;
}

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  /**
   * Get dashboard overview statistics
   */
  async getStats(agentId: string, accountId: string): Promise<StatsResponse> {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    // Scope all queries to the requesting account
    const accountUsers = await this.prisma.user.findMany({
      where: { accountId, deletedAt: null },
      select: { id: true },
    });
    const accountUserIds = accountUsers.map((u) => u.id);
    const activeMemoryFilter = {
      deletedAt: null,
      userId: { in: accountUserIds },
    } as const;

    // Total memories
    const totalMemories = await this.prisma.memory.count({
      where: activeMemoryFilter,
    });

    // Memories from last week vs previous week (for trend)
    const memoriesLastWeek = await this.prisma.memory.count({
      where: {
        ...activeMemoryFilter,
        createdAt: { gte: oneWeekAgo },
      },
    });

    const memoriesPreviousWeek = await this.prisma.memory.count({
      where: {
        ...activeMemoryFilter,
        createdAt: { gte: twoWeeksAgo, lt: oneWeekAgo },
      },
    });

    const memoryTrend =
      memoriesPreviousWeek === 0
        ? memoriesLastWeek
        : Math.round(
            ((memoriesLastWeek - memoriesPreviousWeek) / memoriesPreviousWeek) *
              100,
          );

    // Total users (scoped to account)
    const totalUsers = await this.prisma.user.count({
      where: { accountId, deletedAt: null },
    });

    // Users from last week vs previous week (scoped to account)
    const usersLastWeek = await this.prisma.user.count({
      where: {
        accountId,
        deletedAt: null,
        createdAt: { gte: oneWeekAgo },
      },
    });

    const usersPreviousWeek = await this.prisma.user.count({
      where: {
        accountId,
        deletedAt: null,
        createdAt: { gte: twoWeeksAgo, lt: oneWeekAgo },
      },
    });

    const userTrend =
      usersPreviousWeek === 0
        ? usersLastWeek
        : Math.round(
            ((usersLastWeek - usersPreviousWeek) / usersPreviousWeek) * 100,
          );

    // Health score: % of memories that have extractions (scoped to account)
    const memoriesWithExtraction = await this.prisma.memoryExtraction.count({
      where: {
        memory: activeMemoryFilter,
      },
    });
    const healthScore =
      totalMemories === 0
        ? 100
        : Math.round((memoriesWithExtraction / totalMemories) * 100);

    // Memory by layer (scoped to account)
    const layerCounts = await this.prisma.memory.groupBy({
      by: ['layer'],
      where: activeMemoryFilter,
      _count: { id: true },
    });

    const memoryByLayer = Object.values(MemoryLayer).map((layer) => {
      const found = layerCounts.find((lc) => lc.layer === layer);
      const count = found?._count?.id ?? 0;
      return {
        layer,
        count,
        percentage:
          totalMemories === 0 ? 0 : Math.round((count / totalMemories) * 100),
      };
    });

    // API requests - placeholder data (we don't track API requests yet)
    const apiRequests = this.generatePlaceholderApiRequests();

    // Recent activity - get recent memories (scoped to account)
    const recentMemories = await this.prisma.memory.findMany({
      where: activeMemoryFilter,
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, createdAt: true, source: true },
    });

    const recentActivity = recentMemories.map((m) => ({
      id: m.id,
      action: `Memory created (${m.source})`,
      time: m.createdAt.toISOString(),
    }));

    return {
      totalMemories,
      memoryTrend,
      totalUsers,
      userTrend,
      healthScore,
      memoryByLayer,
      apiRequests,
      recentActivity,
    };
  }

  /**
   * List memories with pagination and filters
   */
  async listMemories(
    agentId: string,
    dto: ListMemoriesDto,
  ): Promise<MemoriesListResponse> {
    const page = Number(dto.page) || 1;
    const limit = Number(dto.limit) || 25;
    const { layer, userId } = dto;
    const skip = (page - 1) * limit;

    // Get user IDs for this agent
    const userFilter = userId ? { id: userId } : { agentId, deletedAt: null };

    const users = await this.prisma.user.findMany({
      where: userFilter as any,
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);

    const where: any = {
      userId: { in: userIds },
      deletedAt: null,
    };

    if (layer) {
      where.layer = layer;
    }

    const [memories, total] = await Promise.all([
      this.prisma.memory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          extraction: true,
          user: { select: { externalId: true } },
        },
      }),
      this.prisma.memory.count({ where }),
    ]);

    return {
      memories,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * List all users with memory stats
   */
  async listUsers(
    agentId: string,
    accountId?: string,
  ): Promise<UsersListResponse> {
    // If accountId is provided, return users across the account directly
    const where: any = { deletedAt: null };
    if (accountId) {
      where.accountId = accountId;
    } else {
      // Scope to users from the account that owns this agent
      where.account = { agents: { some: { id: agentId, deletedAt: null } } };
    }

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            memories: { where: { deletedAt: null } },
          },
        },
        memories: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });

    return {
      users: users.map((u) => ({
        id: u.id,
        externalId: u.externalId,
        memoryCount: u._count.memories,
        lastActive:
          u.memories[0]?.createdAt?.toISOString() ?? u.createdAt.toISOString(),
        createdAt: u.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Get user detail with stats
   */
  async getUserDetail(userId: string): Promise<UserDetailResponse | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memories: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });

    if (!user || user.deletedAt) {
      return null;
    }

    // Get memory count by layer
    const layerCounts = await this.prisma.memory.groupBy({
      by: ['layer'],
      where: { userId, deletedAt: null },
      _count: { id: true },
    });

    const memoriesByLayer: Record<string, number> = {};
    let totalCount = 0;
    for (const lc of layerCounts) {
      memoriesByLayer[lc.layer] = lc._count.id;
      totalCount += lc._count.id;
    }

    return {
      id: user.id,
      externalId: user.externalId,
      memoryCount: totalCount,
      memoriesByLayer,
      lastActive:
        user.memories[0]?.createdAt?.toISOString() ??
        user.createdAt.toISOString(),
      createdAt: user.createdAt.toISOString(),
    };
  }

  /**
   * Generate placeholder API request data for last 7 days
   */
  private generatePlaceholderApiRequests(): Array<{
    day: string;
    requests: number;
  }> {
    const result: Array<{ day: string; requests: number }> = [];
    const now = new Date();

    for (let i = 6; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dayStr = date.toISOString().split('T')[0];
      // Placeholder: random-ish number based on day
      const requests = Math.floor(100 + Math.random() * 200);
      result.push({ day: dayStr, requests });
    }

    return result;
  }

  /**
   * Delete a user and optionally their memories
   */
  async deleteUser(
    userId: string,
    deleteMemories: boolean = false,
  ): Promise<{ deleted: boolean; memoriesDeleted?: number } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return null;
    }

    let memoriesDeleted = 0;

    if (deleteMemories) {
      // Hard delete memories
      const result = await this.prisma.memory.deleteMany({
        where: { userId },
      });
      memoriesDeleted = result.count;
    } else {
      // Check if user has memories - prevent deletion if so
      const memoryCount = await this.prisma.memory.count({
        where: { userId, deletedAt: null },
      });

      if (memoryCount > 0) {
        // Soft delete by reassigning to a "deleted" placeholder or just leave orphaned
        // For now, we'll allow deletion and orphan the memories
      }
    }

    // Delete the user
    await this.prisma.user.delete({
      where: { id: userId },
    });

    return { deleted: true, memoriesDeleted };
  }

  /**
   * Comprehensive health check for the memory system
   * Reports on extraction quality, entity extraction, linking, and more
   */
  async getHealth(): Promise<HealthResponse> {
    const [
      totalMemories,
      extractionsWithWho,
      extractionsWithWhat,
      totalEntities,
      totalLinks,
      memoriesLast24h,
      safetyCriticalCount,
      consolidatedCount,
    ] = await Promise.all([
      this.prisma.memory.count({ where: { deletedAt: null } }),
      this.prisma.memoryExtraction.count({
        where: { who: { not: null }, memory: { deletedAt: null } },
      }),
      this.prisma.memoryExtraction.count({
        where: { what: { not: null }, memory: { deletedAt: null } },
      }),
      this.prisma.entity.count(),
      this.prisma.memoryChainLink.count(),
      this.prisma.memory.count({
        where: {
          deletedAt: null,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
      this.prisma.memory.count({
        where: { safetyCritical: true, deletedAt: null },
      }),
      this.prisma.memory.count({ where: { consolidated: true } }),
    ]);

    const extractionRate =
      totalMemories > 0
        ? Math.round((extractionsWithWhat / totalMemories) * 100)
        : 100;

    const whoExtractionRate =
      totalMemories > 0
        ? Math.round((extractionsWithWho / totalMemories) * 100)
        : 100;

    // Determine overall status
    let status: 'healthy' | 'degraded' | 'unhealthy';
    const issues: string[] = [];

    if (extractionRate >= 80 && whoExtractionRate >= 70) {
      status = 'healthy';
    } else if (extractionRate >= 50) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    if (extractionRate < 80) {
      issues.push(`Low extraction rate: ${extractionRate}% (target: 80%)`);
    }
    if (whoExtractionRate < 70) {
      issues.push(`Low WHO extraction: ${whoExtractionRate}% (target: 70%)`);
    }
    if (totalEntities === 0 && totalMemories > 10) {
      issues.push('No entities extracted - check extraction pipeline');
    }
    if (totalLinks === 0 && totalMemories > 20) {
      issues.push('No memory links - check linking pipeline');
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      metrics: {
        totalMemories,
        extractionRate,
        whoExtractionRate,
        entitiesPerMemory:
          totalMemories > 0 ? +(totalEntities / totalMemories).toFixed(2) : 0,
        linksPerMemory:
          totalMemories > 0 ? +(totalLinks / totalMemories).toFixed(2) : 0,
        memoriesLast24h,
        safetyCriticalCount,
        consolidatedCount,
      },
      issues,
    };
  }
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  metrics: {
    totalMemories: number;
    extractionRate: number;
    whoExtractionRate: number;
    entitiesPerMemory: number;
    linksPerMemory: number;
    memoriesLast24h: number;
    safetyCriticalCount: number;
    consolidatedCount: number;
  };
  issues: string[];
}
