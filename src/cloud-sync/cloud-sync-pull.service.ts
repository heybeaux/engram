import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt } from '../common/encryption.util';

@Injectable()
export class CloudSyncPullService {
  private readonly logger = new Logger(CloudSyncPullService.name);
  private readonly CLOUD_API_BASE = 'https://api.openengram.ai';

  constructor(private readonly prisma: PrismaService) {}

  async triggerPull(accountId: string): Promise<{
    pulledCount: number;
    newCount: number;
    updatedCount: number;
    skippedCount: number;
    deletedCount: number;
    durationMs: number;
  }> {
    if (!accountId) {
      this.logger.warn(
        'triggerPull called without accountId — auth guard may not have resolved account context for this request',
      );
      throw new BadRequestException(
        'Missing accountId — cannot pull without account context',
      );
    }
    const link = await this.getCloudLink(accountId);
    const syncKey = link.cloudSyncKey
      ? this.decryptApiKey(link.cloudSyncKey)
      : this.decryptApiKey(link.cloudApiKey);

    const startTime = Date.now();
    const since = link.lastPulledAt?.toISOString() ?? new Date(0).toISOString();

    let pulledCount = 0;
    let newCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let deletedCount = 0;
    let currentSince = since;
    let hasMore = true;
    const newMemoryIds: string[] = [];

    while (hasMore) {
      const response = await fetch(
        `${this.CLOUD_API_BASE}/v1/sync/pull?since=${encodeURIComponent(currentSince)}&limit=100`,
        {
          headers: {
            ...(syncKey.startsWith('esync_')
              ? { 'X-Sync-Key': syncKey }
              : { 'X-AM-API-Key': syncKey }),
            'X-Instance-Id': link.instanceId || 'unknown',
          },
        },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new BadRequestException(
          `Cloud pull failed: ${response.status} ${body}`,
        );
      }

      const data = (await response.json()) as {
        memories: Array<{
          cloudId: string;
          localId: string | null;
          raw: string;
          layer: string;
          source: string;
          contentHash: string | null;
          createdAt: string;
          updatedAt: string;
          deletedAt: string | null;
        }>;
        hasMore: boolean;
      };

      for (const mem of data.memories) {
        try {
          // Check if we have this content locally by hash
          if (mem.contentHash) {
            const existingByHash = await this.prisma.memory.findFirst({
              where: { contentHash: mem.contentHash, deletedAt: null },
              select: { id: true },
            });
            if (existingByHash) {
              skippedCount++;
              continue;
            }
          }

          // Tombstone propagation
          if (mem.deletedAt && mem.localId) {
            const localMem = await this.prisma.memory.findUnique({
              where: { id: mem.localId },
              select: { id: true, deletedAt: true },
            });
            if (localMem && !localMem.deletedAt) {
              await this.prisma.memory.update({
                where: { id: mem.localId },
                data: { deletedAt: new Date(mem.deletedAt) },
              });
              deletedCount++;
            } else {
              skippedCount++;
            }
            continue;
          }

          // Update existing local memory
          if (mem.localId) {
            const localMem = await this.prisma.memory.findUnique({
              where: { id: mem.localId },
              select: { id: true, contentHash: true },
            });
            if (localMem) {
              if (localMem.contentHash === mem.contentHash) {
                skippedCount++;
                continue;
              }
              await this.prisma.memory.update({
                where: { id: mem.localId },
                data: {
                  raw: mem.raw,
                  contentHash: mem.contentHash,
                },
              });
              newMemoryIds.push(mem.localId);
              updatedCount++;
              continue;
            }
          }

          // Create new local memory — need a userId
          const defaultUser = await this.prisma.user.findFirst({
            where: { accountId },
            select: { id: true },
          });

          if (!defaultUser) {
            this.logger.warn('No user found for pull sync, skipping memory');
            skippedCount++;
            continue;
          }

          const created = await this.prisma.memory.create({
            data: {
              userId: defaultUser.id,
              raw: mem.raw,
              layer: mem.layer as any,
              source: (mem.source as any) || 'EXPLICIT_STATEMENT',
              contentHash: mem.contentHash,
              createdAt: new Date(mem.createdAt),
            },
          });
          newMemoryIds.push(created.id);
          newCount++;
        } catch (err: any) {
          this.logger.warn(
            `Pull sync error for cloud memory ${mem.cloudId}: ${err.message}`,
          );
        }

        pulledCount++;
      }

      hasMore = data.hasMore;
      if (data.memories.length > 0) {
        currentSince = data.memories[data.memories.length - 1].updatedAt;
      }
    }

    // Update lastPulledAt
    await this.prisma.cloudLink.update({
      where: { accountId },
      data: { lastPulledAt: new Date() },
    });

    // Trigger re-embedding for new/updated memories
    if (newMemoryIds.length > 0) {
      this.triggerEmbeddingBackfill(newMemoryIds).catch((err) => {
        this.logger.warn(`Embedding backfill failed: ${err.message}`);
      });
    }

    const durationMs = Date.now() - startTime;

    // Store sync event
    await this.storePullSyncEvent(accountId, {
      pulledCount,
      newCount,
      updatedCount,
      skippedCount,
      deletedCount,
      durationMs,
    });

    return {
      pulledCount,
      newCount,
      updatedCount,
      skippedCount,
      deletedCount,
      durationMs,
    };
  }

