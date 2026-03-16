import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt, decrypt } from '../common/encryption.util';

interface CloudAuthResponse {
  id: string;
  email: string;
  plan: string;
  name?: string;
}

export interface CloudStatus {
  linked: boolean;
  plan?: string;
  email?: string;
  lastVerified?: string;
}

@Injectable()
export class CloudLinkAuthService {
  private readonly logger = new Logger(CloudLinkAuthService.name);
  readonly CLOUD_API_BASE = 'https://api.openengram.ai';
  private consecutiveAuthFailures = 0;
  private static readonly MAX_AUTH_FAILURES = 3;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates a cloud API key against the remote auth endpoint.
   * Throws BadRequestException if invalid.
   */
  async validateCloudApiKey(apiKey: string): Promise<CloudAuthResponse> {
    const response = await fetch(`${this.CLOUD_API_BASE}/v1/auth/me`, {
      headers: { 'X-AM-API-Key': apiKey },
    });

    if (!response.ok) {
      throw new BadRequestException('Invalid cloud API key');
    }

    const data = (await response.json()) as CloudAuthResponse;
    if (!data.id || !data.email) {
      throw new BadRequestException('Invalid response from cloud API');
    }

    return data;
  }

  /**
   * Creates a sync key on the cloud for push operations.
   * Returns the encrypted sync key, or null on failure (non-fatal).
   */
  async createSyncKey(apiKey: string): Promise<string | null> {
    try {
      const hostname = require('os').hostname();
      const syncKeyResponse = await fetch(
        `${this.CLOUD_API_BASE}/v1/account/sync-keys`,
        {
          method: 'POST',
          headers: {
            'X-AM-API-Key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ instanceName: hostname }),
        },
      );
      if (syncKeyResponse.ok) {
        const syncKeyData = (await syncKeyResponse.json()) as {
          syncKey?: string;
          key?: string;
        };
        const rawSyncKey = syncKeyData.syncKey || syncKeyData.key;
        if (rawSyncKey) {
          this.logger.log(`Created cloud sync key for instance ${hostname}`);
          return encrypt(rawSyncKey);
        }
      } else {
        this.logger.warn(
          `Failed to create cloud sync key: ${syncKeyResponse.status} ${await syncKeyResponse.text().catch(() => '')}`,
        );
      }
    } catch (error: any) {
      this.logger.warn(`Failed to create cloud sync key: ${error.message}`);
    }
    return null;
  }

  /**
   * Re-validates the cloud API key. Call on-demand or via cron.
   * Distinguishes network errors from auth errors:
   * - Network errors: log warning, keep the link intact
   * - Auth errors (401/403): only unlink after 3 consecutive failures
   */
  async refreshSubscription(accountId: string): Promise<CloudStatus> {
    const link = await this.prisma.cloudLink.findUnique({
      where: { accountId },
    });

    if (!link) {
      return { linked: false };
    }

    const apiKey = decrypt(link.cloudApiKey);

    let response: Response;
    try {
      response = await fetch(`${this.CLOUD_API_BASE}/v1/auth/me`, {
        headers: { 'X-AM-API-Key': apiKey },
      });
    } catch (error: any) {
      // Network error / timeout — do NOT delete the link
      this.logger.warn(
        `Cloud API network error for account ${accountId}: ${error.message}. Keeping link intact.`,
      );
      return {
        linked: true,
        plan: link.cloudPlan ?? undefined,
        email: link.cloudEmail ?? undefined,
        lastVerified: link.lastVerifiedAt?.toISOString(),
      };
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.consecutiveAuthFailures++;
        this.logger.warn(
          `Cloud API auth failure ${this.consecutiveAuthFailures}/${CloudLinkAuthService.MAX_AUTH_FAILURES} for account ${accountId}`,
        );

        if (
          this.consecutiveAuthFailures >= CloudLinkAuthService.MAX_AUTH_FAILURES
        ) {
          this.logger.warn(
            `Unlinking cloud for account ${accountId} after ${CloudLinkAuthService.MAX_AUTH_FAILURES} consecutive auth failures`,
          );
          this.consecutiveAuthFailures = 0;
          await this.prisma.cloudLink.delete({ where: { accountId } });
          return { linked: false };
        }

        // Not enough failures yet — keep the link
        return {
          linked: true,
          plan: link.cloudPlan ?? undefined,
          email: link.cloudEmail ?? undefined,
          lastVerified: link.lastVerifiedAt?.toISOString(),
        };
      }

      // Other HTTP errors (500, 502, etc.) — treat like network issues
      this.logger.warn(
        `Cloud API returned ${response.status} for account ${accountId}. Keeping link intact.`,
      );
      return {
        linked: true,
        plan: link.cloudPlan ?? undefined,
        email: link.cloudEmail ?? undefined,
        lastVerified: link.lastVerifiedAt?.toISOString(),
      };
    }

    // Success — reset failure counter
    this.consecutiveAuthFailures = 0;

    const cloudUser = (await response.json()) as CloudAuthResponse;
    if (!cloudUser.id || !cloudUser.email) {
      this.logger.warn(
        `Invalid response from cloud API for account ${accountId}`,
      );
      return {
        linked: true,
        plan: link.cloudPlan ?? undefined,
        email: link.cloudEmail ?? undefined,
        lastVerified: link.lastVerifiedAt?.toISOString(),
      };
    }

    await this.prisma.cloudLink.update({
      where: { accountId },
      data: {
        cloudPlan: cloudUser.plan,
        cloudEmail: cloudUser.email,
        cloudAccountId: cloudUser.id,
        lastVerifiedAt: new Date(),
      },
    });

    return {
      linked: true,
      plan: cloudUser.plan,
      email: cloudUser.email,
      lastVerified: new Date().toISOString(),
    };
  }

