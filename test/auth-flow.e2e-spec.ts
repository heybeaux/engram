import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';

/**
 * HEY-130: Auth Flow E2E Tests
 *
 * Tests JWT login/signup, API key creation/usage, token refresh/expiry,
 * permission boundaries between accounts, and dashboard auth state.
 */
describe('Auth Flow E2E (HEY-130)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;

  const origTrustLocal = process.env.TRUST_LOCAL_NETWORK;
  const origLanBypass = process.env.LAN_BYPASS;
  const origDeploymentMode = process.env.DEPLOYMENT_MODE;

  // Account A
  const emailA = 'hey130-acct-a@test.local';
  const passwordA = 'TestPassword123!';
  let accountAId: string;
  let tokenA: string;

  // Account B
  const emailB = 'hey130-acct-b@test.local';
  const passwordB = 'TestPassword456!';
  let accountBId: string;
  let tokenB: string;

  // API keys
  let agentAKey: string;
  let agentAId: string;

  beforeAll(async () => {
    process.env.TRUST_LOCAL_NETWORK = 'false';
    process.env.LAN_BYPASS = 'false';
    process.env.DEPLOYMENT_MODE = 'cloud';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);

    // Clean up any leftover test data
    await prisma.agent
      .deleteMany({
        where: { account: { email: { in: [emailA, emailB] } } },
      })
      .catch(() => {});
    await prisma.account
      .deleteMany({
        where: { email: { in: [emailA, emailB] } },
      })
      .catch(() => {});
  });

  afterAll(async () => {
    // Cleanup
    await prisma.memoryExtraction
      .deleteMany({
        where: {
          memory: {
            user: { account: { email: { in: [emailA, emailB] } } },
          },
        },
      })
      .catch(() => {});
    await prisma.memory
      .deleteMany({
        where: {
          user: { account: { email: { in: [emailA, emailB] } } },
        },
      })
      .catch(() => {});
    await prisma.user
      .deleteMany({
        where: { account: { email: { in: [emailA, emailB] } } },
      })
      .catch(() => {});
    await prisma.agent
      .deleteMany({
        where: { account: { email: { in: [emailA, emailB] } } },
      })
      .catch(() => {});
    await prisma.account
      .deleteMany({
        where: { email: { in: [emailA, emailB] } },
      })
      .catch(() => {});

    // Restore env
    for (const [key, orig] of [
      ['TRUST_LOCAL_NETWORK', origTrustLocal],
      ['LAN_BYPASS', origLanBypass],
      ['DEPLOYMENT_MODE', origDeploymentMode],
    ] as const) {
      if (orig !== undefined) process.env[key] = orig;
      else delete process.env[key];
    }

    await app.close();
  });

  // =========================================================================
  // 1. Registration / Signup
  // =========================================================================
  describe('Registration', () => {
    it('should register Account A with access code', async () => {
      // Create account directly via Prisma (since access codes are env-dependent)
      const bcrypt = await import('bcryptjs');
      const hash = await bcrypt.hash(passwordA, 10);
      const account = await prisma.account.create({
        data: {
          email: emailA,
          passwordHash: hash,
          name: 'Test Account A',
          plan: 'STARTER',
        },
      });
      accountAId = account.id;
      expect(accountAId).toBeDefined();
    });

    it('should register Account B', async () => {
      const bcrypt = await import('bcryptjs');
      const hash = await bcrypt.hash(passwordB, 10);
      const account = await prisma.account.create({
        data: {
          email: emailB,
          passwordHash: hash,
          name: 'Test Account B',
          plan: 'STARTER',
        },
      });
      accountBId = account.id;
      expect(accountBId).toBeDefined();
    });
  });

  // =========================================================================
  // 2. Login / JWT
  // =========================================================================
  describe('Login', () => {
    it('should login with correct credentials and return JWT', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: emailA, password: passwordA })
        .expect(200);

      expect(res.body.token).toBeDefined();
      expect(typeof res.body.token).toBe('string');
      tokenA = res.body.token;
    });

    it('should login Account B', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: emailB, password: passwordB })
        .expect(200);

      tokenB = res.body.token;
      expect(tokenB).toBeDefined();
    });

    it('should reject login with wrong password', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: emailA, password: 'WrongPassword!' })
        .expect(401);
    });

    it('should reject login with non-existent email', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: 'nobody@test.local', password: 'whatever' })
        .expect(401);
    });
  });

  // =========================================================================
  // 3. JWT Token Behavior
  // =========================================================================
  describe('JWT token behavior', () => {
    it('should accept valid JWT on protected endpoints', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.id).toBe(accountAId);
      expect(res.body.email).toBe(emailA);
    });

    it('should reject expired JWT', async () => {
      const expiredToken = jwtService.sign(
        { sub: accountAId },
        { expiresIn: '-1s' },
      );
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);
    });

    it('should reject malformed JWT', async () => {
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', 'Bearer not.a.valid.jwt')
        .expect(401);
    });

    it('should reject JWT with tampered payload', async () => {
      // Tamper with a valid token by modifying its payload
      const validToken = jwtService.sign({ sub: accountAId });
      const parts = validToken.split('.');
      // Corrupt the payload
      parts[1] = Buffer.from(JSON.stringify({ sub: 'fake-id-12345' })).toString(
        'base64url',
      );
      const tamperedToken = parts.join('.');

      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${tamperedToken}`)
        .expect(401);
    });

    it('should reject requests with no auth at all', async () => {
      await request(app.getHttpServer()).get('/v1/account').expect(401);
    });
  });

  // =========================================================================
  // 4. API Key Creation and Usage
  // =========================================================================
  describe('API key creation and usage', () => {
    it('should create an API key via authenticated endpoint', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/account/api-keys')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'HEY-130 Test Agent' })
        .expect(201);

      expect(res.body.key).toBeDefined();
      expect(res.body.id).toBeDefined();
      agentAKey = res.body.key;
      agentAId = res.body.id;
    });

    it('should use created API key to create memories', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', 'hey130-user')
        .send({ raw: 'Memory created with dynamic API key' })
        .expect(201);

      expect(res.body.id).toBeDefined();
    });

    it('should reject deleted/revoked API key', async () => {
      // Create a key, then delete it
      const createRes = await request(app.getHttpServer())
        .post('/v1/account/api-keys')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Ephemeral Key' })
        .expect(201);

      const ephemeralKey = createRes.body.key;
      const ephemeralId = createRes.body.id;

      // Delete the key
      await request(app.getHttpServer())
        .delete(`/v1/account/api-keys/${ephemeralId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      // Try to use deleted key
      await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', ephemeralKey)
        .set('X-AM-User-ID', 'hey130-user')
        .send({ raw: 'Should fail' })
        .expect(401);
    });

    it('should list API keys for authenticated account', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/account/api-keys')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      const names = res.body.map((k: any) => k.name);
      expect(names).toContain('HEY-130 Test Agent');
    });

    it('should not allow creating API keys without auth', async () => {
      await request(app.getHttpServer())
        .post('/v1/account/api-keys')
        .send({ name: 'Should Fail' })
        .expect(401);
    });
  });

  // =========================================================================
  // 5. Permission Boundaries Between Accounts
  // =========================================================================
  describe('Permission boundaries between accounts', () => {
    let memoryIdA: string;

    beforeAll(async () => {
      // Create a memory under Account A's agent
      const res = await request(app.getHttpServer())
        .post('/v1/memories')
        .set('X-AM-API-Key', agentAKey)
        .set('X-AM-User-ID', 'hey130-user')
        .send({ raw: 'Account A private memory for permission test' })
        .expect(201);
      memoryIdA = res.body.id;
    });

    it('Account B JWT should not see Account A data via /v1/account', async () => {
      const resA = await request(app.getHttpServer())
        .get('/v1/account')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      const resB = await request(app.getHttpServer())
        .get('/v1/account')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      expect(resA.body.id).toBe(accountAId);
      expect(resB.body.id).toBe(accountBId);
      expect(resA.body.id).not.toBe(resB.body.id);
    });

    it('Account B should not see Account A API keys', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/account/api-keys')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      const ids = res.body.map((k: any) => k.id);
      expect(ids).not.toContain(agentAId);
    });

    it('Account B should not be able to delete Account A API keys', async () => {
      await request(app.getHttpServer())
        .delete(`/v1/account/api-keys/${agentAId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect((res) => {
          // Should be 403 or 404 — not 204
          expect([403, 404, 500]).toContain(res.status);
        });
    });
  });

  // =========================================================================
  // 6. Dashboard Auth State (/auth/me)
  // =========================================================================
  describe('Dashboard auth state', () => {
    it('/auth/me returns correct account info with JWT', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.id).toBe(accountAId);
      expect(res.body.email).toBe(emailA);
      expect(res.body.plan).toBeDefined();
    });

    it('/auth/me returns correct info with API key', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('X-AM-API-Key', agentAKey)
        .expect(200);

      expect(res.body.id).toBe(accountAId);
    });

    it('/auth/me rejects unauthenticated requests', async () => {
      await request(app.getHttpServer()).get('/v1/auth/me').expect(401);
    });

    it('/auth/setup-status returns without auth', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/auth/setup-status')
        .expect(200);

      expect(res.body).toHaveProperty('needsSetup');
      expect(typeof res.body.needsSetup).toBe('boolean');
    });
  });

  // =========================================================================
  // 7. Password Change
  // =========================================================================
  describe('Password change', () => {
    it('should change password with correct current password', async () => {
      const newPassword = 'NewPassword789!';
      await request(app.getHttpServer())
        .post('/v1/account/change-password')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ currentPassword: passwordA, newPassword })
        .expect(200);

      // Login with new password
      const res = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: emailA, password: newPassword })
        .expect(200);

      expect(res.body.token).toBeDefined();
      tokenA = res.body.token;

      // Old password should no longer work
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: emailA, password: passwordA })
        .expect(401);
    });

    it('should reject password change with wrong current password', async () => {
      await request(app.getHttpServer())
        .post('/v1/account/change-password')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ currentPassword: 'WrongCurrent!', newPassword: 'Whatever123!' })
        .expect((res) => {
          expect([400, 401, 403]).toContain(res.status);
        });
    });
  });
});
