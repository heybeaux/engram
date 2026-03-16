import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt } from '../common/encryption.util';
import { randomUUID } from 'crypto';
import { CloudLinkAuthService, CloudStatus } from './cloud-link-auth.service';
import { CloudLinkMappingService } from './cloud-link-mapping.service';

// Re-export for backward compatibility with other modules
export type { CloudStatus } from './cloud-link-auth.service';

@Injectable()
export class CloudLinkService {
  private readonly logger = new Logger(CloudLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: CloudLinkAuthService,
    private readonly mappingService: CloudLinkMappingService,
  ) {}

  async linkCloud(
    accountId: string,
    apiKey: string,
    options?: {
      localAgentId?: string;
      cloudAgentId?: string;
      localUserId?: string;
      cloudUserId?: string;
      userExternalId?: string;
    },
  ): Promise<CloudStatus & { reconciliationPreview?: any }> {
    // Validate the API key against cloud
    const cloudUser = await this.authService.validateCloudApiKey(apiKey);

    // Encrypt the instance API key (used for auth/refresh)
    const encryptedKey = encrypt(apiKey);

    // Upsert the cloud link (generate instanceId on first link)
    const existing = await this.prisma.cloudLink.findUnique({
      where: { accountId },
      select: { instanceId: true },
    });
    const instanceId = existing?.instanceId ?? randomUUID();

    // Create an instance sync key on the cloud for push operations
    const encryptedSyncKey = await this.authService.createSyncKey(apiKey);

    await this.prisma.cloudLink.upsert({
      where: { accountId },
      create: {
        accountId,
        cloudApiKey: encryptedKey,
        cloudSyncKey: encryptedSyncKey,
        cloudAccountId: cloudUser.id,
        cloudEmail: cloudUser.email,
        cloudPlan: cloudUser.plan,
        instanceId,
        lastVerifiedAt: new Date(),
      },
      update: {
        cloudApiKey: encryptedKey,
        cloudSyncKey: encryptedSyncKey,
        cloudAccountId: cloudUser.id,
        cloudEmail: cloudUser.email,
        cloudPlan: cloudUser.plan,
        instanceId,
        lastVerifiedAt: new Date(),
      },
    });

    // Create agent/user identity mappings if provided
    if (options?.localAgentId && options?.cloudAgentId) {
      await this.mappingService.createAgentMapping(
        instanceId,
        options.localAgentId,
        options.cloudAgentId,
      );
    }
    if (options?.localUserId && options?.cloudUserId) {
      await this.mappingService.createUserMapping(
        instanceId,
        options.localUserId,
        options.cloudUserId,
        options.userExternalId || 'default',
      );
    }

    // Detect if both sides have existing data
    const localMemoryCount = await this.prisma.memory.count({
      where: { deletedAt: null },
    });

    let reconciliationPreview: any = undefined;
    if (localMemoryCount > 0) {
      // Check cloud side for existing data
      try {
        const cloudCheckResponse = await fetch(
          `${this.authService.CLOUD_API_BASE}/v1/sync/pull?since=${new Date(0).toISOString()}&limit=1`,
          {
            headers: {
              'X-AM-API-Key': apiKey,
              'X-Instance-Id': instanceId,
            },
          },
        );
        if (cloudCheckResponse.ok) {
          const cloudData = (await cloudCheckResponse.json()) as {
            memories: any[];
            hasMore: boolean;
          };
          const cloudHasData =
            cloudData.memories.length > 0 || cloudData.hasMore;
          if (cloudHasData) {
            reconciliationPreview = {
              bothSidesHaveData: true,
              localMemoryCount,
              message:
                'Both local and cloud have existing memories. Use POST /v1/cloud/reconcile/preview to see what would be synced, then POST /v1/cloud/reconcile/execute to perform bidirectional sync.',
            };
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `Could not check cloud data during link: ${err.message}`,
        );
      }
    }

    return {
      linked: true,
      plan: cloudUser.plan,
      email: cloudUser.email,
      lastVerified: new Date().toISOString(),
      ...(reconciliationPreview ? { reconciliationPreview } : {}),
    };
  }

  async unlinkCloud(accountId: string): Promise<void> {
    const existing = await this.prisma.cloudLink.findUnique({
      where: { accountId },
    });
    if (!existing) {
      throw new NotFoundException('No cloud link found');
    }
    await this.prisma.cloudLink.delete({ where: { accountId } });
  }

  async getStatus(accountId: string): Promise<CloudStatus> {
    const link = await this.prisma.cloudLink.findUnique({
      where: { accountId },
    });

    if (!link) {
      return { linked: false };
    }

    return {
      linked: true,
      plan: link.cloudPlan ?? undefined,
      email: link.cloudEmail ?? undefined,
      lastVerified: link.lastVerifiedAt?.toISOString(),
    };
  }

  async isAccountLinked(accountId: string): Promise<boolean> {
    const link = await this.prisma.cloudLink.findUnique({
      where: { accountId },
      select: { id: true },
    });
    return !!link;
  }

  /**
   * Delegates to CloudLinkAuthService.
   * Re-validates the cloud API key. Call on-demand or via cron.
   */
  async refreshSubscription(accountId: string): Promise<CloudStatus> {
    return this.authService.refreshSubscription(accountId);
  }

  /**
   * Delegates to CloudLinkAuthService.
   * Health check: verifies stored encrypted credentials still work.
   */
  async healthCheck(accountId: string): Promise<{
    healthy: boolean;
    linked: boolean;
    credentialsValid: boolean;
    syncKeyValid: boolean;
    cloudReachable: boolean;
    details: string;
  }> {
    return this.authService.healthCheck(accountId);
  }

  /**
   * Delegates to CloudLinkMappingService.
   * Create a SyncAgentMap entry mapping local agent ID to cloud agent ID.
   */
  async createAgentMapping(
    instanceId: string,
    localAgentId: string,
    cloudAgentId: string,
  ): Promise<void> {
    return this.mappingService.createAgentMapping(
      instanceId,
      localAgentId,
      cloudAgentId,
    );
  }

  /**
   * Delegates to CloudLinkMappingService.
   * Create a SyncUserMap entry mapping local user ID to cloud user ID.
   */
  async createUserMapping(
    instanceId: string,
    localUserId: string,
    cloudUserId: string,
    externalId: string,
  ): Promise<void> {
    return this.mappingService.createUserMapping(
      instanceId,
      localUserId,
      cloudUserId,
      externalId,
    );
  }
}
