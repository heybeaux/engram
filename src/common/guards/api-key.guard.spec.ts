import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { createHash } from 'crypto';

const mockPrisma = {
  agent: { findUnique: jest.fn() },
  user: { findUnique: jest.fn(), create: jest.fn() },
};

function createMockContext(overrides: {
  headers?: Record<string, string>;
  ip?: string;
}): ExecutionContext {
  const request = {
    headers: overrides.headers || {},
    ip: overrides.ip || '203.0.113.1',
    connection: { remoteAddress: overrides.ip || '203.0.113.1' },
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyGuard,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, def: string) =>
              key === 'TRUST_LOCAL_NETWORK' ? 'true' : def,
          },
        },
      ],
    }).compile();

    guard = module.get<ApiKeyGuard>(ApiKeyGuard);
  });

  // --- Localhost bypass ---

  it('should allow localhost requests without auth headers', async () => {
    const ctx = createMockContext({ ip: '127.0.0.1', headers: {} });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockPrisma.agent.findUnique).not.toHaveBeenCalled();
  });

  it('should allow ::1 (IPv6 localhost) without auth', async () => {
    const ctx = createMockContext({ ip: '::1', headers: {} });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('should allow ::ffff:127.0.0.1 without auth', async () => {
    const ctx = createMockContext({ ip: '::ffff:127.0.0.1', headers: {} });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('should allow private network 192.168.x.x without auth', async () => {
    const ctx = createMockContext({ ip: '192.168.1.100', headers: {} });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('should allow private network 10.x.x.x without auth', async () => {
    const ctx = createMockContext({ ip: '10.0.0.5', headers: {} });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('should reject localhost origin without local IP (no header-based bypass)', async () => {
    const ctx = createMockContext({
      ip: '203.0.113.1',
      headers: { origin: 'http://localhost:3000' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject localhost host header without local IP (no header-based bypass)', async () => {
    const ctx = createMockContext({
      ip: '203.0.113.1',
      headers: { host: 'localhost:3001' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('should set request.agent and request.user to null for local bypass', async () => {
    const request = {
      headers: {},
      ip: '127.0.0.1',
      connection: { remoteAddress: '127.0.0.1' },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    expect((request as any).agent).toBeNull();
    expect((request as any).user).toBeNull();
  });

  // --- Local with API key should still authenticate ---

  it('should authenticate local request if API key is provided', async () => {
    const apiKey = 'engram_test123';
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
    const agent = { id: 'agent-1', apiKeyHash, deletedAt: null };
    const user = {
      id: 'user-1',
      agentId: 'agent-1',
      externalId: 'Beaux',
      deletedAt: null,
    };

    mockPrisma.agent.findUnique.mockResolvedValue(agent);
    mockPrisma.user.findUnique.mockResolvedValue(user);

    const ctx = createMockContext({
      ip: '127.0.0.1',
      headers: { 'x-am-api-key': apiKey, 'x-am-user-id': 'Beaux' },
    });

    expect(await guard.canActivate(ctx)).toBe(true);
    expect(mockPrisma.agent.findUnique).toHaveBeenCalledWith({
      where: { apiKeyHash },
    });
  });

  // --- Missing headers ---

  it('should throw UnauthorizedException when API key missing on external request', async () => {
    const ctx = createMockContext({
      headers: { 'x-am-user-id': 'Beaux' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      'Missing X-AM-API-Key header',
    );
  });

  it('should default User-ID to "default" when missing on external request', async () => {
    // Guard should hash API key and look up agent
    mockPrisma.agent.findUnique.mockResolvedValue(null);

    const ctx = createMockContext({
      headers: { 'x-am-api-key': 'some-key' },
    });
    // Should throw for invalid key, not missing user-id
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key');
  });

  // --- Invalid API key ---

  it('should throw UnauthorizedException for invalid API key', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue(null);

    const ctx = createMockContext({
      headers: { 'x-am-api-key': 'bad-key', 'x-am-user-id': 'Beaux' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key');
  });

  it('should throw UnauthorizedException for deleted agent', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      deletedAt: new Date(),
    });

    const ctx = createMockContext({
      headers: { 'x-am-api-key': 'some-key', 'x-am-user-id': 'Beaux' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key');
  });

  // --- User auto-creation ---

  it('should auto-create user on first request', async () => {
    const apiKey = 'engram_new';
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
    const agent = { id: 'agent-1', accountId: 'acc-1', apiKeyHash, deletedAt: null };
    const newUser = {
      id: 'user-new',
      accountId: 'acc-1',
      externalId: 'NewUser',
      deletedAt: null,
    };

    mockPrisma.agent.findUnique.mockResolvedValue(agent);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue(newUser);

    const ctx = createMockContext({
      headers: { 'x-am-api-key': apiKey, 'x-am-user-id': 'NewUser' },
    });

    expect(await guard.canActivate(ctx)).toBe(true);
    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: { accountId: 'acc-1', externalId: 'NewUser' },
    });
  });

  // --- Deleted user ---

  it('should throw UnauthorizedException for deleted user', async () => {
    const apiKey = 'engram_del';
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
    const agent = { id: 'agent-1', accountId: 'acc-1', apiKeyHash, deletedAt: null };
    const user = { id: 'user-del', deletedAt: new Date() };

    mockPrisma.agent.findUnique.mockResolvedValue(agent);
    mockPrisma.user.findUnique.mockResolvedValue(user);

    const ctx = createMockContext({
      headers: { 'x-am-api-key': apiKey, 'x-am-user-id': 'Beaux' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      'User has been deleted',
    );
  });

  // --- Successful auth attaches request context ---

  it('should attach agent and user to request on success', async () => {
    const apiKey = 'engram_ok';
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
    const agent = { id: 'agent-1', accountId: 'acc-1', apiKeyHash, deletedAt: null };
    const user = {
      id: 'user-1',
      accountId: 'acc-1',
      externalId: 'Beaux',
      deletedAt: null,
    };

    mockPrisma.agent.findUnique.mockResolvedValue(agent);
    mockPrisma.user.findUnique.mockResolvedValue(user);

    const request = {
      headers: { 'x-am-api-key': apiKey, 'x-am-user-id': 'Beaux' },
      ip: '203.0.113.1',
      connection: { remoteAddress: '203.0.113.1' },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    expect((request as any).agent).toEqual(agent);
    expect((request as any).user).toEqual(user);
  });

  // --- API key hashing ---

  it('should hash the API key with SHA-256 for lookup', async () => {
    const apiKey = 'engram_test_hash';
    const expectedHash = createHash('sha256').update(apiKey).digest('hex');

    mockPrisma.agent.findUnique.mockResolvedValue(null);

    const ctx = createMockContext({
      headers: { 'x-am-api-key': apiKey, 'x-am-user-id': 'Beaux' },
    });

    try {
      await guard.canActivate(ctx);
    } catch {
      // expected to throw
    }

    expect(mockPrisma.agent.findUnique).toHaveBeenCalledWith({
      where: { apiKeyHash: expectedHash },
    });
  });

  // --- IPv6-mapped private IPs ---

  it('should allow ::ffff:10.0.0.1 without auth', async () => {
    const ctx = createMockContext({ ip: '::ffff:10.0.0.1', headers: {} });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('should allow ::ffff:192.168.0.1 without auth', async () => {
    const ctx = createMockContext({ ip: '::ffff:192.168.0.1', headers: {} });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  // --- Public IP requires auth ---

  it('should require auth for public IP without local indicators', async () => {
    const ctx = createMockContext({
      ip: '203.0.113.50',
      headers: {},
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      'Missing X-AM-API-Key header',
    );
  });
});
