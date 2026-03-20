import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../prisma/prisma.service';
import { CloudLinkService } from '../cloud-link/cloud-link.service';
import { MemoryCreatedEvent } from '../events/event-types';
import { decrypt } from '../common/encryption.util';
import { generateContentHash } from '../common/content-hash.util';
import {
  SyncPushDto,
  SyncPushResponse,
  SyncPushResultItem,
} from './dto/sync-push.dto';

// Delegate services
import { CloudSyncPushService, SyncResult } from './cloud-sync-push.service';
import { CloudSyncPullService } from './cloud-sync-pull.service';
import { CloudSyncIngestService } from './cloud-sync-ingest.service';

// Re-export types for backward compatibility
export type { SyncResult } from './cloud-sync-push.service';

export interface SyncStatus {
  lastSyncedAt: string | null;
  totalMemories: number;
  syncedCount: number;
  pendingCount: number;
  autoSync: boolean;
  syncing: boolean;
  progress?: { synced: number; total: number };
}

@Injectable()
export class CloudSyncService {
  private readonly logger = new Logger(CloudSyncService.name);
  private syncAbortController: AbortController | null = null;
  private syncProgress = { synced: 0, total: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudLinkService: CloudLinkService,
    private readonly pushService: CloudSyncPushService,
    private readonly pullService: CloudSyncPullService,
    private readonly ingestService: CloudSyncIngestService,
  ) {}

  /**
   * Acquire a PostgreSQL advisory lock for cloud sync.
   * Returns true if the lock was acquired, false if another instance holds it.
   */
  private async acquireAdvisoryLock(): Promise<boolean> {
    const result = await this.prisma.$queryRawUnsafe<
      [{ pg_try_advisory_lock: boolean }]
    >(`SELECT pg_try_advisory_lock(hashtext('engram_cloud_sync'))`);
    return result[0]?.pg_try_advisory_lock === true;
  }

  /**
   * Release the PostgreSQL advisory lock for cloud sync.
   */
  private async releaseAdvisoryLock(): Promise<void> {
    await this.prisma.$queryRawUnsafe(
      `SELECT pg_advisory_unlock(hashtext('engram_cloud_sync'))`,
    );
  }

