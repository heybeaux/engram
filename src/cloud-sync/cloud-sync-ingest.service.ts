import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  SyncPushDto,
  SyncPushResponse,
  SyncPushResultItem,
} from './dto/sync-push.dto';
import { randomUUID, createHash } from 'crypto';
import { MemorySource } from '@prisma/client';
import {
  TEMPORAL_WARNING_HISTORICAL_WITHOUT_ANCHOR,
  TemporalWarning,
} from '../memory/memory.types';

/**
 * Cloud-side: Handles incoming sync push from local instances,
 * agent/user mapping, sync ID mapping, and instance tracking.
 */
@Injectable()
export class CloudSyncIngestService {
  private readonly logger = new Logger(CloudSyncIngestService.name);

  constructor(private readonly prisma: PrismaService) {}

  // =========================================================================
  // Cloud-side: Handle incoming sync push from local instances
  // =========================================================================

  async handleSyncPush(
    accountId: string,
    instanceId: string,
    dto: SyncPushDto,
  ): Promise<SyncPushResponse> {
    const results: SyncPushResultItem[] = [];

    for (const memPayload of dto.memories) {
      try {
        // Each memory is processed in its own transaction to prevent
        // PostgreSQL 25P02 cascade — one failure must not kill the batch.
        const result = await this.prisma.$transaction(async (tx) => {
          // 1. Resolve cloud agent via SyncAgentMap
          const cloudAgentId = await this.resolveCloudAgentTx(
            tx,
            accountId,
            instanceId,
            memPayload.localAgentId || 'default',
            memPayload.agentName || 'Default Agent',
          );

          // 2. Resolve cloud user via SyncUserMap
          const cloudUserId = await this.resolveCloudUserTx(
            tx,
            instanceId,
            cloudAgentId,
            memPayload.localUserId || 'default',
            memPayload.userExternalId || 'default',
          );

          // 3. Check contentHash dedup — skip if already exists
          if (memPayload.contentHash) {
            const existing = await tx.memory.findFirst({
              where: {
                userId: cloudUserId,
                contentHash: memPayload.contentHash,
                deletedAt: null,
              },
              select: { id: true },
            });

            if (existing) {
              await this.upsertSyncIdMapTx(
                tx,
                instanceId,
                memPayload.localId,
                existing.id,
                memPayload.contentHash,
              );
              return {
                sourceMemoryId: memPayload.localId,
                cloudMemoryId: existing.id,
                status: 'skipped' as const,
              };
            }
          }

          // 4. Check SyncIdMap — already synced this localId?
          const existingMap = await tx.syncIdMap.findUnique({
            where: {
              instanceId_localMemoryId: {
                instanceId,
                localMemoryId: memPayload.localId,
              },
            },
          });

          if (existingMap) {
            if (
              memPayload.contentHash &&
              existingMap.contentHash !== memPayload.contentHash
            ) {
              await tx.memory
                .update({
                  where: { id: existingMap.cloudMemoryId },
                  data: {
                    raw: memPayload.raw,
                    contentHash: memPayload.contentHash,
                    memoryType: (memPayload.memoryType as any) || undefined,
                    effectiveScore: memPayload.effectiveScore ?? undefined,
                    priority: memPayload.priority ?? undefined,
                  },
                })
                .catch(() => {});
              await this.upsertSyncIdMapTx(
                tx,
                instanceId,
                memPayload.localId,
                existingMap.cloudMemoryId,
                memPayload.contentHash,
              );
              return {
                sourceMemoryId: memPayload.localId,
                cloudMemoryId: existingMap.cloudMemoryId,
                status: 'updated' as const,
              };
            } else {
              return {
                sourceMemoryId: memPayload.localId,
                cloudMemoryId: existingMap.cloudMemoryId,
                status: 'skipped' as const,
              };
            }
          }

          // 5. Create the memory with correct cloud agentId/userId
          const memory = await tx.memory.create({
            data: {
              userId: cloudUserId,
              raw: memPayload.raw,
              layer: memPayload.layer as any,
              source: (memPayload.source as any) || 'EXPLICIT_STATEMENT',
              memoryType: (memPayload.memoryType as any) || undefined,
              importanceHint: (memPayload.importanceHint as any) || undefined,
              importanceScore: memPayload.importanceScore ?? 0.5,
              effectiveScore: memPayload.effectiveScore ?? 0.5,
              priority: memPayload.priority ?? 3,
              contentHash: memPayload.contentHash,
              createdAt: memPayload.createdAt
                ? new Date(memPayload.createdAt)
                : undefined,
            },
          });

          // 6. Create extraction if provided
          if (memPayload.extraction) {
            const ext = memPayload.extraction;
            await tx.memoryExtraction.create({
              data: {
                memoryId: memory.id,
                who: ext.who,
                what: ext.what,
                when: ext.when ? new Date(ext.when) : undefined,
                whereCtx: ext.whereCtx,
                why: ext.why,
                how: ext.how,
                topics: ext.topics ?? [],
              },
            });
          }

          // 7. Create SyncIdMap entry
          await this.upsertSyncIdMapTx(
            tx,
            instanceId,
            memPayload.localId,
            memory.id,
            memPayload.contentHash,
          );

          // T6: emit per-item warning when synced memory is HISTORICAL-without-anchor.
          const isHistoricalWithoutAnchor =
            (memPayload.source as MemorySource) === MemorySource.HISTORICAL &&
            !memPayload.observedAt;
          const warnings: TemporalWarning[] | undefined =
            isHistoricalWithoutAnchor
              ? [
                  {
                    ...TEMPORAL_WARNING_HISTORICAL_WITHOUT_ANCHOR,
                    memoryId: memory.id,
                  },
                ]
              : undefined;

          return {
            sourceMemoryId: memPayload.localId,
            cloudMemoryId: memory.id,
            status: 'created' as const,
            ...(warnings && { warnings }),
          };
        });

        results.push(result);
      } catch (error: any) {
        this.logger.warn(
          `Failed to ingest synced memory ${memPayload.localId}: ${error.message}`,
        );
        results.push({
          sourceMemoryId: memPayload.localId,
          status: 'failed',
          error: error.message,
        });
      }
    }

    // Track this instance
    const createdCount = results.filter((r) => r.status === 'created').length;
    await this.updateCloudInstance(
      accountId,
      instanceId,
      undefined,
      createdCount,
    ).catch((err) => {
      this.logger.warn(`Failed to update cloud instance: ${err.message}`);
    });

    return { results };
  }

