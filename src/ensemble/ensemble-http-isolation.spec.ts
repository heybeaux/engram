/** Opt-in integration: ENSEMBLE_AUDIT_PG=1. Uses only a new local scratch DB. */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Client } from 'pg';
import request from 'supertest';
import { EnsembleController } from './ensemble.controller';
import { EnsembleService } from './ensemble.service';
import { PgVectorEnsembleProvider } from './pgvector-ensemble.provider';
import { PrismaService } from '../prisma/prisma.service';
import { NightlyReembedService } from './nightly-reembed.service';
import { DriftDetectionService } from './drift-detection.service';

const run = process.env.ENSEMBLE_AUDIT_PG === '1' ? describe : describe.skip;
run(
  'Ensemble two-account HTTP isolation with a non-superuser BYPASSRLS store',
  () => {
    const database = `engram_audit_ensemble_${process.pid}`;
    const role = `engram_audit_vectors_${process.pid}`;
    const local = { host: '/tmp', database: 'postgres' };
    const admin = new Client(local);
    let db: Client;
    let app: any;
    let service: EnsembleService;
    let tokenA: string;
    let tokenB: string;
    let createdDatabase = false;
    let createdRole = false;
    const vector = Array(768).fill(0.1);

    beforeAll(async () => {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${database}`);
      createdDatabase = true;
      await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER BYPASSRLS`);
      createdRole = true;
      db = new Client({ ...local, database });
      await db.connect();
      await db.query(`CREATE EXTENSION vector;
      CREATE TABLE users(id text PRIMARY KEY, account_id text, external_id text, deleted_at timestamptz);
      CREATE TABLE agents(id text PRIMARY KEY, account_id text);
      CREATE TABLE accounts(id text PRIMARY KEY, is_admin boolean);
      CREATE TABLE memories(id text PRIMARY KEY, user_id text REFERENCES users(id), raw text, deleted_at timestamptz);
      CREATE TABLE memory_embeddings(id text PRIMARY KEY, memory_id text REFERENCES memories(id), model_id text, dimensions int, embedding vector, created_at timestamptz, updated_at timestamptz, UNIQUE(memory_id, model_id));
      INSERT INTO accounts VALUES ('account-a', false), ('account-b', false);
      INSERT INTO agents VALUES ('agent-a','account-a'), ('agent-b','account-b');
      INSERT INTO users VALUES ('ua','account-a','a',NULL), ('ub','account-b','b',NULL);
      INSERT INTO memories VALUES ('ma','ua','alpha',NULL), ('mb','ub','beta',NULL);
      ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memories FORCE ROW LEVEL SECURITY;
      CREATE POLICY account_scope ON memories USING (user_id IN (SELECT id FROM users WHERE account_id = current_setting('app.account_id', true)));
      GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role};`);
      await db.query(`SET ROLE ${role}`);
      const facade: any = {
        $executeRawUnsafe: async (sql: string, ...args: any[]) =>
          (await db.query(sql, args)).rowCount,
        $queryRawUnsafe: async (sql: string, ...args: any[]) =>
          (await db.query(sql, args)).rows,
        $transaction: async (fn: any) => {
          await db.query('BEGIN');
          try {
            const result = await fn(facade);
            await db.query('COMMIT');
            return result;
          } catch (error) {
            await db.query('ROLLBACK');
            throw error;
          }
        },
        user: {
          findFirst: async ({ where }: any) =>
            (
              await db.query(
                'SELECT id FROM users WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL',
                [where.id, where.accountId],
              )
            ).rows[0],
          findUnique: async ({ where }: any) =>
            (
              await db.query(
                'SELECT id, account_id AS "accountId" FROM users WHERE account_id=$1 AND external_id=$2',
                [
                  where.accountId_externalId.accountId,
                  where.accountId_externalId.externalId,
                ],
              )
            ).rows[0],
        },
        agent: {
          findFirst: async ({ where }: any) =>
            (
              await db.query(
                'SELECT id, account_id AS "accountId" FROM agents WHERE account_id=$1',
                [where.accountId],
              )
            ).rows[0],
        },
        account: {
          findUnique: async ({ where }: any) =>
            (
              await db.query(
                'SELECT is_admin AS "isAdmin" FROM accounts WHERE id=$1',
                [where.id],
              )
            ).rows[0],
        },
        memory: {
          findFirst: async ({ where }: any) =>
            (
              await db.query(
                'SELECT id FROM memories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
                [where.id, where.userId],
              )
            ).rows[0],
        },
      };
      const config = new ConfigService({
        ENSEMBLE_ENABLED: true,
        ENSEMBLE_MODELS: 'bge-base',
        EDITION: 'cloud',
        NODE_ENV: 'production',
        TRUST_LOCAL_NETWORK: 'false',
      });
      const jwt = new JwtService({ secret: 'isolated-audit-fixture-only' });
      service = new EnsembleService(
        config,
        new PgVectorEnsembleProvider(facade),
        facade,
        {} as any,
        {} as any,
      );
      // Deterministic embedder; all auth/controller/service/storage code is real.
      jest.spyOn(service, 'embedAll').mockImplementation(async () => ({
        embeddings: [
          {
            model: 'bge-base',
            dimensions: 768,
            embedding: vector,
            latencyMs: 0,
          },
        ],
        totalMs: 0,
      }));
      // Avoid onModuleInit's network model-health discovery in this focused HTTP fixture.
      jest.spyOn(service, 'onModuleInit').mockResolvedValue();
      await service.upsert({ memoryId: 'ma', userId: 'ua', content: 'alpha' });
      await service.upsert({ memoryId: 'mb', userId: 'ub', content: 'beta' });
      const module = await Test.createTestingModule({
        controllers: [EnsembleController],
        providers: [
          { provide: EnsembleService, useValue: service },
          { provide: ConfigService, useValue: config },
          { provide: JwtService, useValue: jwt },
          { provide: PrismaService, useValue: facade },
          { provide: NightlyReembedService, useValue: {} },
          { provide: DriftDetectionService, useValue: {} },
        ],
      }).compile();
      app = module.createNestApplication();
      await app.init();
      tokenA = jwt.sign({ sub: 'account-a', email: 'a' });
      tokenB = jwt.sign({ sub: 'account-b', email: 'b' });
    }, 20000);

    afterAll(async () => {
      if (app) await app.close();
      if (db) await db.end();
      if (createdDatabase) await admin.query(`DROP DATABASE ${database}`);
      if (createdRole) await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    });

    it('runs the vector store with BYPASSRLS but without superuser privileges', async () => {
      const row = (
        await db.query(
          'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname=current_user',
        )
      ).rows[0];
      expect(row).toEqual({ rolbypassrls: true, rolsuper: false });
    });
    it('authenticates two accounts and retrieves only each account’s own memory', async () => {
      for (const [token, userId, memoryId] of [
        [tokenA, 'ua', 'ma'],
        [tokenB, 'ub', 'mb'],
      ]) {
        const response = await request(app.getHttpServer())
          .post('/v1/ensemble/query')
          .auth(token, { type: 'bearer' })
          .send({ query: 'fact', userId })
          .expect(200);
        expect(response.body.results.map((r: any) => r.memoryId)).toEqual([
          memoryId,
        ]);
      }
    });
    it.each(['query', 'compare'])(
      'rejects attacker-selected user scope on %s',
      async (endpoint) => {
        await request(app.getHttpServer())
          .post(`/v1/ensemble/${endpoint}`)
          .auth(tokenA, { type: 'bearer' })
          .send({ query: 'victim', userId: 'ub' })
          .expect(403);
      },
    );
    it('rejects victim embedding writes/status before embedding or reading', async () => {
      const embed = jest.spyOn(service, 'embedAll');
      embed.mockClear();
      await request(app.getHttpServer())
        .post('/v1/ensemble/upsert')
        .auth(tokenA, { type: 'bearer' })
        .send({ memoryId: 'mb', userId: 'ua', content: 'poison' })
        .expect(404);
      await request(app.getHttpServer())
        .get('/v1/ensemble/memories/mb/embeddings')
        .auth(tokenA, { type: 'bearer' })
        .expect(404);
      expect(embed).not.toHaveBeenCalled();
    });
    it('allows an authorized write and verifies the persisted vector', async () => {
      await request(app.getHttpServer())
        .post('/v1/ensemble/upsert')
        .auth(tokenA, { type: 'bearer' })
        .send({ memoryId: 'ma', userId: 'ua', content: 'alpha' })
        .expect(200);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM memory_embeddings WHERE memory_id='ma' AND vector_dims(embedding)=768",
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it('enforces ownership at SQL write boundary even when called without controller', async () => {
      await expect(
        service.upsert({ memoryId: 'mb', userId: 'ua', content: 'poison' }),
      ).rejects.toMatchObject({ status: 503 });
      const value = (
        await db.query(
          "SELECT embedding::text FROM memory_embeddings WHERE memory_id='mb'",
        )
      ).rows[0].embedding;
      expect(JSON.parse(value)).toEqual(vector);
    });
    it.each(['reembed', 'reembed/targeted', 'drift/analyze'])(
      'rejects a non-admin global mutation: %s',
      async (endpoint) => {
        await request(app.getHttpServer())
          .post(`/v1/ensemble/${endpoint}`)
          .auth(tokenA, { type: 'bearer' })
          .send({ memoryIds: ['mb'], models: ['bge-base'] })
          .expect(403);
      },
    );
    it.each([
      'models',
      'coverage',
      'ab-results',
      'drift',
      'drift/history',
      'reembed/status',
    ])('rejects non-admin global diagnostics: %s', async (endpoint) => {
      await request(app.getHttpServer())
        .get(`/v1/ensemble/${endpoint}`)
        .auth(tokenA, { type: 'bearer' })
        .expect(403);
    });
    it('allows an explicitly authorized administrator to read global diagnostics', async () => {
      jest.spyOn(service, 'getModels').mockResolvedValue([]);
      await db.query("UPDATE accounts SET is_admin=true WHERE id='account-a'");
      try {
        await request(app.getHttpServer())
          .get('/v1/ensemble/models')
          .auth(tokenA, { type: 'bearer' })
          .expect(200);
      } finally {
        await db.query(
          "UPDATE accounts SET is_admin=false WHERE id='account-a'",
        );
      }
    });
    it('rejects missing authentication', async () => {
      await request(app.getHttpServer())
        .post('/v1/ensemble/query')
        .send({ query: 'fact', userId: 'ua' })
        .expect(401);
    });
  },
);
