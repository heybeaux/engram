import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CloudLinkService } from '../cloud-link/cloud-link.service';
import { decrypt } from '../common/encryption.util';
import { generateContentHash } from '../common/content-hash.util';

const BATCH_SIZE = 10; // Reduced from 200 — Railway body limit is 100KB; 10 memories stays ~20KB per batch

export interface ReconciliationPlan {
  localOnly: ReconciliationItem[];
  cloudOnly: ReconciliationItem[];
  shared: ReconciliationItem[];
  summary: {
    localOnlyCount: number;
    cloudOnlyCount: number;
    sharedCount: number;
    totalLocal: number;
    totalCloud: number;
    wouldPush: number;
    wouldPull: number;
    alreadySynced: number;
  };
}

export interface ReconciliationItem {
  contentHash: string;
  raw: string;
  localId?: string;
  cloudId?: string;
  layer?: string;
  createdAt?: string;
}

export interface ReconciliationResult {
  pushed: number;
  pulled: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

@Injectable()
export class SyncReconciliationService {
  private readonly logger = new Logger(SyncReconciliationService.name);
  private readonly CLOUD_API_BASE = 'https://api.openengram.ai';

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudLinkService: CloudLinkService,
  ) {}

  /**
   * Compare local and cloud memories by contentHash to produce a reconciliation plan.
   */
  async reconcile(accountId: string): Promise<ReconciliationPlan> {
    const link = await this.getCloudLink(accountId);
    const apiKey = link.cloudSyncKey
      ? this.decryptApiKey(link.cloudSyncKey)
      : this.decryptApiKey(link.cloudApiKey);

    // 1. Gather local content hashes (backfill any missing ones first)
    await this.ensureLocalContentHashes();
    const localMemories = await this.prisma.memory.findMany({
      where: { deletedAt: null, contentHash: { not: null } },
      select: {
        id: true,
        raw: true,
        contentHash: true,
        layer: true,
        createdAt: true,
      },
    });

    const localByHash = new Map<string, (typeof localMemories)[0]>();
    for (const m of localMemories) {
      if (m.contentHash) localByHash.set(m.contentHash, m);
    }

    // 2. Gather cloud content hashes via paginated pull
    const cloudMemories = await this.fetchAllCloudHashes(apiKey);
    const cloudByHash = new Map<
      string,
      { id: string; raw: string; layer: string; createdAt: string }
    >();
    for (const m of cloudMemories) {
      if (m.contentHash) cloudByHash.set(m.contentHash, m);
    }

    // 3. Classify
    const localOnly: ReconciliationItem[] = [];
    const cloudOnly: ReconciliationItem[] = [];
    const shared: ReconciliationItem[] = [];

    for (const [hash, local] of localByHash) {
      if (cloudByHash.has(hash)) {
        const cloud = cloudByHash.get(hash)!;
        shared.push({
          contentHash: hash,
          raw: local.raw.slice(0, 200),
          localId: local.id,
          cloudId: cloud.id,
          layer: local.layer,
          createdAt: local.createdAt.toISOString(),
        });
      } else {
        localOnly.push({
          contentHash: hash,
          raw: local.raw.slice(0, 200),
          localId: local.id,
          layer: local.layer,
          createdAt: local.createdAt.toISOString(),
        });
      }
    }

    for (const [hash, cloud] of cloudByHash) {
      if (!localByHash.has(hash)) {
        cloudOnly.push({
          contentHash: hash,
          raw: cloud.raw.slice(0, 200),
          cloudId: cloud.id,
          layer: cloud.layer,
          createdAt: cloud.createdAt,
        });
      }
    }

    return {
      localOnly,
      cloudOnly,
      shared,
      summary: {
        localOnlyCount: localOnly.length,
        cloudOnlyCount: cloudOnly.length,
        sharedCount: shared.length,
        totalLocal: localByHash.size,
        totalCloud: cloudByHash.size,
        wouldPush: localOnly.length,
        wouldPull: cloudOnly.length,
        alreadySynced: shared.length,
      },
    };
  }

