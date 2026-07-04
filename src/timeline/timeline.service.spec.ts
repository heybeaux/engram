import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import {
  TimelineService,
  resolveArcTitle,
  ArcSearchResult,
} from './timeline.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';

describe('TimelineService', () => {
  let service: TimelineService;
  let prisma: any;

  const agentId = 'agent-1';

  const mockTimelineRecord = {
    id: 'tl-1',
    agentId: 'agent-1',
    agentLocalDate: new Date('2026-03-22'),
    timezone: 'UTC',
    chapter: 'Productive day',
    arcId: null,
    indexText: '2026-03-22: "Productive day" — shipped features. [dev]',
    summaryText: 'A productive day of shipping features and fixing bugs.',
    standardText:
      'Full detailed entry about the productive day with all events and decisions.',
    events: [
      {
        time: '09:00',
        description: 'Standup',
        significance: 3,
        tags: ['standup'],
      },
    ],
    decisions: [],
    openThreadIds: [],
    people: ['Alice'],
    mood: 'focused',
    significance: 0.8,
    memoryIds: ['mem-1', 'mem-2'],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    prisma = {
      timeline: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      memory: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: EmbeddingService,
          useValue: { embed: jest.fn().mockResolvedValue([[0.1]]) },
        },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
      ],
    }).compile();

    service = module.get<TimelineService>(TimelineService);
    jest.clearAllMocks();
  });

  describe('upsert', () => {
    const dto = {
      agentLocalDate: '2026-03-22',
      chapter: 'Productive day',
      indexText: '2026-03-22: "Productive day" — shipped features. [dev]',
      summaryText: 'A productive day.',
      standardText: 'Full entry.',
    };

    it('should upsert a timeline with parsed date', async () => {
      prisma.timeline.upsert.mockResolvedValue({ id: 'tl-1', ...dto });

      const result = await service.upsert(agentId, dto);

      expect(result).toHaveProperty('id', 'tl-1');
      expect(prisma.timeline.upsert).toHaveBeenCalledTimes(1);
    });

    it('should pass correct where clause with composite key', async () => {
      prisma.timeline.upsert.mockResolvedValue({ id: 'tl-1' });

      await service.upsert(agentId, dto);

      const call = prisma.timeline.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        agentId_agentLocalDate: {
          agentId: 'agent-1',
          agentLocalDate: new Date('2026-03-22'),
        },
      });
    });

    it('should default optional fields when not provided', async () => {
      prisma.timeline.upsert.mockResolvedValue({ id: 'tl-1' });

      await service.upsert(agentId, dto);

      const call = prisma.timeline.upsert.mock.calls[0][0];
      expect(call.create.timezone).toBe('UTC');
      expect(call.create.events).toEqual([]);
      expect(call.create.decisions).toEqual([]);
      expect(call.create.openThreadIds).toEqual([]);
      expect(call.create.people).toEqual([]);
      expect(call.create.significance).toBe(0.5);
      expect(call.create.memoryIds).toEqual([]);
    });

    it('should use provided optional fields', async () => {
      const fullDto = {
        ...dto,
        timezone: 'America/New_York',
        arcId: 'arc-1',
        events: [{ description: 'test' }],
        decisions: [{ description: 'decide' }],
        openThreadIds: ['thread-1'],
        people: ['Bob'],
        mood: 'happy',
        significance: 0.9,
        memoryIds: ['mem-1'],
      };
      prisma.timeline.upsert.mockResolvedValue({ id: 'tl-1' });

      await service.upsert(agentId, fullDto);

      const call = prisma.timeline.upsert.mock.calls[0][0];
      expect(call.create.timezone).toBe('America/New_York');
      expect(call.create.arcId).toBe('arc-1');
      expect(call.create.events).toEqual([{ description: 'test' }]);
      expect(call.create.people).toEqual(['Bob']);
      expect(call.create.mood).toBe('happy');
      expect(call.create.significance).toBe(0.9);
      expect(call.create.memoryIds).toEqual(['mem-1']);
    });

    it('should throw BadRequestException on invalid date', async () => {
      const badDto = { ...dto, agentLocalDate: 'not-a-date' };

      await expect(service.upsert(agentId, badDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should set same data for create and update', async () => {
      prisma.timeline.upsert.mockResolvedValue({ id: 'tl-1' });

      await service.upsert(agentId, dto);

      const call = prisma.timeline.upsert.mock.calls[0][0];
      expect(call.create).toEqual(call.update);
    });
  });

  describe('findByDateRange', () => {
    it('should return timelines with LOD applied', async () => {
      prisma.timeline.findMany.mockResolvedValue([mockTimelineRecord]);

      const result = await service.findByDateRange(agentId, {
        from: '2026-03-01',
        to: '2026-03-31',
        lod: 'summary',
      });

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe(mockTimelineRecord.summaryText);
      // LOD fields should be stripped
      expect(result[0]).not.toHaveProperty('indexText');
      expect(result[0]).not.toHaveProperty('summaryText');
      expect(result[0]).not.toHaveProperty('standardText');
    });

    it('should default to summary LOD when not specified', async () => {
      prisma.timeline.findMany.mockResolvedValue([mockTimelineRecord]);

      const result = await service.findByDateRange(agentId, {});

      expect(result[0].text).toBe(mockTimelineRecord.summaryText);
    });

    it('should apply index LOD', async () => {
      prisma.timeline.findMany.mockResolvedValue([mockTimelineRecord]);

      const result = await service.findByDateRange(agentId, { lod: 'index' });

      expect(result[0].text).toBe(mockTimelineRecord.indexText);
    });

    it('should apply standard LOD', async () => {
      prisma.timeline.findMany.mockResolvedValue([mockTimelineRecord]);

      const result = await service.findByDateRange(agentId, {
        lod: 'standard',
      });

      expect(result[0].text).toBe(mockTimelineRecord.standardText);
    });

    it('should fallback to summaryText for unknown LOD', async () => {
      prisma.timeline.findMany.mockResolvedValue([mockTimelineRecord]);

      const result = await service.findByDateRange(agentId, {
        lod: 'unknown' as any,
      });

      expect(result[0].text).toBe(mockTimelineRecord.summaryText);
    });

    it('should filter by from date only', async () => {
      prisma.timeline.findMany.mockResolvedValue([]);

      await service.findByDateRange(agentId, { from: '2026-03-01' });

      const call = prisma.timeline.findMany.mock.calls[0][0];
      expect(call.where.agentLocalDate.gte).toEqual(new Date('2026-03-01'));
      expect(call.where.agentLocalDate).not.toHaveProperty('lte');
    });

    it('should filter by to date only', async () => {
      prisma.timeline.findMany.mockResolvedValue([]);

      await service.findByDateRange(agentId, { to: '2026-03-31' });

      const call = prisma.timeline.findMany.mock.calls[0][0];
      expect(call.where.agentLocalDate.lte).toEqual(new Date('2026-03-31'));
      expect(call.where.agentLocalDate).not.toHaveProperty('gte');
    });

    it('should not set date filter when neither from nor to', async () => {
      prisma.timeline.findMany.mockResolvedValue([]);

      await service.findByDateRange(agentId, {});

      const call = prisma.timeline.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ agentId: 'agent-1' });
    });

    it('should order results by agentLocalDate desc', async () => {
      prisma.timeline.findMany.mockResolvedValue([]);

      await service.findByDateRange(agentId, {});

      const call = prisma.timeline.findMany.mock.calls[0][0];
      expect(call.orderBy).toEqual({ agentLocalDate: 'desc' });
    });

    it('should return empty array when no results', async () => {
      prisma.timeline.findMany.mockResolvedValue([]);

      const result = await service.findByDateRange(agentId, {});

      expect(result).toEqual([]);
    });

    it('should filter by arcId when provided', async () => {
      prisma.timeline.findMany.mockResolvedValue([]);

      await service.findByDateRange(agentId, { arcId: 'arc-42' });

      const call = prisma.timeline.findMany.mock.calls[0][0];
      expect(call.where.arcId).toBe('arc-42');
    });
  });

  describe('findByArc', () => {
    it('should return all timelines for an arc ordered ascending', async () => {
      prisma.timeline.findMany.mockResolvedValue([mockTimelineRecord]);

      const result = await service.findByArc(agentId, 'arc-1', 'summary');

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe(mockTimelineRecord.summaryText);
      const call = prisma.timeline.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ agentId: 'agent-1', arcId: 'arc-1' });
      expect(call.orderBy).toEqual({ agentLocalDate: 'asc' });
    });

    it('should default to summary LOD', async () => {
      prisma.timeline.findMany.mockResolvedValue([mockTimelineRecord]);

      const result = await service.findByArc(agentId, 'arc-1');

      expect(result[0].text).toBe(mockTimelineRecord.summaryText);
    });

    it('should return empty array for an arc with no timelines', async () => {
      prisma.timeline.findMany.mockResolvedValue([]);

      const result = await service.findByArc(agentId, 'arc-empty');

      expect(result).toEqual([]);
    });
  });

  describe('closeArc', () => {
    it('should stamp arcId across the date range and report count', async () => {
      prisma.timeline.updateMany.mockResolvedValue({ count: 14 });

      const result = await service.closeArc(agentId, 'arc-1', {
        from: '2026-03-01',
        to: '2026-03-14',
      });

      expect(result).toEqual({ arcId: 'arc-1', timelinesLinked: 14 });
      const call = prisma.timeline.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({
        agentId: 'agent-1',
        agentLocalDate: {
          gte: new Date('2026-03-01'),
          lte: new Date('2026-03-14'),
        },
      });
      expect(call.data).toEqual({ arcId: 'arc-1' });
    });

    it('should throw BadRequestException when from is after to', async () => {
      await expect(
        service.closeArc(agentId, 'arc-1', {
          from: '2026-03-14',
          to: '2026-03-01',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.timeline.updateMany).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException on invalid date', async () => {
      await expect(
        service.closeArc(agentId, 'arc-1', { from: 'nope', to: '2026-03-01' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findByDate', () => {
    it('should return timeline with LOD applied', async () => {
      prisma.timeline.findUnique.mockResolvedValue(mockTimelineRecord);

      const result = await service.findByDate(agentId, '2026-03-22', 'index');

      expect(result).not.toBeNull();
      expect(result!.text).toBe(mockTimelineRecord.indexText);
    });

    it('should default to summary LOD', async () => {
      prisma.timeline.findUnique.mockResolvedValue(mockTimelineRecord);

      const result = await service.findByDate(agentId, '2026-03-22');

      expect(result!.text).toBe(mockTimelineRecord.summaryText);
    });

    it('should return null when not found', async () => {
      prisma.timeline.findUnique.mockResolvedValue(null);

      const result = await service.findByDate(agentId, '2026-01-01');

      expect(result).toBeNull();
    });

    it('should query with composite key', async () => {
      prisma.timeline.findUnique.mockResolvedValue(null);

      await service.findByDate(agentId, '2026-03-22');

      expect(prisma.timeline.findUnique).toHaveBeenCalledWith({
        where: {
          agentId_agentLocalDate: {
            agentId: 'agent-1',
            agentLocalDate: new Date('2026-03-22'),
          },
        },
      });
    });

    it('should throw BadRequestException on invalid date', async () => {
      await expect(service.findByDate(agentId, 'garbage')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('findByDateDeep', () => {
    it('should return timeline with resolved memories', async () => {
      prisma.timeline.findUnique.mockResolvedValue(mockTimelineRecord);
      prisma.memory.findMany.mockResolvedValue([
        { id: 'mem-1', raw: 'First memory' },
        { id: 'mem-2', raw: 'Second memory' },
      ]);

      const result = await service.findByDateDeep(agentId, '2026-03-22');

      expect(result).not.toBeNull();
      expect(result!.memories).toHaveLength(2);
      expect(result!.memories[0]).toHaveProperty('raw', 'First memory');
    });

    it('should fetch memories by memoryIds', async () => {
      prisma.timeline.findUnique.mockResolvedValue(mockTimelineRecord);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findByDateDeep(agentId, '2026-03-22');

      expect(prisma.memory.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['mem-1', 'mem-2'] } },
      });
    });

    it('should return null when timeline not found', async () => {
      prisma.timeline.findUnique.mockResolvedValue(null);

      const result = await service.findByDateDeep(agentId, '2026-01-01');

      expect(result).toBeNull();
      expect(prisma.memory.findMany).not.toHaveBeenCalled();
    });

    it('should return empty memories array when memoryIds is empty', async () => {
      const noMemoryTimeline = { ...mockTimelineRecord, memoryIds: [] };
      prisma.timeline.findUnique.mockResolvedValue(noMemoryTimeline);

      const result = await service.findByDateDeep(agentId, '2026-03-22');

      expect(result!.memories).toEqual([]);
      expect(prisma.memory.findMany).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException on invalid date', async () => {
      await expect(service.findByDateDeep(agentId, 'bad-date')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});

/**
 * Unit tests for TimelineService.searchArcs (ENG-165 / arc search, Phase 1).
 *
 * Prisma + the embedding service are fully mocked so the grouping /
 * aggregation / title-resolution logic is exercised hermetically.
 */
describe('TimelineService.searchArcs', () => {
  let service: TimelineService;
  let mockPrisma: any;
  let mockEmbedding: jest.Mocked<Pick<EmbeddingService, 'embed'>>;
  let mockConfig: any;

  const QUERY_VEC = new Array(768).fill(0.1);

  // Helper: a semantic candidate row as returned by $queryRawUnsafe.
  const semanticRow = (over: Partial<any> = {}) => ({
    arcId: 'arc-a',
    agentLocalDate: new Date('2026-03-01'),
    chapter: 'Chapter A',
    significance: 5,
    indexText: 'idx',
    summaryText: 'sum',
    standardText: 'std',
    score: 0.5,
    ...over,
  });

  const buildModule = async (configValues: Record<string, string> = {}) => {
    mockConfig = {
      get: jest.fn(
        (key: string, def?: string) => configValues[key] ?? def ?? undefined,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbeddingService, useValue: mockEmbedding },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    return module.get<TimelineService>(TimelineService);
  };

  beforeEach(async () => {
    mockPrisma = {
      $queryRawUnsafe: jest.fn(),
      timeline: { findMany: jest.fn() },
    };
    mockEmbedding = {
      embed: jest.fn().mockResolvedValue([QUERY_VEC]),
    };
    service = await buildModule();
  });

  it('rejects an empty search (query/from/to all absent) with BadRequest', async () => {
    await expect(service.searchArcs('agent-1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockEmbedding.embed).not.toHaveBeenCalled();
  });

  it('rejects from > to with BadRequest', async () => {
    await expect(
      service.searchArcs('agent-1', {
        from: '2026-05-01',
        to: '2026-01-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('embeds the query and passes the vector as a bound parameter (not interpolated)', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([semanticRow()]);

    await service.searchArcs('agent-1', { query: 'whalehawk launch' });

    expect(mockEmbedding.embed).toHaveBeenCalledWith(['whalehawk launch']);
    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    // Vector is a bound param ($2), never concatenated into the SQL text.
    expect(sql).not.toContain('0.1,0.1');
    expect(sql).toContain('$2::vector');
    expect(params[0]).toBe('agent-1');
    expect(params[1]).toBe(`[${QUERY_VEC.join(',')}]`);
  });

  it('calendar-only path skips embedding and queries via findMany', async () => {
    mockPrisma.timeline.findMany.mockResolvedValue([
      {
        arcId: 'arc-a',
        agentLocalDate: new Date('2026-03-05'),
        chapter: 'Chapter A',
        significance: 7,
        indexText: 'i',
        summaryText: 's',
        standardText: 'st',
      },
    ]);

    const res = await service.searchArcs('agent-1', {
      from: '2026-03-01',
      to: '2026-03-31',
    });

    expect(mockEmbedding.embed).not.toHaveBeenCalled();
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(mockPrisma.timeline.findMany).toHaveBeenCalled();
    expect(res.arcs).toHaveLength(1);
    expect(res.arcs[0].arcId).toBe('arc-a');
  });

  it('orders calendar-only arcs by `to` descending (recency)', async () => {
    mockPrisma.timeline.findMany.mockResolvedValue([
      {
        arcId: 'arc-old',
        agentLocalDate: new Date('2026-01-10'),
        chapter: 'Old',
        significance: 9,
        indexText: 'i',
        summaryText: 's',
        standardText: 'st',
      },
      {
        arcId: 'arc-new',
        agentLocalDate: new Date('2026-03-10'),
        chapter: 'New',
        significance: 1,
        indexText: 'i',
        summaryText: 's',
        standardText: 'st',
      },
    ]);

    const res = await service.searchArcs('agent-1', { from: '2026-01-01' });

    expect(res.arcs.map((a: ArcSearchResult) => a.arcId)).toEqual([
      'arc-new',
      'arc-old',
    ]);
  });

  it('aggregates score with max by default', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      semanticRow({ arcId: 'arc-a', score: 0.9 }),
      semanticRow({ arcId: 'arc-a', score: 0.3 }),
    ]);

    const res = await service.searchArcs('agent-1', { query: 'x' });

    expect(res.arcs).toHaveLength(1);
    expect(res.arcs[0].score).toBeCloseTo(0.9);
  });

  it('aggregates score with mean when ARC_SCORE_AGG=mean', async () => {
    service = await buildModule({ ARC_SCORE_AGG: 'mean' });
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      semanticRow({ arcId: 'arc-a', score: 0.9 }),
      semanticRow({ arcId: 'arc-a', score: 0.3 }),
    ]);

    const res = await service.searchArcs('agent-1', { query: 'x' });

    expect(res.arcs[0].score).toBeCloseTo(0.6);
  });

  it('computes from / to / dayCount across an arc span', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      semanticRow({
        arcId: 'arc-a',
        agentLocalDate: new Date('2026-03-01'),
        score: 0.4,
      }),
      semanticRow({
        arcId: 'arc-a',
        agentLocalDate: new Date('2026-03-20'),
        score: 0.8,
      }),
      semanticRow({
        arcId: 'arc-a',
        agentLocalDate: new Date('2026-03-10'),
        score: 0.6,
      }),
    ]);

    const res = await service.searchArcs('agent-1', { query: 'x' });

    expect(res.arcs[0].from).toBe('2026-03-01');
    expect(res.arcs[0].to).toBe('2026-03-20');
    expect(res.arcs[0].dayCount).toBe(3);
  });

  it('ranks the arc with the most-relevant day first (max aggregation)', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      semanticRow({ arcId: 'arc-a', score: 0.95 }),
      semanticRow({ arcId: 'arc-b', score: 0.6 }),
      semanticRow({ arcId: 'arc-b', score: 0.55 }),
    ]);

    const res = await service.searchArcs('agent-1', { query: 'x' });

    expect(res.arcs.map((a: ArcSearchResult) => a.arcId)).toEqual([
      'arc-a',
      'arc-b',
    ]);
  });

  it('returns the representative summary at the requested LOD from the top day', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      semanticRow({
        arcId: 'arc-a',
        score: 0.9,
        indexText: 'TOP-INDEX',
        summaryText: 'TOP-SUMMARY',
        standardText: 'TOP-STANDARD',
      }),
      semanticRow({ arcId: 'arc-a', score: 0.2, summaryText: 'other' }),
    ]);

    const summaryRes = await service.searchArcs('agent-1', {
      query: 'x',
      lod: 'summary',
    });
    expect(summaryRes.arcs[0].summary).toBe('TOP-SUMMARY');

    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      semanticRow({
        arcId: 'arc-a',
        score: 0.9,
        indexText: 'TOP-INDEX',
        standardText: 'TOP-STANDARD',
      }),
    ]);
    const stdRes = await service.searchArcs('agent-1', {
      query: 'x',
      lod: 'standard',
    });
    expect(stdRes.arcs[0].summary).toBe('TOP-STANDARD');
  });

  it('returns an empty result set when no candidate days match', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    const res = await service.searchArcs('agent-1', { query: 'nothing' });
    expect(res.arcs).toEqual([]);
  });

  it('clamps the number of returned arcs to `limit`', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      semanticRow({ arcId: 'arc-a', score: 0.9 }),
      semanticRow({ arcId: 'arc-b', score: 0.8 }),
      semanticRow({ arcId: 'arc-c', score: 0.7 }),
    ]);

    const res = await service.searchArcs('agent-1', { query: 'x', limit: 2 });

    expect(res.arcs).toHaveLength(2);
    expect(res.arcs.map((a: ArcSearchResult) => a.arcId)).toEqual([
      'arc-a',
      'arc-b',
    ]);
  });

  it('adds the date window as bound params on the semantic path', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([semanticRow()]);

    await service.searchArcs('agent-1', {
      query: 'x',
      from: '2026-03-01',
      to: '2026-03-31',
    });

    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('"agentLocalDate" >= $3');
    expect(sql).toContain('"agentLocalDate" <= $4');
    expect(params[2]).toEqual(new Date('2026-03-01'));
    expect(params[3]).toEqual(new Date('2026-03-31'));
  });
});

describe('resolveArcTitle', () => {
  it('uses a chapter shared by every member day', () => {
    const title = resolveArcTitle(
      [
        { chapter: 'WhaleHawk', significance: 3 },
        { chapter: 'WhaleHawk', significance: 8 },
      ],
      '2026-03-01',
      '2026-03-10',
    );
    expect(title).toBe('WhaleHawk');
  });

  it('falls back to the highest-significance day chapter when chapters differ', () => {
    const title = resolveArcTitle(
      [
        { chapter: 'Onboarding', significance: 2 },
        { chapter: 'Launch push', significance: 9 },
      ],
      '2026-03-01',
      '2026-03-10',
    );
    expect(title).toBe('Launch push');
  });

  it('falls back to "Arc {from}-{to}" when no chapters are present', () => {
    const title = resolveArcTitle(
      [
        { chapter: '', significance: 2 },
        { chapter: null, significance: 9 },
      ],
      '2026-03-01',
      '2026-03-10',
    );
    expect(title).toBe('Arc 2026-03-01\u20132026-03-10');
  });
});
