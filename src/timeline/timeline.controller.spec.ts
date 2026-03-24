import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

describe('TimelineController', () => {
  let controller: TimelineController;

  const mockAgent = { id: 'agent-1', accountId: 'account-1' };

  const mockTimeline = {
    id: 'tl-1',
    agentId: 'agent-1',
    agentLocalDate: new Date('2026-03-24'),
    timezone: 'UTC',
    chapter: 'Productive day',
    arcId: null,
    text: 'A productive day of coding.',
    events: [{ time: '09:00', description: 'Started coding', significance: 7, tags: ['dev'] }],
    decisions: [],
    openThreadIds: [],
    people: ['Alice'],
    mood: 'focused',
    significance: 0.8,
    memoryIds: ['mem-1', 'mem-2'],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockService = {
    upsert: jest.fn(),
    findByDateRange: jest.fn(),
    findByDate: jest.fn(),
    findByDateDeep: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TimelineController],
      providers: [
        { provide: TimelineService, useValue: mockService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TimelineController>(TimelineController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('guards', () => {
    it('should have ApiKeyOrJwtGuard and RateLimitGuard applied at class level', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, TimelineController);
      expect(guards).toContain(ApiKeyOrJwtGuard);
      expect(guards).toContain(RateLimitGuard);
    });
  });

  describe('POST /v1/timelines (upsert)', () => {
    const dto = {
      agentLocalDate: '2026-03-24',
      chapter: 'Productive day',
      indexText: '2026-03-24: "Productive day" — coding sprint. [dev]',
      summaryText: 'A productive day of coding.',
      standardText: 'Full detailed entry about the productive day.',
    };

    it('should create/upsert a timeline entry', async () => {
      mockService.upsert.mockResolvedValue({ id: 'tl-1', ...dto });
      const result = await controller.upsert(mockAgent, dto);
      expect(result).toHaveProperty('id', 'tl-1');
    });

    it('should pass agent.id to service', async () => {
      mockService.upsert.mockResolvedValue({ id: 'tl-1' });
      await controller.upsert(mockAgent, dto);
      expect(mockService.upsert).toHaveBeenCalledWith('agent-1', dto);
    });

    it('should forward optional fields in the DTO', async () => {
      const fullDto = {
        ...dto,
        timezone: 'America/New_York',
        arcId: 'arc-1',
        events: [{ description: 'test event' }],
        people: ['Bob'],
        mood: 'happy',
        significance: 0.9,
        memoryIds: ['mem-1'],
      };
      mockService.upsert.mockResolvedValue({ id: 'tl-2', ...fullDto });
      await controller.upsert(mockAgent, fullDto);
      expect(mockService.upsert).toHaveBeenCalledWith('agent-1', fullDto);
    });
  });

  describe('GET /v1/timelines (findAll)', () => {
    it('should return timelines for a date range', async () => {
      mockService.findByDateRange.mockResolvedValue([mockTimeline]);
      const result = await controller.findAll(mockAgent, {
        from: '2026-03-01',
        to: '2026-03-31',
      });
      expect(result).toHaveLength(1);
      expect(mockService.findByDateRange).toHaveBeenCalledWith('agent-1', {
        from: '2026-03-01',
        to: '2026-03-31',
      });
    });

    it('should pass lod param to service', async () => {
      mockService.findByDateRange.mockResolvedValue([]);
      await controller.findAll(mockAgent, { lod: 'index' });
      expect(mockService.findByDateRange).toHaveBeenCalledWith('agent-1', {
        lod: 'index',
      });
    });

    it('should return empty array when no results', async () => {
      mockService.findByDateRange.mockResolvedValue([]);
      const result = await controller.findAll(mockAgent, {});
      expect(result).toEqual([]);
    });
  });

  describe('GET /v1/timelines/:date (findByDate)', () => {
    it('should return a single day timeline', async () => {
      mockService.findByDate.mockResolvedValue(mockTimeline);
      const result = await controller.findByDate(mockAgent, '2026-03-24');
      expect(result).toEqual(mockTimeline);
    });

    it('should use summary as default LOD', async () => {
      mockService.findByDate.mockResolvedValue(mockTimeline);
      await controller.findByDate(mockAgent, '2026-03-24');
      expect(mockService.findByDate).toHaveBeenCalledWith(
        'agent-1',
        '2026-03-24',
        'summary',
      );
    });

    it('should apply specified lod param', async () => {
      mockService.findByDate.mockResolvedValue(mockTimeline);
      await controller.findByDate(mockAgent, '2026-03-24', 'index');
      expect(mockService.findByDate).toHaveBeenCalledWith(
        'agent-1',
        '2026-03-24',
        'index',
      );
    });

    it('should apply standard lod param', async () => {
      mockService.findByDate.mockResolvedValue(mockTimeline);
      await controller.findByDate(mockAgent, '2026-03-24', 'standard');
      expect(mockService.findByDate).toHaveBeenCalledWith(
        'agent-1',
        '2026-03-24',
        'standard',
      );
    });

    it('should throw 404 when no timeline found', async () => {
      mockService.findByDate.mockResolvedValue(null);
      await expect(
        controller.findByDate(mockAgent, '2026-01-01'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /v1/timelines/:date/deep (findDeep)', () => {
    it('should return timeline with linked memories', async () => {
      const deepResult = {
        ...mockTimeline,
        memories: [{ id: 'mem-1', raw: 'memory content' }],
      };
      mockService.findByDateDeep.mockResolvedValue(deepResult);
      const result = await controller.findDeep(mockAgent, '2026-03-24');
      expect(result).toHaveProperty('memories');
      expect(result.memories).toHaveLength(1);
    });

    it('should pass agent.id and date to service', async () => {
      mockService.findByDateDeep.mockResolvedValue({ ...mockTimeline, memories: [] });
      await controller.findDeep(mockAgent, '2026-03-24');
      expect(mockService.findByDateDeep).toHaveBeenCalledWith(
        'agent-1',
        '2026-03-24',
      );
    });

    it('should throw 404 when no timeline found for deep', async () => {
      mockService.findByDateDeep.mockResolvedValue(null);
      await expect(
        controller.findDeep(mockAgent, '2026-01-01'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /v1/timelines/team (teamAggregate)', () => {
    it('should return 501 not implemented', async () => {
      const result = await controller.teamAggregate({});
      expect(result).toEqual({
        statusCode: 501,
        message: 'Team timeline not yet implemented',
      });
    });

    it('should accept date and arc query params', async () => {
      const result = await controller.teamAggregate({
        date: '2026-03-24',
        arc: 'arc-1',
      });
      expect(result.statusCode).toBe(501);
    });
  });
});