  // =========================================================================
  // Agent/User mapping for sync attribution preservation
  // =========================================================================

  // Transaction-aware versions for use inside $transaction blocks
  private async resolveCloudAgentTx(
    tx: any,
    accountId: string,
    instanceId: string,
    localAgentId: string,
    agentName: string,
  ): Promise<string> {
    const existing = await tx.syncAgentMap.findUnique({
      where: {
        instanceId_localAgentId: { instanceId, localAgentId },
      },
    });
    if (existing) return existing.cloudAgentId;

    const byName = await tx.syncAgentMap.findUnique({
      where: {
        instanceId_agentName: { instanceId, agentName },
      },
    });
    if (byName) {
      await tx.syncAgentMap
        .create({
          data: {
            instanceId,
            localAgentId,
            cloudAgentId: byName.cloudAgentId,
            agentName,
          },
        })
        .catch(() => {});
      return byName.cloudAgentId;
    }

    const rawKey = `eng_sync_${randomUUID().replace(/-/g, '')}`;
    const apiKeyHash = createHash('sha256').update(rawKey).digest('hex');
    const apiKeyHint = `sync_${agentName.slice(0, 12)}`;

    const agent = await tx.agent.create({
      data: {
        name: agentName,
        apiKeyHash,
        apiKeyHint,
        accountId,
      },
    });

    await tx.syncAgentMap.create({
      data: {
        instanceId,
        localAgentId,
        cloudAgentId: agent.id,
        agentName,
      },
    });

    return agent.id;
  }

  private async resolveCloudUserTx(
    tx: any,
    instanceId: string,
    cloudAgentId: string,
    localUserId: string,
    externalId: string,
  ): Promise<string> {
    const existing = await tx.syncUserMap.findUnique({
      where: {
        instanceId_localUserId: { instanceId, localUserId },
      },
    });
    if (existing) return existing.cloudUserId;

    // Resolve accountId from agent for the accountId_externalId unique lookup
    const agentForUser = await tx.agent.findUnique({
      where: { id: cloudAgentId },
      select: { accountId: true },
    });
    const accountId = agentForUser?.accountId;

    let user = accountId
      ? await tx.user.findUnique({
          where: {
            accountId_externalId: { accountId, externalId },
          },
        })
      : null;

    if (!user) {
      user = await tx.user.create({
        data: { accountId, externalId },
      });
    }

    await tx.syncUserMap.create({
      data: {
        instanceId,
        localUserId,
        cloudUserId: user.id,
        externalId,
      },
    });

    return user.id;
  }

