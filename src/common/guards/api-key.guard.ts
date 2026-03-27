import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { createHash } from 'crypto';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // LAN bypass: IP-only check, no spoofable headers.
    // Disabled by default in production (TRUST_LOCAL_NETWORK=false).
    // NEVER allowed when NODE_ENV=production.
    const nodeEnv = this.config.get<string>('NODE_ENV', 'development');
    const trustLocal =
      this.config.get<string>('TRUST_LOCAL_NETWORK', 'false') === 'true';

    if (nodeEnv !== 'production' && trustLocal && this.isLocalIp(request)) {
      // LAN access — try to resolve agent context if key provided
      const localApiKey = request.headers['x-am-api-key'];
      const localUserId = request.headers['x-am-user-id'];
      if (localApiKey) {
        try {
          const localApiKeyHash = this.hashApiKey(localApiKey);
          const agent = await this.prisma.agent.findUnique({
            where: { apiKeyHash: localApiKeyHash },
          });
          if (agent && !agent.deletedAt && agent.accountId) {
            const user = await this.findOrCreateUser(
              agent.accountId,
              localUserId || null,
            );
            if (!user?.deletedAt) {
              request.agent = agent;
              request.user = user;
              request.accountId = agent.accountId;
            }
          }
        } catch (err) {
          this.logger.warn('LAN auth context resolution failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!request.agent) {
        // No agent context resolved from headers — resolve default account
        // so downstream services (e.g. cloud sync) have accountId available
        try {
          const defaultAccount = await this.prisma.account.findFirst({
            orderBy: { createdAt: 'asc' },
          });
          if (defaultAccount) {
            request.accountId = defaultAccount.id;
            this.logger.debug(
              `LAN request: resolved default account ${defaultAccount.id}`,
            );

            // Also try to resolve default agent and user for this account
            const defaultAgent = await this.prisma.agent.findFirst({
              where: { accountId: defaultAccount.id, deletedAt: null },
              orderBy: { createdAt: 'asc' },
            });
            if (defaultAgent) {
              request.agent = defaultAgent;
              const defaultUser = await this.prisma.user.findFirst({
                where: {
                  accountId: defaultAccount.id,
                  isDefault: true,
                  deletedAt: null,
                },
                orderBy: { createdAt: 'asc' },
              });
              if (defaultUser) {
                request.user = defaultUser;
                request.userId = defaultUser.id;
              } else {
                // Fall back to any user for this account
                const anyUser = await this.prisma.user.findFirst({
                  where: { accountId: defaultAccount.id, deletedAt: null },
                  orderBy: { createdAt: 'asc' },
                });
                request.user = anyUser ?? null;
                if (anyUser) request.userId = anyUser.id;
              }
            } else {
              request.agent = null;
              request.user = null;
            }
          } else {
            this.logger.warn(
              'LAN request: no accounts found in database — accountId will be undefined',
            );
            request.agent = null;
            request.user = null;
          }
        } catch (err) {
          this.logger.warn('LAN auth: failed to resolve default account', {
            error: err instanceof Error ? err.message : String(err),
          });
          request.agent = null;
          request.user = null;
        }
      }
      return true;
    }

    // Remote access — require API key
    const apiKey = request.headers['x-am-api-key'];

    // Instance API keys: eng_inst_ prefix → validate as account-level key
    if (typeof apiKey === 'string' && apiKey.startsWith('eng_inst_')) {
      const keyHash = this.hashApiKey(apiKey);
      const instanceKey = await this.prisma.instanceApiKey.findUnique({
        where: { keyHash },
      });
      if (!instanceKey || instanceKey.deletedAt) {
        throw new UnauthorizedException('Invalid instance API key');
      }
      if (instanceKey.expiresAt && instanceKey.expiresAt < new Date()) {
        throw new UnauthorizedException('Instance API key has expired');
      }
      // Update lastUsedAt (best-effort)
      this.prisma.instanceApiKey
        .update({
          where: { id: instanceKey.id },
          data: { lastUsedAt: new Date() },
        })
        .catch(() => {});

      request.accountId = instanceKey.accountId;
      request.isInstanceKey = true;
      request.instanceKeyScopes = instanceKey.scopes;
      // Resolve default agent for controllers that need @Agent()
      const defaultAgent = await this.prisma.agent.findFirst({
        where: { accountId: instanceKey.accountId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      request.agent = defaultAgent;
      // Resolve default user for controllers that need @UserId()
      const defaultUser = await this.prisma.user.findFirst({
        where: { accountId: instanceKey.accountId, isDefault: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      if (defaultUser) {
        request.user = defaultUser;
        request.userId = defaultUser.id;
      } else {
        const createdUser = await this.prisma.user.create({
          data: { accountId: instanceKey.accountId, externalId: 'default', isDefault: true },
        });
        request.user = createdUser;
        request.userId = createdUser.id;
      }
      return true;
    }

    const externalId = request.headers['x-am-user-id'] as string | undefined;

    if (!apiKey) {
      throw new UnauthorizedException('Missing X-AM-API-Key header');
    }

    // Hash the API key for lookup
    const apiKeyHash = this.hashApiKey(apiKey);

    // Validate agent exists (Key → Agent → agent.accountId)
    const agent = await this.prisma.agent.findUnique({
      where: { apiKeyHash },
    });

    if (!agent || agent.deletedAt) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (!agent.accountId) {
      throw new UnauthorizedException('Agent has no associated account');
    }

    // Find or create user scoped to the account, not the agent
    const user = await this.findOrCreateUser(
      agent.accountId,
      externalId ?? null,
    );

    if (user.deletedAt) {
      throw new UnauthorizedException('User has been deleted');
    }

    // Attach to request for use in controllers
    // Memory writes MUST use request.agent.id for agentId (server-authoritative)
    request.agent = agent;
    request.user = user;
    request.accountId = agent.accountId;

    return true;
  }

  /**
   * Find or create a User scoped to an account.
   *
   * - If externalId provided: findOrCreate({ accountId, externalId })
   * - If no externalId:       findFirst({ accountId, isDefault: true }) || create default
   */
  private async findOrCreateUser(accountId: string, externalId: string | null) {
    if (externalId) {
      // ENG-109: Normalize to lowercase for case-insensitive matching
      const normalizedId = externalId.toLowerCase();
      // Attempt findUnique first (happy path)
      let user = await this.prisma.user.findUnique({
        where: { accountId_externalId: { accountId, externalId: normalizedId } },
      });
      if (!user) {
        user = await this.prisma.user.create({
          data: { accountId, externalId: normalizedId },
        });
      }
      return user;
    }

    // No externalId — use/create the isDefault user for this account
    let user = await this.prisma.user.findFirst({
      where: { accountId, isDefault: true, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (!user) {
      user = await this.prisma.user.create({
        data: { accountId, externalId: 'default', isDefault: true },
      });
    }
    return user;
  }

  /**
   * Check if request originates from a local/LAN IP.
   * Only uses the socket IP — never trusts spoofable headers like Host/Origin.
   * Behind a reverse proxy, set TRUST_LOCAL_NETWORK=false and use API keys.
   */
  private isLocalIp(request: any): boolean {
    const ip = request.ip || request.connection?.remoteAddress || '';
    return (
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip === '::ffff:127.0.0.1' ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      ip.startsWith('::ffff:10.') ||
      ip.startsWith('::ffff:192.168.') ||
      this.isIn172PrivateRange(ip)
    );
  }

  private isIn172PrivateRange(ip: string): boolean {
    const raw = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (!raw.startsWith('172.')) return false;
    const second = parseInt(raw.split('.')[1], 10);
    return second >= 16 && second <= 31;
  }

  private hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }
}
