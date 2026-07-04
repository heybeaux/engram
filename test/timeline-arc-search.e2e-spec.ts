import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-test-app';
import { createTestUser, TestUserFixture } from './helpers/test-user';
import { EmbeddingService } from '../src/embedding/embedding.service';

/**
 * ENG-165 end-to-end: arc search (semantic + calendar) against the real test DB.
 *
 * Seeds two distinct-topic arcs across known, non-overlapping windows, then
 * exercises `POST /v1/timelines/arc/search`:
 *   1. a semantic query matching arc A ranks A first;
 *   2. a from/to window returns only arcs overlapping it;
 *   3. hybrid (query + window) intersects correctly;
 *   4. an empty search (no query/from/to) → 400.
 *
 * The query embedding is stubbed deterministically (topic → basis vector) so
 * ranking is hermetic — no live embedding model runs in CI. This follows the
 * LOD-stub pattern in timeline-arc.e2e-spec.ts.
 */
describe('Timeline Arc Search (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let user: TestUserFixture;

  // Deterministic 768-dim embedding: topic keyword → distinct basis vector.
  // "whalehawk" → e0, "garden" → e1, otherwise a neutral vector.
  const topicVector = (text: string): number[] => {
    const v = new Array(768).fill(0);
    const lower = text.toLowerCase();
    if (lower.includes('whalehawk')) v[0] = 1;
    else if (lower.includes('garden')) v[1] = 1;
    else v[2] = 1;
    return v;
  };

  const embedStub = {
    embed: jest.fn(async (texts: string[]) => texts.map(topicVector)),
  };

  const ARC_A = `arc-whalehawk-${Date.now()}`;
  const ARC_B = `arc-garden-${Date.now()}`;

  // Arc A: 2026-03-01 .. 2026-03-03 (WhaleHawk). Arc B: 2026-06-10 .. 2026-06-12 (garden).
  const arcADates = ['2026-03-01', '2026-03-02', '2026-03-03'];
  const arcBDates = ['2026-06-10', '2026-06-11', '2026-06-12'];

  let agentId: string;

  // Insert a timeline row + its summaryEmbedding (raw ::vector) for a day.
  const seedDay = async (
    arcId: string,
    date: string,
    summaryText: string,
    significance: number,
  ) => {
    await prisma.timeline.create({
      data: {
        agentId,
        agentLocalDate: new Date(date),
        chapter: summaryText.split(' ').slice(0, 2).join(' '),
        arcId,
        indexText: `idx ${summaryText}`,
        summaryText,
        standardText: `standard ${summaryText}`,
        significance,
      },
    });
    const vec = topicVector(summaryText);
    await prisma.$executeRawUnsafe(
      `UPDATE "timelines" SET "summaryEmbedding" = $1::vector
       WHERE "agentId" = $2 AND "agentLocalDate" = $3::date`,
      `[${vec.join(',')}]`,
      agentId,
      date,
    );
  };

  beforeAll(async () => {
    const created = await createTestApp({
      overrideEmbedding: true,
      overrideProviders: [{ provide: EmbeddingService, useValue: embedStub }],
    });
    app = created.app;
    prisma = created.prisma;

    user = await createTestUser(prisma);
    agentId = user.agentId;

    // Seed arc A (WhaleHawk).
    await seedDay(ARC_A, arcADates[0], 'WhaleHawk kickoff planning', 6);
    await seedDay(ARC_A, arcADates[1], 'WhaleHawk build day', 8);
    await seedDay(ARC_A, arcADates[2], 'WhaleHawk launch ship', 9);

    // Seed arc B (garden).
    await seedDay(ARC_B, arcBDates[0], 'garden soil prep', 4);
    await seedDay(ARC_B, arcBDates[1], 'garden planting seeds', 7);
    await seedDay(ARC_B, arcBDates[2], 'garden watering routine', 3);
  }, 60000);

  afterAll(async () => {
    if (prisma && user) {
      await prisma.timeline.deleteMany({ where: { agentId } }).catch(() => {});
      await user.cleanup().catch(() => {});
    }
    if (app) await app.close();
  }, 30000);

  const post = (body: any) =>
    request(app.getHttpServer())
      .post('/v1/timelines/arc/search')
      .set('X-AM-API-Key', user.apiKey)
      .set('X-AM-User-ID', user.userId)
      .send(body);

  it('ranks the semantically-matching arc first', async () => {
    const res = await post({ query: 'WhaleHawk launch work' }).expect(200);

    expect(embedStub.embed).toHaveBeenCalledWith(['WhaleHawk launch work']);
    expect(res.body.arcs.length).toBeGreaterThanOrEqual(2);
    expect(res.body.arcs[0].arcId).toBe(ARC_A);
    expect(res.body.arcs[0].dayCount).toBe(3);
    expect(res.body.arcs[0].from).toBe('2026-03-01');
    expect(res.body.arcs[0].to).toBe('2026-03-03');
    expect(res.body.arcs[0].score).toBeGreaterThan(res.body.arcs[1].score);
  });

  it('ranks the garden arc first for a garden query', async () => {
    const res = await post({ query: 'garden planting' }).expect(200);
    expect(res.body.arcs[0].arcId).toBe(ARC_B);
  });

  it('filters by calendar window (returns only overlapping arcs)', async () => {
    const res = await post({
      from: '2026-05-01',
      to: '2026-07-01',
    }).expect(200);

    const ids = res.body.arcs.map((a: any) => a.arcId);
    expect(ids).toContain(ARC_B);
    expect(ids).not.toContain(ARC_A);
  });

  it('hybrid (query + window) intersects — query for A but window over B yields nothing', async () => {
    const res = await post({
      query: 'WhaleHawk launch',
      from: '2026-05-01',
      to: '2026-07-01',
    }).expect(200);

    const ids = res.body.arcs.map((a: any) => a.arcId);
    // The WhaleHawk arc is outside the window, so it is filtered out.
    expect(ids).not.toContain(ARC_A);
  });

  it('hybrid (query + window) returns A when window covers A', async () => {
    const res = await post({
      query: 'WhaleHawk launch',
      from: '2026-02-01',
      to: '2026-04-01',
    }).expect(200);

    expect(res.body.arcs[0].arcId).toBe(ARC_A);
  });

  it('rejects an empty search with 400', async () => {
    await post({}).expect(400);
  });
});