  /**
   * Health check: verifies stored encrypted credentials still work
   * against the cloud API.
   */
  async healthCheck(accountId: string): Promise<{
    healthy: boolean;
    linked: boolean;
    credentialsValid: boolean;
    syncKeyValid: boolean;
    cloudReachable: boolean;
    details: string;
  }> {
    const link = await this.prisma.cloudLink.findUnique({
      where: { accountId },
    });

    if (!link) {
      return {
        healthy: false,
        linked: false,
        credentialsValid: false,
        syncKeyValid: false,
        cloudReachable: false,
        details: 'No cloud link found for this account',
      };
    }

    // Test API key decryption
    let apiKey: string;
    try {
      apiKey = decrypt(link.cloudApiKey);
    } catch (err: any) {
      this.logger.error(
        `Cloud link health check: failed to decrypt cloudApiKey for account ${accountId}: ${err.message}`,
      );
      return {
        healthy: false,
        linked: true,
        credentialsValid: false,
        syncKeyValid: false,
        cloudReachable: false,
        details: `Failed to decrypt cloudApiKey: ${err.message}. Re-link may be required.`,
      };
    }

    // Test sync key decryption (if present)
    let syncKeyValid = true;
    if (link.cloudSyncKey) {
      try {
        decrypt(link.cloudSyncKey);
      } catch (err: any) {
        this.logger.error(
          `Cloud link health check: failed to decrypt cloudSyncKey for account ${accountId}: ${err.message}`,
        );
        syncKeyValid = false;
      }
    }

    // Test cloud API reachability and credential validity
    let cloudReachable = false;
    let credentialsValid = false;
    try {
      const response = await fetch(`${this.CLOUD_API_BASE}/v1/auth/me`, {
        headers: { 'X-AM-API-Key': apiKey },
        signal: AbortSignal.timeout(10000),
      });
      cloudReachable = true;
      if (response.ok) {
        credentialsValid = true;
      } else {
        this.logger.warn(
          `Cloud link health check: API returned ${response.status} for account ${accountId}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Cloud link health check: cloud API unreachable for account ${accountId}: ${err.message}`,
      );
    }

    const healthy = credentialsValid && syncKeyValid && cloudReachable;
    const details = healthy
      ? 'All checks passed — cloud link is healthy'
      : [
          !cloudReachable && 'Cloud API unreachable',
          !credentialsValid && cloudReachable && 'API key rejected by cloud',
          !syncKeyValid && 'Sync key decryption failed',
        ]
          .filter(Boolean)
          .join('; ');

    return {
      healthy,
      linked: true,
      credentialsValid,
      syncKeyValid,
      cloudReachable,
      details,
    };
  }
}
