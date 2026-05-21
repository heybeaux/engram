import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { generateContentHash } from '../common/content-hash.util';
import { SyncPushDto, SyncPushResponse } from './dto/sync-push.dto';

const BATCH_SIZE = 10; // Reduced from 50 — Railway cloud has 100KB body limit; 10 memories+embeddings stays ~20KB
const BATCH_DELAY_MS = 200;
const MAX_SYNC_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface SyncResult {
  syncedCount: number;
  newCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  lastSyncedAt: string | null;
  durationMs: number;
}

@Injectable()
export class CloudSyncPushService {
  private readonly logger = new Logger(CloudSyncPushService.name);
  private readonly CLOUD_API_BASE: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.CLOUD_API_BASE = this.configService.get<string>(
      'CLOUD_API_URL',
      'https://api.openengram.ai',
    );
  }

  async performSyncWithClient(
    db: PrismaClient | PrismaService,
    apiKey: string,
    instanceId: string | null,
    signal: AbortSignal,
    syncProgress: { synced: number; total: number },
  ): Promise<SyncResult> {
    let syncedCount = 0;
    let newCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let lastSyncedAt: string | null = null;
    const startTime = Date.now();

    // Count total pending for progress tracking
    const totalPending = await db.memory.count({
      where: { deletedAt: null, cloudSyncedAt: null },
    });
    syncProgress.synced = 0;
    syncProgress.total = totalPending;

    // Process in batches
    let cursor: string | undefined;
    while (true) {
      if (signal.aborted) {
        this.logger.log(
          `Sync cancelled. Synced ${syncedCount} memories before cancellation.`,
        );
        break;
      }

      if (Date.now() - startTime > MAX_SYNC_DURATION_MS) {
        this.logger.warn(
          `Sync timed out after ${MAX_SYNC_DURATION_MS / 1000}s. Synced ${syncedCount} memories.`,
        );
        break;
      }

      const batch = await db.memory.findMany({
        where: {
          deletedAt: null,
          cloudSyncedAt: null,
        },
        include: { extraction: true, entities: { include: { entity: true } } },
        take: BATCH_SIZE,
        orderBy: { createdAt: 'asc' },
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (batch.length === 0) break;

      // Ensure all memories have contentHash
      for (const memory of batch) {
        if (!memory.contentHash) {
          const hash = generateContentHash(memory.raw);
          await db.memory.update({
            where: { id: memory.id },
            data: { contentHash: hash },
          });
          (memory as any).contentHash = hash;
        }
      }

      try {
        const result = await this.syncBatchToCloud(
          batch,
          apiKey,
          instanceId,
          db,
        );
        syncedCount += result.synced;
        newCount += result.newCount;
        updatedCount += result.updatedCount;
        skippedCount += result.skippedCount;
        errorCount += result.errors;
        syncProgress.synced = syncedCount;
        if (result.synced > 0) {
          lastSyncedAt = new Date().toISOString();
        }
      } catch (error: any) {
        errorCount += batch.length;
        this.logger.warn(`Batch sync failed: ${error.message}`);
        // On 401/403, stop entirely
        if (error.message?.includes('invalid or expired')) {
          break;
        }
      }

      cursor = batch[batch.length - 1].id;

      if (batch.length === BATCH_SIZE) {
        await this.delay(BATCH_DELAY_MS);
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      syncedCount,
      newCount,
      updatedCount,
      skippedCount,
      errorCount,
      lastSyncedAt,
      durationMs,
    };
  }

  async syncBatchToCloud(
    memories: any[],
    apiKey: string,
    instanceId: string | null,
    db?: PrismaClient | PrismaService,
  ): Promise<{
    synced: number;
    errors: number;
    newCount: number;
    updatedCount: number;
    skippedCount: number;
  }> {
    const effectiveInstanceId = instanceId || 'unknown';

    const payload: SyncPushDto = {
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
        instanceId: effectiveInstanceId,
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
        entities: m.entities?.map((me: any) => ({
          name: me.entity.name,
          type: me.entity.type,
          normalizedName: me.entity.normalizedName,
        })),
      })),
      syncProtocolVersion: 2,
    };

    const response = await fetch(`${this.CLOUD_API_BASE}/v1/sync/push`, {
      method: 'POST',
      headers: {
        ...(apiKey.startsWith('esync_')
          ? { 'X-Sync-Key': apiKey }
          : { 'X-AM-API-Key': apiKey }),
        'X-Instance-Id': effectiveInstanceId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) {
        throw new Error('Cloud API key is invalid or expired');
      }
      if (response.status === 429) {
        throw new Error('Cloud API rate limit exceeded');
      }
      throw new Error(`Cloud API error ${response.status}: ${body}`);
    }

    const result: SyncPushResponse = await response.json();

    // Mark successfully synced memories
    let synced = 0;
    let errors = 0;
    let newCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    for (const item of result.results) {
      if (
        item.status === 'created' ||
        item.status === 'updated' ||
        item.status === 'skipped'
      ) {
        try {
          // Use the passed-in db client (not this.prisma) to avoid
          // stale RLS transaction proxy when running in background
          await (db ?? this.prisma).memory.update({
            where: { id: item.sourceMemoryId },
            data: { cloudSyncedAt: new Date() },
          });
        } catch (e: any) {
          this.logger.error(
            `Failed to mark ${item.sourceMemoryId} as synced: ${e.message}`,
          );
        }
        synced++;
        if (item.status === 'created') newCount++;
        else if (item.status === 'updated') updatedCount++;
        else skippedCount++;
      } else {
        errors++;
      }
    }

    return { synced, errors, newCount, updatedCount, skippedCount };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
