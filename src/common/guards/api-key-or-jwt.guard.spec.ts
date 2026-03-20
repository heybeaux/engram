import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ApiKeyOrJwtGuard } from './api-key-or-jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { createHash } from 'crypto';

// --- Mocks ---

const mockPrisma = {
  instanceApiKey: {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
  agent: { findFirst: jest.fn(), findUnique: jest.fn() },
  user: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
};

const mockJwt = {
  verify: jest.fn(),
};

const defaultConfig: Record<string, string> = {
  EDITION: 'cloud',
  TRUST_LOCAL_NETWORK: 'false',
  LAN_BYPASS: '',
};

const mockConfig = {
  get: jest.fn((key: string, def?: any) => defaultConfig[key] ?? def),
};

function createMockContext(overrides: {
  headers?: Record<string, string>;
  ip?: string;
}): { ctx: ExecutionContext; request: any } {
  const request = {
    headers: overrides.headers || {},
    ip: overrides.ip || '203.0.113.1',
    connection: { remoteAddress: overrides.ip || '203.0.113.1' },
  };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('ApiKeyOrJwtGuard', () => {
  let guard: ApiKeyOrJwtGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    defaultConfig.EDITION = 'cloud';
    defaultConfig.TRUST_LOCAL_NETWORK = 'false';
    defaultConfig.LAN_BYPASS = '';

    guard = new ApiKeyOrJwtGuard(
      mockJwt as unknown as JwtService,
      mockPrisma as unknown as PrismaService,
      mockConfig as unknown as ConfigService,
    );
  });

  // =========================================================================
  // No credentials
  // =========================================================================

  it('should throw when no API key and no Bearer token', async () => {
    const { ctx } = createMockContext({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      'Missing authentication',
    );
  });

  // =========================================================================
  // Instance API key (eng_inst_ prefix)
  // =========================================================================

  describe('Instance API key', () => {
    const apiKey = 'eng_inst_test123';
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const account = { id: 'acc-1' };
    const agent = { id: 'agent-1', accountId: 'acc-1' };
    const user = { id: 'user-1', agentId: 'agent-1', externalId: 'Beaux' };

    it('should authenticate valid instance key and set request context', async () => {
      mockPrisma.instanceApiKey.findUnique.mockResolvedValue({
        id: 'ik-1',
        keyHash,
        accountId: 'acc-1',
        deletedAt: null,
        expiresAt: null,
        scopes: ['read', 'write'],
        account,
      });
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findUnique.mockResolvedValue(user);

      const { ctx, request } = createMockContext({
        headers: { 'x-am-api-key': apiKey, 'x-am-user-id': 'Beaux' },
      });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(request.accountId).toBe('acc-1');
      expect(request.isInstanceKey).toBe(true);
      expect(request.instanceKeyScopes).toEqual(['read', 'write']);
      expect(request.agent).toEqual(agent);
      expect(request.user).toEqual(user);
    });

    it('should reject deleted instance key', async () => {
      mockPrisma.instanceApiKey.findUnique.mockResolvedValue({
        id: 'ik-1',
        keyHash,
        deletedAt: new Date(),
        account,
      });

      const { ctx } = createMockContext({
        headers: { 'x-am-api-key': apiKey },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Invalid instance API key',
      );
    });

    it('should reject instance key not found', async () => {
      mockPrisma.instanceApiKey.findUnique.mockResolvedValue(null);

      const { ctx } = createMockContext({
        headers: { 'x-am-api-key': apiKey },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Invalid instance API key',
      );
    });

    it('should reject expired instance key', async () => {
      mockPrisma.instanceApiKey.findUnique.mockResolvedValue({
        id: 'ik-1',
        keyHash,
        deletedAt: null,
        expiresAt: new Date('2020-01-01'),
        scopes: [],
        account,
        accountId: 'acc-1',
      });

      const { ctx } = createMockContext({
        headers: { 'x-am-api-key': apiKey },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Instance API key has expired',
      );
    });

    it('should auto-create user if x-am-user-id provided but user not found', async () => {
      const newUser = {
        id: 'user-new',
        accountId: 'acc-1',
        externalId: 'NewUser',
      };
      mockPrisma.instanceApiKey.findUnique.mockResolvedValue({
        id: 'ik-1',
        keyHash,
        accountId: 'acc-1',
        deletedAt: null,
        expiresAt: null,
        scopes: [],
        account,
      });
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(newUser);

      const { ctx, request } = createMockContext({
        headers: { 'x-am-api-key': apiKey, 'x-am-user-id': 'NewUser' },
      });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: { accountId: 'acc-1', externalId: 'NewUser' },
      });
      expect(request.user).toEqual(newUser);
    });

    it('should fall back to first user when no x-am-user-id header', async () => {
      const fallbackUser = { id: 'user-first', agentId: 'agent-1' };
      mockPrisma.instanceApiKey.findUnique.mockResolvedValue({
        id: 'ik-1',
        keyHash,
        accountId: 'acc-1',
        deletedAt: null,
        expiresAt: null,
        scopes: [],
        account,
      });
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findFirst.mockResolvedValue(fallbackUser);

      const { ctx, request } = createMockContext({
        headers: { 'x-am-api-key': apiKey },
      });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(request.user).toEqual(fallbackUser);
    });

    it('should update lastUsedAt best-effort (not await)', async () => {
      mockPrisma.instanceApiKey.findUnique.mockResolvedValue({
        id: 'ik-1',
        keyHash,
        accountId: 'acc-1',
        deletedAt: null,
        expiresAt: null,
        scopes: [],
        account,
      });
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findFirst.mockResolvedValue(user);
      mockPrisma.instanceApiKey.update.mockRejectedValue(new Error('db down'));

      const { ctx } = createMockContext({
        headers: { 'x-am-api-key': apiKey },
      });

      // Should not throw even if update fails
      expect(await guard.canActivate(ctx)).toBe(true);
    });

    it('should hash the instance key with SHA-256 for lookup', async () => {
      mockPrisma.instanceApiKey.findUnique.mockResolvedValue(null);

      const { ctx } = createMockContext({
        headers: { 'x-am-api-key': apiKey },
      });

      try {
        await guard.canActivate(ctx);
      } catch {
        /* expected */
      }

      expect(mockPrisma.instanceApiKey.findUnique).toHaveBeenCalledWith({
        where: { keyHash },
        include: { account: true },
      });
    });
  });

  // =========================================================================
  // Regular API key (delegates to ApiKeyGuard)
  // =========================================================================

  describe('Regular API key', () => {
    it('should delegate to ApiKeyGuard for non-instance keys', async () => {
      // ApiKeyGuard will look up agent by apiKeyHash
      const apiKey = 'engram_regular123';
      mockPrisma.agent.findUnique = jest.fn().mockResolvedValue(null);

      const { ctx } = createMockContext({
        headers: { 'x-am-api-key': apiKey, 'x-am-user-id': 'Beaux' },
      });

      // ApiKeyGuard should throw for invalid key
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // =========================================================================
  // JWT Bearer token
  // =========================================================================

  describe('JWT Bearer token', () => {
    const agent = { id: 'agent-1', accountId: 'acc-1' };
    const user = { id: 'user-1', agentId: 'agent-1', externalId: 'acc-1' };

    it('should authenticate valid JWT and resolve agent + user', async () => {
      mockJwt.verify.mockReturnValue({ sub: 'acc-1', email: 'test@test.com' });
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findUnique.mockResolvedValue(user);

      const { ctx, request } = createMockContext({
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(mockJwt.verify).toHaveBeenCalledWith('valid-token');
      expect(request.accountId).toBe('acc-1');
      expect(request.agent).toEqual(agent);
      expect(request.user).toEqual(user);
    });

    it('should throw for invalid/expired JWT', async () => {
      mockJwt.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });

      const { ctx } = createMockContext({
        headers: { authorization: 'Bearer expired-token' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Invalid or expired token',
      );
    });

    it('should throw when JWT has no sub', async () => {
      mockJwt.verify.mockReturnValue({ email: 'test@test.com' });

      const { ctx } = createMockContext({
        headers: { authorization: 'Bearer no-sub-token' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Invalid token payload',
      );
    });

    it('should throw when no agent found for account', async () => {
      mockJwt.verify.mockReturnValue({ sub: 'acc-no-agent' });
      mockPrisma.agent.findFirst.mockResolvedValue(null);

      const { ctx } = createMockContext({
        headers: { authorization: 'Bearer valid-token' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'No agent found for this account',
      );
    });

    it('should auto-create user from JWT when not found', async () => {
      const newUser = {
        id: 'user-new',
        accountId: 'acc-1',
        externalId: 'acc-1',
      };
      mockJwt.verify.mockReturnValue({ sub: 'acc-1' });
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(newUser);

      const { ctx, request } = createMockContext({
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: { accountId: 'acc-1', externalId: 'acc-1' },
      });
      expect(request.user).toEqual(newUser);
    });

    it('should prefer x-am-user-id over JWT email for user resolution', async () => {
      mockJwt.verify.mockReturnValue({ sub: 'acc-1', email: 'test@test.com' });
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-custom',
        agentId: 'agent-1',
        externalId: 'CustomUser',
      });

      const { ctx } = createMockContext({
        headers: {
          authorization: 'Bearer valid-token',
          'x-am-user-id': 'CustomUser',
        },
      });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: {
          accountId_externalId: {
            accountId: 'acc-1',
            externalId: 'CustomUser',
          },
        },
      });
    });
  });

  // =========================================================================
  // LAN bypass
  // =========================================================================

  describe('LAN bypass', () => {
    const agent = { id: 'agent-1', accountId: 'acc-1' };
    const user = { id: 'user-1', agentId: 'agent-1' };

    beforeEach(() => {
      defaultConfig.EDITION = 'local';
      defaultConfig.TRUST_LOCAL_NETWORK = 'true';
    });

    it('should allow local IP without credentials in local edition', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findFirst.mockResolvedValue(user);

      const { ctx, request } = createMockContext({
        ip: '127.0.0.1',
        headers: {},
      });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(request.isLanBypass).toBe(true);
      expect(request.agent).toEqual(agent);
      expect(request.user).toEqual(user);
    });

    it('should allow 192.168.x.x as local', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findFirst.mockResolvedValue(user);

      const { ctx } = createMockContext({ ip: '192.168.1.50', headers: {} });
      expect(await guard.canActivate(ctx)).toBe(true);
    });

    it('should allow 10.x.x.x as local', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findFirst.mockResolvedValue(user);

      const { ctx } = createMockContext({ ip: '10.0.0.5', headers: {} });
      expect(await guard.canActivate(ctx)).toBe(true);
    });

    it('should allow ::ffff:127.0.0.1 as local', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findFirst.mockResolvedValue(user);

      const { ctx } = createMockContext({
        ip: '::ffff:127.0.0.1',
        headers: {},
      });
      expect(await guard.canActivate(ctx)).toBe(true);
    });

    it('should not LAN bypass when TRUST_LOCAL_NETWORK is false', async () => {
      defaultConfig.TRUST_LOCAL_NETWORK = 'false';

      const { ctx } = createMockContext({ ip: '127.0.0.1', headers: {} });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Missing authentication',
      );
    });

    it('should not LAN bypass for cloud edition', async () => {
      defaultConfig.EDITION = 'cloud';

      const { ctx } = createMockContext({ ip: '127.0.0.1', headers: {} });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Missing authentication',
      );
    });

    it('should allow LAN_BYPASS=true even for non-local edition', async () => {
      defaultConfig.EDITION = 'cloud';
      defaultConfig.LAN_BYPASS = 'true';
      defaultConfig.TRUST_LOCAL_NETWORK = 'true';

      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findFirst.mockResolvedValue(user);

      const { ctx, request } = createMockContext({
        ip: '127.0.0.1',
        headers: {},
      });
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(request.isLanBypass).toBe(true);
    });

    it('should resolve user by x-user-id (internal) header', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findUnique.mockResolvedValue(user);

      const { ctx, request } = createMockContext({
        ip: '127.0.0.1',
        headers: { 'x-user-id': 'user-1' },
      });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
      expect(request.user).toEqual(user);
    });

    it('should resolve user by x-am-user-id (external) when internal not found', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null) // internal ID lookup
        .mockResolvedValueOnce(user); // external ID lookup

      const { ctx, request } = createMockContext({
        ip: '127.0.0.1',
        headers: { 'x-user-id': 'bad-id', 'x-am-user-id': 'Beaux' },
      });

      expect(await guard.canActivate(ctx)).toBe(true);
    });

    it('should auto-create user via external ID in LAN bypass', async () => {
      const newUser = {
        id: 'user-new',
        accountId: 'acc-1',
        externalId: 'NewUser',
      };
      mockPrisma.agent.findFirst.mockResolvedValue(agent);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(newUser);

      const { ctx, request } = createMockContext({
        ip: '127.0.0.1',
        headers: { 'x-am-user-id': 'NewUser' },
      });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: { accountId: 'acc-1', externalId: 'NewUser' },
      });
    });

    it('should handle no agent found in LAN bypass gracefully', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(null);

      const { ctx, request } = createMockContext({
        ip: '127.0.0.1',
        headers: {},
      });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(request.agent).toBeNull();
      expect(request.user).toBeNull();
      expect(request.isLanBypass).toBe(true);
    });

    it('should not LAN bypass for public IP', async () => {
      const { ctx } = createMockContext({ ip: '203.0.113.50', headers: {} });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'Missing authentication',
      );
    });
  });

  // =========================================================================
  // isLocalIp edge cases
  // =========================================================================

  describe('isLocalIp', () => {
    beforeEach(() => {
      defaultConfig.EDITION = 'local';
      defaultConfig.TRUST_LOCAL_NETWORK = 'true';
    });

    const localIps = [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '10.0.0.1',
      '10.255.255.255',
      '192.168.0.1',
      '192.168.255.255',
      '::ffff:10.0.0.1',
      '::ffff:192.168.1.1',
      '172.16.0.1', // HEY-205: now correctly recognized as private (172.16-31.x.x)
      '172.31.255.1',
      '::ffff:172.20.0.1',
    ];

    const publicIps = [
      '203.0.113.1',
      '8.8.8.8',
      '172.15.0.1', // 172.15.x is NOT private
      '172.32.0.1', // 172.32.x is NOT private
      '11.0.0.1',
    ];

    localIps.forEach((ip) => {
      it(`should treat ${ip} as local`, async () => {
        mockPrisma.agent.findFirst.mockResolvedValue({
          id: 'a',
          accountId: 'x',
        });
        mockPrisma.user.findFirst.mockResolvedValue({ id: 'u' });

        const { ctx } = createMockContext({ ip, headers: {} });
        expect(await guard.canActivate(ctx)).toBe(true);
      });
    });

    publicIps.forEach((ip) => {
      it(`should treat ${ip} as non-local`, async () => {
        const { ctx } = createMockContext({ ip, headers: {} });
        await expect(guard.canActivate(ctx)).rejects.toThrow(
          'Missing authentication',
        );
      });
    });
  });

  // =========================================================================
  // Priority: API key header takes precedence over JWT
  // =========================================================================

  it('should try API key first when both API key and Bearer are present', async () => {
    const apiKey = 'eng_inst_both';
    const keyHash = createHash('sha256').update(apiKey).digest('hex');

    mockPrisma.instanceApiKey.findUnique.mockResolvedValue({
      id: 'ik-1',
      keyHash,
      accountId: 'acc-1',
      deletedAt: null,
      expiresAt: null,
      scopes: [],
      account: { id: 'acc-1' },
    });
    mockPrisma.agent.findFirst.mockResolvedValue({
      id: 'agent-1',
      accountId: 'acc-1',
    });
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1' });

    const { ctx } = createMockContext({
      headers: {
        'x-am-api-key': apiKey,
        authorization: 'Bearer some-jwt',
      },
    });

    expect(await guard.canActivate(ctx)).toBe(true);
    // JWT should NOT have been called
    expect(mockJwt.verify).not.toHaveBeenCalled();
  });
});