  /**
   * Execute a reconciliation plan: push local-only to cloud, pull cloud-only to local.
   */
  async executeReconciliation(
    accountId: string,
    plan: ReconciliationPlan,
  ): Promise<ReconciliationResult> {
    const link = await this.getCloudLink(accountId);
    const apiKey = link.cloudSyncKey
      ? this.decryptApiKey(link.cloudSyncKey)
      : this.decryptApiKey(link.cloudApiKey);
    const instanceId = link.instanceId || 'unknown';

    const startTime = Date.now();
    let pushed = 0;
    let pulled = 0;
    let skipped = 0;
    let errors = 0;

    // Push local-only memories to cloud
    if (plan.localOnly.length > 0) {
      const localIds = plan.localOnly.map((m) => m.localId!).filter(Boolean);
      const memories = await this.prisma.memory.findMany({
        where: { id: { in: localIds }, deletedAt: null },
        include: { extraction: true, entities: { include: { entity: true } } },
      });

      // Push in batches
      for (let i = 0; i < memories.length; i += BATCH_SIZE) {
        const batch = memories.slice(i, i + BATCH_SIZE);
        try {
          const result = await this.pushBatchToCloud(batch, apiKey, instanceId);
          pushed += result.created;
          skipped += result.skipped;
          errors += result.errors;
        } catch (err: any) {
          this.logger.warn(`Reconciliation push batch failed: ${err.message}`);
          errors += batch.length;
        }
      }
    }

    // Pull cloud-only memories to local
    if (plan.cloudOnly.length > 0) {
      const cloudApiKey = this.decryptApiKey(link.cloudApiKey);
      for (const item of plan.cloudOnly) {
        try {
          const cloudMemory = await this.fetchCloudMemory(
            cloudApiKey,
            item.cloudId!,
          );
          if (!cloudMemory) {
            skipped++;
            continue;
          }

          // Check for duplicate by hash one more time
          const existing = await this.prisma.memory.findFirst({
            where: { contentHash: item.contentHash, deletedAt: null },
            select: { id: true },
          });
          if (existing) {
            skipped++;
            continue;
          }

          // Find a default user for the account
          const defaultUser = await this.prisma.user.findFirst({
            where: { accountId },
            select: { id: true },
          });
          if (!defaultUser) {
            this.logger.warn('No local user found for pull reconciliation');
            errors++;
            continue;
          }

          await this.prisma.memory.create({
            data: {
              userId: defaultUser.id,
              raw: cloudMemory.raw,
              layer: (cloudMemory.layer as any) || 'SEMANTIC',
              source: (cloudMemory.source as any) || 'EXPLICIT_STATEMENT',
              contentHash: item.contentHash,
              createdAt: cloudMemory.createdAt
                ? new Date(cloudMemory.createdAt)
                : undefined,
            },
          });
          pulled++;
        } catch (err: any) {
          this.logger.warn(
            `Reconciliation pull failed for ${item.cloudId}: ${err.message}`,
          );
          errors++;
        }
      }
    }

    // Mark shared memories as synced locally
    if (plan.shared.length > 0) {
      const sharedLocalIds = plan.shared.map((m) => m.localId!).filter(Boolean);
      if (sharedLocalIds.length > 0) {
        await this.prisma.memory.updateMany({
          where: { id: { in: sharedLocalIds } },
          data: { cloudSyncedAt: new Date() },
        });
      }
    }

    const durationMs = Date.now() - startTime;

    // Store sync event
    try {
      await this.prisma.syncEvent.create({
        data: {
          accountId,
          direction: 'reconcile',
          status: 'completed',
          totalCount: pushed + pulled,
          newCount: pushed + pulled,
          updatedCount: 0,
          skippedCount: skipped,
          failedCount: errors,
          durationMs,
        },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to store reconciliation event: ${err.message}`);
    }

    return { pushed, pulled, skipped, errors, durationMs };
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private async ensureLocalContentHashes(): Promise<void> {
    const missing = await this.prisma.memory.findMany({
      where: { contentHash: null, deletedAt: null },
      select: { id: true, raw: true },
      take: 5000,
    });

    for (const mem of missing) {
      const hash = generateContentHash(mem.raw);
      await this.prisma.memory.update({
        where: { id: mem.id },
        data: { contentHash: hash },
      });
    }

    if (missing.length > 0) {
      this.logger.log(
        `Backfilled ${missing.length} content hashes for reconciliation`,
      );
    }
  }

  private async fetchAllCloudHashes(apiKey: string): Promise<
    Array<{
      id: string;
      raw: string;
      contentHash: string;
      layer: string;
      createdAt: string;
    }>
  > {
    const all: Array<{
      id: string;
      raw: string;
      contentHash: string;
      layer: string;
      createdAt: string;
    }> = [];
    let since = new Date(0).toISOString();
    let hasMore = true;

    while (hasMore) {
      const response = await fetch(
        `${this.CLOUD_API_BASE}/v1/sync/pull?since=${encodeURIComponent(since)}&limit=500`,
        {
          headers: {
            ...(apiKey.startsWith('esync_')
              ? { 'X-Sync-Key': apiKey }
              : { 'X-AM-API-Key': apiKey }),
            'X-Instance-Id': 'reconciliation',
          },
        },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new BadRequestException(
          `Cloud API error ${response.status}: ${body}`,
        );
      }

      const data = (await response.json()) as {
        memories: Array<{
          cloudId: string;
          raw: string;
          contentHash: string | null;
          layer: string;
          createdAt: string;
          updatedAt: string;
          deletedAt: string | null;
        }>;
        hasMore: boolean;
      };

      for (const m of data.memories) {
        if (!m.deletedAt && m.contentHash) {
          all.push({
            id: m.cloudId,
            raw: m.raw,
            contentHash: m.contentHash,
            layer: m.layer,
            createdAt: m.createdAt,
          });
        }
      }

      hasMore = data.hasMore;
      if (data.memories.length > 0) {
        since = data.memories[data.memories.length - 1].updatedAt;
      } else {
        hasMore = false;
      }
    }

    return all;
  }

  private async fetchCloudMemory(
    apiKey: string,
    cloudId: string,
  ): Promise<{
    raw: string;
    layer: string;
    source: string;
    createdAt: string;
  } | null> {
    // Use the pull endpoint with a narrow time window — or search by ID
    // For simplicity, we already have the data from the reconciliation plan's cloud fetch
    // But if we need fresh data, we fetch the full memory
    try {
      const response = await fetch(
        `${this.CLOUD_API_BASE}/v1/memories/${cloudId}`,
        {
          headers: { 'X-AM-API-Key': apiKey },
        },
      );
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  private async pushBatchToCloud(
    memories: any[],
    apiKey: string,
    instanceId: string,
  ): Promise<{ created: number; skipped: number; errors: number }> {
    const payload = {
      memories: memories.map((m) => ({
        raw: m.raw,
        layer: m.layer,
        memoryType: m.memoryType ?? undefined,
        source: m.source,
        importanceHint: m.importanceHint ?? undefined,
        importanceScore: m.importanceScore,
        effectiveScore: m.effectiveScore,
        priority: m.priority,
        contentHash: m.contentHash || generateContentHash(m.raw),
        localId: m.id,
        instanceId,
        createdAt: m.createdAt.toISOString(),
        extraction: m.extraction
          ? {
              who: m.extraction.who ?? undefined,
              what: m.extraction.what ?? undefined,
              when: m.extraction.when?.toISOString() ?? undefined,
              whereCtx: m.extraction.whereCtx ?? undefined,
              why: m.extraction.why ?? undefined,
              how: m.extraction.how ?? undefined,
              topics: m.extraction.topics ?? [],
            }
          : undefined,
      })),
      syncProtocolVersion: 2,
    };

    const response = await fetch(`${this.CLOUD_API_BASE}/v1/sync/push`, {
      method: 'POST',
      headers: {
        ...(apiKey.startsWith('esync_')
          ? { 'X-Sync-Key': apiKey }
          : { 'X-AM-API-Key': apiKey }),
        'X-Instance-Id': instanceId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Cloud push failed: ${response.status} ${body}`);
    }

    const result = (await response.json()) as {
      results: Array<{
        sourceMemoryId: string;
        cloudMemoryId?: string;
        status: string;
      }>;
    };

    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const item of result.results) {
      if (item.status === 'created') {
        created++;
        // Mark as synced locally
        await this.prisma.memory
          .update({
            where: { id: item.sourceMemoryId },
            data: { cloudSyncedAt: new Date() },
          })
          .catch(() => {});
      } else if (item.status === 'skipped') {
        skipped++;
        await this.prisma.memory
          .update({
            where: { id: item.sourceMemoryId },
            data: { cloudSyncedAt: new Date() },
          })
          .catch(() => {});
      } else {
        errors++;
      }
    }

    return { created, skipped, errors };
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
