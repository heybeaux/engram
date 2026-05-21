import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiKeyGuard } from './api-key.guard';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

/**
 * Combined guard: accepts EITHER a valid API key (X-AM-API-Key)
 * OR a valid JWT Bearer token. Tries API key first, falls back to JWT.
 *
 * When JWT is used, resolves the account's first agent and sets
 * request.agent so the @Agent() decorator works.
 *
 * User resolution is always account-scoped (not agent-scoped):
 *   - X-AM-User-ID header → findOrCreate({ accountId, externalId })
 *   - No header           → findFirst({ accountId, isDefault: true }) || create default
 */
@Injectable()
export class ApiKeyOrJwtGuard implements CanActivate {
  private readonly apiKeyGuard: ApiKeyGuard;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.apiKeyGuard = new ApiKeyGuard(prisma, config);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // If API key header is present, check for instance key first
    if (request.headers['x-am-api-key']) {
      const apiKey = request.headers['x-am-api-key'];

      // Instance API keys: eng_inst_ prefix → validate as account-level key
      if (typeof apiKey === 'string' && apiKey.startsWith('eng_inst_')) {
        const keyHash = createHash('sha256').update(apiKey).digest('hex');
        const instanceKey = await this.prisma.instanceApiKey.findUnique({
          where: { keyHash },
          include: { account: true },
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

        // Resolve user — account-scoped (not agent-scoped)
        const externalUserId = request.headers['x-am-user-id'] as
          | string
          | undefined;
        const user = await this.findOrCreateUser(
          instanceKey.accountId,
          externalUserId ?? null,
        );
        request.user = user;
        return true;
      }

      // Regular agent API key — delegate to ApiKeyGuard
      return this.apiKeyGuard.canActivate(context);
    }

    // LAN bypass: allow local requests without credentials when TRUST_LOCAL_NETWORK=true
    // Only enabled for local edition (not cloud/prod deployments)
    // NEVER allowed in production (NODE_ENV=production) — HEY-205
    const nodeEnv = this.config.get<string>('NODE_ENV', 'development');
    const edition = this.config.get<string>('EDITION', 'local');
    const lanBypassEnv = this.config.get<string>('LAN_BYPASS', '');
    const isLocalEdition = edition === 'local' || lanBypassEnv === 'true';
    const trustLocal =
      this.config.get<string>('TRUST_LOCAL_NETWORK', 'false') === 'true';
    if (
      nodeEnv !== 'production' &&
      isLocalEdition &&
      trustLocal &&
      this.isLocalIp(request)
    ) {
      // LAN bypass: use header if provided, otherwise default to first user
      const externalUserId = request.headers['x-am-user-id'] as
        | string
        | undefined;
      const internalUserId = request.headers['x-user-id'] as string | undefined;

      const agent = await this.prisma.agent.findFirst({
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });

      if (agent && agent.accountId) {
        let user: any = null;

        // If internal user ID provided, look up directly
        if (internalUserId) {
          user = await this.prisma.user.findUnique({
            where: { id: internalUserId },
          });
        }

        // Fall back to external ID → account-scoped lookup
        if (!user && externalUserId) {
          user = await this.findOrCreateUser(agent.accountId, externalUserId);
        }

        // No user ID headers at all — default to isDefault user for this account
        if (!user && !externalUserId && !internalUserId) {
          user = await this.findOrCreateUser(agent.accountId, null);
        }

        request.agent = agent;
        request.user = user;
        request.accountId = agent.accountId;
        request.isLanBypass = true;
      } else {
        request.agent = null;
        request.user = null;
        request.isLanBypass = true;
      }
      return true;
    }

    // Try JWT Bearer token
    const authHeader = request.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      let payload: any;
      try {
        payload = this.jwt.verify(token);
      } catch {
        throw new UnauthorizedException('Invalid or expired token');
      }

      const accountId = payload.sub;
      if (!accountId) {
        throw new UnauthorizedException('Invalid token payload');
      }

      request.accountId = accountId;

      // Resolve the account's first active agent for @Agent() decorator
      const agent = await this.prisma.agent.findFirst({
        where: { accountId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });

      if (!agent) {
        throw new UnauthorizedException('No agent found for this account');
      }

      request.agent = agent;

      // Resolve or create a user scoped to the account (not the agent)
      // X-AM-User-ID > JWT email > accountId as fallback externalId
      const externalUserId =
        (request.headers['x-am-user-id'] as string | undefined) ||
        payload.email ||
        accountId;
      const user = await this.findOrCreateUser(accountId, externalUserId);
      request.user = user;

      return true;
    }

    throw new UnauthorizedException(
      'Missing authentication: provide X-AM-API-Key or Authorization Bearer token',
    );
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
      let user = await this.prisma.user.findUnique({
        where: {
          accountId_externalId: { accountId, externalId: normalizedId },
        },
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
}