  async triggerSync(accountId: string): Promise<{ message: string }> {
    if (!accountId) {
      this.logger.warn(
        'triggerSync called without accountId — this usually means the auth guard did not resolve account context. ' +
          'Check that TRUST_LOCAL_NETWORK=true is set and the api-key guard resolves the default account for local requests.',
      );
      throw new BadRequestException(
        'Missing accountId — cannot trigger sync without account context',
      );
    }
    const link = await this.getCloudLink(accountId);
    const syncKey = link.cloudSyncKey
      ? this.decryptApiKey(link.cloudSyncKey)
      : this.decryptApiKey(link.cloudApiKey);
    const instanceId = link.instanceId;

    // Acquire distributed lock — if another instance is syncing, bail out
    const lockAcquired = await this.acquireAdvisoryLock();
    if (!lockAcquired) {
      this.logger.log(
        'Another instance is syncing — advisory lock held, skipping',
      );
      throw new BadRequestException(
        'Sync already in progress on another instance',
      );
    }

    this.syncAbortController = new AbortController();
    this.syncProgress = { synced: 0, total: 0 };

    const startTime = Date.now();

    // IMPORTANT: Use a fresh PrismaClient for background sync, NOT this.prisma.
    // PrismaService uses a Proxy that delegates to the RLS transaction from the
    // HTTP request's interceptor. By the time setImmediate fires, that transaction
    // is already committed, causing "Transaction already closed" errors.
    // Creating a standalone client bypasses the RLS proxy entirely.
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL,
    });
    const backgroundDb = new PrismaClient({ adapter });

    setImmediate(
      () =>
        void (async () => {
          try {
            const result = await this.pushService.performSyncWithClient(
              backgroundDb,
              syncKey,
              instanceId,
              this.syncAbortController!.signal,
              this.syncProgress,
            );
            await backgroundDb.syncEvent.create({
              data: {
                accountId,
                direction: 'push',
                status: 'completed',
                totalCount: result.syncedCount,
                newCount: result.newCount,
                updatedCount: result.updatedCount,
                skippedCount: result.skippedCount,
                failedCount: result.errorCount,
                durationMs: result.durationMs,
              },
            });
            this.logger.log(
              `Sync completed: ${result.syncedCount} synced, ${result.errorCount} errors, ${result.durationMs}ms`,
            );
          } catch (error: any) {
            this.logger.error(`Sync failed: ${error.message}`);
            const durationMs = Date.now() - startTime;
            await backgroundDb.syncEvent
              .create({
                data: {
                  accountId,
                  direction: 'push',
                  status: 'failed',
                  totalCount: 0,
                  newCount: 0,
                  updatedCount: 0,
                  skippedCount: 0,
                  failedCount: 0,
                  error: error.message,
                  durationMs,
                },
              })
              .catch(() => {});
          } finally {
            this.syncAbortController = null;
            await this.releaseAdvisoryLock().catch((err) =>
              this.logger.warn(
                `Failed to release advisory lock: ${err.message}`,
              ),
            );
            await backgroundDb.$disconnect().catch(() => {});
          }
        })(),
    );

    return { message: 'Sync started in background' };
  }

  async getSyncHistory(accountId: string, limit = 5) {
    return this.prisma.syncEvent.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  cancelSync(): void {
    if (this.syncAbortController) {
      this.syncAbortController.abort();
      this.logger.log('Sync cancellation requested');
    }
  }

  isSyncing(): boolean {
    return this.syncAbortController !== null;
  }

  getSyncProgress(): { synced: number; total: number } {
    return { ...this.syncProgress };
  }

  async getSyncStatus(accountId: string): Promise<SyncStatus> {
    if (!accountId) {
      this.logger.warn(
        'getSyncStatus called without accountId — auth guard may not have resolved account context',
      );
      throw new BadRequestException('Missing accountId');
    }
    const link = await this.prisma.cloudLink.findUnique({
      where: { accountId },
    });

    if (!link) {
      throw new BadRequestException('Instance not linked to cloud');
    }

    const [totalMemories, syncedCount, lastSynced] = await Promise.all([
      this.prisma.memory.count({ where: { deletedAt: null } }),
      this.prisma.memory.count({
        where: { deletedAt: null, cloudSyncedAt: { not: null } },
      }),
      this.prisma.memory.findFirst({
        where: { cloudSyncedAt: { not: null } },
        orderBy: { cloudSyncedAt: 'desc' },
        select: { cloudSyncedAt: true },
      }),
    ]);

    return {
      lastSyncedAt: lastSynced?.cloudSyncedAt?.toISOString() ?? null,
      totalMemories,
      syncedCount,
      pendingCount: totalMemories - syncedCount,
      autoSync: link.autoSync,
      syncing: this.isSyncing(),
      ...(this.isSyncing() ? { progress: this.getSyncProgress() } : {}),
    };
  }

  async setAutoSync(accountId: string, enabled: boolean): Promise<void> {
    const link = await this.prisma.cloudLink.findUnique({
      where: { accountId },
    });
    if (!link) {
      throw new BadRequestException('Instance not linked to cloud');
    }
    await this.prisma.cloudLink.update({
      where: { accountId },
      data: { autoSync: enabled },
    });
  }

  @OnEvent('memory.created')
  async handleMemoryCreated(event: MemoryCreatedEvent): Promise<void> {
    try {
      const link = await this.prisma.cloudLink.findFirst({
        where: { autoSync: true },
      });
      if (!link) return;

      const apiKey = link.cloudSyncKey
        ? this.decryptApiKey(link.cloudSyncKey)
        : this.decryptApiKey(link.cloudApiKey);
      const memory = await this.prisma.memory.findUnique({
        where: { id: event.memoryId },
        include: { extraction: true, entities: { include: { entity: true } } },
      });
      if (!memory || memory.deletedAt) return;

      if (!memory.contentHash) {
        const contentHash = generateContentHash(memory.raw);
        await this.prisma.memory.update({
          where: { id: memory.id },
          data: { contentHash },
        });
        (memory as any).contentHash = contentHash;
      }

      await this.pushService.syncBatchToCloud(
        [memory],
        apiKey,
        link.instanceId,
      );
    } catch (error: any) {
      this.logger.warn(
        `Auto-sync failed for memory ${event.memoryId}: ${error.message}`,
      );
    }
  }

  // =========================================================================
  // Delegated cloud-side operations
  // =========================================================================

  async handleSyncPush(
    accountId: string,
    instanceId: string,
    dto: SyncPushDto,
  ): Promise<SyncPushResponse> {
    return this.ingestService.handleSyncPush(accountId, instanceId, dto);
  }

  async handleSyncPull(
    accountId: string,
    instanceId: string,
    since: Date,
    limit: number,
  ): Promise<{ memories: any[]; hasMore: boolean }> {
    return this.pullService.handleSyncPull(accountId, instanceId, since, limit);
  }

  async triggerPull(accountId: string) {
    return this.pullService.triggerPull(accountId);
  }

  async updateCloudInstance(
    accountId: string,
    instanceId: string,
    instanceName: string | undefined,
    pushCount: number,
  ): Promise<void> {
    return this.ingestService.updateCloudInstance(
      accountId,
      instanceId,
      instanceName,
      pushCount,
    );
  }

  async getInstances(accountId: string) {
    return this.ingestService.getInstances(accountId);
  }

  // =========================================================================
  // Content hash backfill
  // =========================================================================

  async backfillContentHashes(batchSize = 500): Promise<{ updated: number }> {
    let updated = 0;
    let cursor: string | undefined;

    while (true) {
      const memories = await this.prisma.memory.findMany({
        where: { contentHash: null, deletedAt: null },
        select: { id: true, raw: true },
        take: batchSize,
        orderBy: { id: 'asc' },
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (memories.length === 0) break;

      for (const mem of memories) {
        const hash = generateContentHash(mem.raw);
        await this.prisma.memory.update({
          where: { id: mem.id },
          data: { contentHash: hash },
        });
        updated++;
      }

      cursor = memories[memories.length - 1].id;
      this.logger.log(`Backfilled ${updated} content hashes...`);
    }

    this.logger.log(
      `Content hash backfill complete: ${updated} memories updated`,
    );
    return { updated };
  }

  // =========================================================================
  // Sync event history
  // =========================================================================

  private async storeSyncEvent(
    accountId: string,
    result: SyncResult,
    status: string,
    error?: string,
  ): Promise<void> {
    try {
      await this.prisma.syncEvent.create({
        data: {
          accountId,
          direction: 'push',
          status,
          totalCount: result.syncedCount,
          newCount: result.newCount,
          updatedCount: result.updatedCount,
          skippedCount: result.skippedCount,
          failedCount: result.errorCount,
          error: error ?? null,
          durationMs: result.durationMs,
        },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to store sync event: ${err.message}`);
    }
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

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