  // Legacy non-tx versions (kept for any non-batch callers)
  private async resolveCloudAgent(
    accountId: string,
    instanceId: string,
    localAgentId: string,
    agentName: string,
  ): Promise<string> {
    return this.resolveCloudAgentTx(
      this.prisma,
      accountId,
      instanceId,
      localAgentId,
      agentName,
    );
  }

  private async resolveCloudUser(
    instanceId: string,
    cloudAgentId: string,
    localUserId: string,
    externalId: string,
  ): Promise<string> {
    return this.resolveCloudUserTx(
      this.prisma,
      instanceId,
      cloudAgentId,
      localUserId,
      externalId,
    );
  }

  // =========================================================================
  // Sync ID mapping
  // =========================================================================

  private async upsertSyncIdMapTx(
    tx: any,
    instanceId: string,
    localMemoryId: string,
    cloudMemoryId: string,
    contentHash?: string,
  ): Promise<void> {
    try {
      await tx.syncIdMap.upsert({
        where: {
          instanceId_localMemoryId: { instanceId, localMemoryId },
        },
        create: {
          instanceId,
          localMemoryId,
          cloudMemoryId,
          contentHash: contentHash ?? null,
        },
        update: {
          cloudMemoryId,
          contentHash: contentHash ?? undefined,
          syncedAt: new Date(),
        },
      });
    } catch (e: any) {
      if (e.code === 'P2002') {
        this.logger.debug(
          `SyncIdMap constraint conflict for local=${localMemoryId} cloud=${cloudMemoryId}, updating existing entry`,
        );
        await tx.syncIdMap
          .updateMany({
            where: { instanceId, cloudMemoryId },
            data: {
              localMemoryId,
              contentHash: contentHash ?? undefined,
              syncedAt: new Date(),
            },
          })
          .catch(() => {});
      } else {
        throw e;
      }
    }
  }

  async upsertSyncIdMap(
    instanceId: string,
    localMemoryId: string,
    cloudMemoryId: string,
    contentHash?: string,
  ): Promise<void> {
    try {
      await this.prisma.syncIdMap.upsert({
        where: {
          instanceId_localMemoryId: { instanceId, localMemoryId },
        },
        create: {
          instanceId,
          localMemoryId,
          cloudMemoryId,
          contentHash: contentHash ?? null,
        },
        update: {
          cloudMemoryId,
          contentHash: contentHash ?? undefined,
          syncedAt: new Date(),
        },
      });
    } catch (e: any) {
      if (e.code === 'P2002') {
        this.logger.debug(
          `SyncIdMap constraint conflict for local=${localMemoryId} cloud=${cloudMemoryId}, updating existing entry`,
        );
        await this.prisma.syncIdMap
          .updateMany({
            where: { instanceId, cloudMemoryId },
            data: {
              localMemoryId,
              contentHash: contentHash ?? undefined,
              syncedAt: new Date(),
            },
          })
          .catch(() => {});
      } else {
        throw e;
      }
    }
  }

  // =========================================================================
  // Cloud-side: Instance tracking
  // =========================================================================

  async updateCloudInstance(
    accountId: string,
    instanceId: string,
    instanceName: string | undefined,
    pushCount: number,
  ): Promise<void> {
    const memoryCount = await this.prisma.syncIdMap.count({
      where: { instanceId },
    });

    await this.prisma.cloudInstance.upsert({
      where: {
        accountId_instanceId: { accountId, instanceId },
      },
      create: {
        accountId,
        instanceId,
        instanceName: instanceName ?? null,
        lastSyncAt: new Date(),
        memoryCount,
        lastPushCount: pushCount,
        status: 'active',
      },
      update: {
        instanceName: instanceName ?? undefined,
        lastSyncAt: new Date(),
        memoryCount,
        lastPushCount: pushCount,
        status: 'active',
      },
    });
  }

  async getInstances(accountId: string) {
    return this.prisma.cloudInstance.findMany({
      where: { accountId },
      orderBy: { lastSyncAt: 'desc' },
    });
  }
}
