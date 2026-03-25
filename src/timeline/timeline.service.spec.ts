import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { PrismaService } from '../prisma/prisma.service';

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
      { time: '09:00', description: 'Standup', significance: 3, tags: ['standup'] },
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
      },
      memory: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineService,
        { provide: PrismaService, useValue: prisma },
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
      await expect(
        service.findByDate(agentId, 'garbage'),
      ).rejects.toThrow(BadRequestException);
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
      await expect(
        service.findByDateDeep(agentId, 'bad-date'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
