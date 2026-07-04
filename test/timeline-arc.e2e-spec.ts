import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-test-app';
import { createTestUser, TestUserFixture } from './helpers/test-user';
import { DreamCycleTimelineSynthesisStage } from '../src/consolidation/stages/dream-cycle-timeline-synthesis.stage';
import { TimelineService } from '../src/timeline/timeline.service';
import {
  TimelineLodService,
  TimelineLodResult,
} from '../src/timeline/timeline-lod.service';
import { EmbeddingService } from '../src/embedding/embedding.service';
import { MemoryLayer } from '@prisma/client';

/**
 * ENG-46 / ENG-43 end-to-end: prove the full arc lifecycle.
 *
 *   1. Record 14 days of memories (one distinct day each).
 *   2. Run the dream-cycle timeline synthesis stage → 14 daily timelines.
 *   3. Re-run synthesis → same 14 timelines are UPDATED, not duplicated.
 *   4. Close the arc → all 14 daily timelines get a shared arcId.
 *   5. Recall the entire arc → all 14 returned, in chronological order,
 *      at the requested level of detail.
 *
 * The LOD generator (which calls an external LLM) is stubbed with a
 * deterministic per-day result so the test exercises the persistence +
 * recall pipeline hermetically.
 */
describe('Timeline Arc lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let user: TestUserFixture;
  let synthesisStage: DreamCycleTimelineSynthesisStage;
  let timelineService: TimelineService;

  const ARC_DAYS = 14;
  // Unique agentId keeps this test fully isolated from any other data in the
  // shared test DB (synthesis buckets + timeline PK are keyed on agentId).
  const AGENT_LABEL = `arc-e2e-agent-${Date.now()}`;
  const arcId = `arc-project-launch-${Date.now()}`;

  // Deterministic LOD stub — echoes the day so we can assert ordering.
  const lodStub = {
    generateLod: jest.fn(
      async (memories: any[], date: string): Promise<TimelineLodResult> => ({
        indexText: `${date}: "Day ${date}" — ${memories.length} memories. [arc]`,
        summaryText: `Summary for ${date} (${memories.length} memories).`,
        standardText: `Full standard entry for ${date}.`,
        events: [],
        decisions: [],
        chapter: `Chapter ${date}`,
        significance: 5,
        people: [],
        mood: 'focused',
      }),
    ),
  };

  // 14 consecutive UTC dates ending yesterday-ish, deterministic.
  const baseDates: Date[] = Array.from({ length: ARC_DAYS }, (_, i) => {
    const d = new Date('2026-02-01T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + i);
    return d;
  });

  const dateStr = (d: Date) => d.toISOString().slice(0, 10);
  const arcFrom = dateStr(baseDates[0]);
  const arcTo = dateStr(baseDates[ARC_DAYS - 1]);

  beforeAll(async () => {
    const created = await createTestApp({
      overrideEmbedding: true,
      overrideProviders: [
        { provide: TimelineLodService, useValue: lodStub },
        // Timeline summaryEmbedding column is vector(768); return a
        // deterministic 768-dim unit vector so the raw ::vector UPDATE fits.
        {
          provide: EmbeddingService,
          useValue: {
            embed: async (texts: string[]) =>
              texts.map(() => {
                const v = new Array(768).fill(0);
                v[0] = 1;
                return v;
              }),
          },
        },
      ],
    });
    app = created.app;
    prisma = created.prisma;

    user = await createTestUser(prisma);

    // Map external userId → internal user row the synthesis stage queries by.
    const internalUser = await prisma.user.create({
      data: {
        externalId: user.userId,
        accountId: user.accountId,
      },
    });

    // Seed 14 days of memories, one memory per day, backdated.
    for (const d of baseDates) {
      const createdAt = new Date(d);
      createdAt.setUTCHours(12, 0, 0, 0);
      await prisma.memory.create({
        data: {
          userId: internalUser.id,
          agentId: AGENT_LABEL,
          raw: `Work done on ${dateStr(d)}`,
          layer: MemoryLayer.SESSION,
          createdAt,
        },
      });
    }

    // Force the synthesis window to cover all 14 days (no prior dream cycle).
    synthesisStage = app.get(DreamCycleTimelineSynthesisStage);
    timelineService = app.get(TimelineService);

    // Pin the date range so "today" doesn't clip recent days.
    jest
      .spyOn(synthesisStage, 'getDateRange')
      .mockResolvedValue({
        from: baseDates[0],
        to: new Date(baseDates[ARC_DAYS - 1].getTime() + 24 * 60 * 60 * 1000),
      });

    (user as any).__internalUserId = internalUser.id;
  }, 60000);

  afterAll(async () => {
    if (prisma && user) {
      const internalUserId = (user as any).__internalUserId;
      await prisma.timeline
        .deleteMany({ where: { agentId: AGENT_LABEL } })
        .catch(() => {});
      if (internalUserId) {
        await prisma.memory
          .deleteMany({ where: { userId: internalUserId } })
          .catch(() => {});
        await prisma.user
          .deleteMany({ where: { id: internalUserId } })
          .catch(() => {});
      }
      await user.cleanup().catch(() => {});
    }
    if (app) await app.close();
  }, 30000);

  it('synthesizes one timeline per day for 14 days of memories', async () => {
    const result = await synthesisStage.run(
      (user as any).__internalUserId,
      false,
    );

    expect(result.timelinesCreated).toBe(ARC_DAYS);
    expect(result.timelinesUpdated).toBe(0);
    expect(result.daysProcessed).toBe(ARC_DAYS);
    expect(result.errors).toBe(0);
    expect(lodStub.generateLod).toHaveBeenCalledTimes(ARC_DAYS);

    const rows = await prisma.timeline.count({
      where: { agentId: AGENT_LABEL },
    });
    expect(rows).toBe(ARC_DAYS);
  });

  it('updates (not duplicates) timelines on a second synthesis run', async () => {
    const result = await synthesisStage.run(
      (user as any).__internalUserId,
      false,
    );

    expect(result.timelinesUpdated).toBe(ARC_DAYS);
    expect(result.timelinesCreated).toBe(0);

    const rows = await prisma.timeline.count({
      where: { agentId: AGENT_LABEL },
    });
    expect(rows).toBe(ARC_DAYS); // still 14, no dupes
  });

  it('closes the arc, linking all 14 daily timelines under one arcId', async () => {
    const result = await timelineService.closeArc(AGENT_LABEL, arcId, {
      from: arcFrom,
      to: arcTo,
    });

    expect(result.arcId).toBe(arcId);
    expect(result.timelinesLinked).toBe(ARC_DAYS);

    const linked = await prisma.timeline.count({
      where: { agentId: AGENT_LABEL, arcId },
    });
    expect(linked).toBe(ARC_DAYS);
  });

  it('recalls the entire arc in chronological order', async () => {
    const arc = await timelineService.findByArc(AGENT_LABEL, arcId, 'summary');

    expect(arc).toHaveLength(ARC_DAYS);

    // Ascending chronological order.
    const dates = arc.map((t: any) => dateStr(new Date(t.agentLocalDate)));
    const expected = baseDates.map(dateStr);
    expect(dates).toEqual(expected);

    // Summary LOD projected; raw LOD columns stripped.
    expect(arc[0].text).toContain(`Summary for ${arcFrom}`);
    expect(arc[0]).not.toHaveProperty('summaryText');
    expect(arc[0]).not.toHaveProperty('indexText');
  });

  it('recalls the arc at index LOD when requested', async () => {
    const arc = await timelineService.findByArc(AGENT_LABEL, arcId, 'index');

    expect(arc).toHaveLength(ARC_DAYS);
    expect(arc[0].text).toContain(`${arcFrom}: "Day ${arcFrom}"`);
  });
});