  /**
   * Cloud-side: Serve pull data for local instances
   */
  async handleSyncPull(
    accountId: string,
    instanceId: string,
    since: Date,
    limit: number,
  ): Promise<{ memories: any[]; hasMore: boolean }> {
    const agents = await this.prisma.agent.findMany({
      where: { accountId },
      select: { id: true },
    });
    const agentIds = agents.map((a) => a.id);

    const users = await this.prisma.user.findMany({
      where: { accountId },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);

    const memories = await this.prisma.memory.findMany({
      where: {
        userId: { in: userIds },
        updatedAt: { gt: since },
      },
      select: {
        id: true,
        raw: true,
        layer: true,
        source: true,
        contentHash: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: limit + 1,
    });

    const hasMore = memories.length > limit;
    const batch = hasMore ? memories.slice(0, limit) : memories;

    const cloudMemoryIds = batch.map((m) => m.id);
    const syncMaps = await this.prisma.syncIdMap.findMany({
      where: {
        instanceId,
        cloudMemoryId: { in: cloudMemoryIds },
      },
    });
    const cloudToLocalMap = new Map(
      syncMaps.map((s) => [s.cloudMemoryId, s.localMemoryId]),
    );

    return {
      memories: batch.map((m) => ({
        cloudId: m.id,
        localId: cloudToLocalMap.get(m.id) ?? null,
        raw: m.raw,
        layer: m.layer,
        source: m.source,
        contentHash: m.contentHash,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
        deletedAt: m.deletedAt?.toISOString() ?? null,
      })),
      hasMore,
    };
  }

  private async triggerEmbeddingBackfill(memoryIds: string[]): Promise<void> {
    try {
      const response = await fetch('http://localhost:8080/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memoryIds }),
      });
      if (!response.ok) {
        this.logger.warn(`Embedding backfill returned ${response.status}`);
      }
    } catch (err: any) {
      this.logger.warn(
        `Embedding service unreachable (${err.message}), memories will be embedded on next backfill cycle`,
      );
    }
  }

  private async storePullSyncEvent(
    accountId: string,
    result: {
      pulledCount: number;
      newCount: number;
      updatedCount: number;
      skippedCount: number;
      deletedCount: number;
      durationMs: number;
    },
  ): Promise<void> {
    try {
      await this.prisma.syncEvent.create({
        data: {
          accountId,
          direction: 'pull',
          status: 'completed',
          totalCount: result.pulledCount,
          newCount: result.newCount,
          updatedCount: result.updatedCount,
          skippedCount: result.skippedCount,
          failedCount: result.deletedCount,
          durationMs: result.durationMs,
        },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to store pull sync event: ${err.message}`);
    }
  }

  private async getCloudLink(accountId: string) {
    const link = await this.prisma.cloudLink.findUnique({
      where: { accountId },
    });
    if (!link) {
      throw new BadRequestException('Instance not linked to cloud');
    }
    return link;
  }

  private decryptApiKey(encrypted: string): string {
    return decrypt(encrypted);
  }
}
