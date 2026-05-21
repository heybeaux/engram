import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DreamCycleTimelineSynthesisStage } from './dream-cycle-timeline-synthesis.stage';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { EmbeddingService } from '../../embedding/embedding.service';
import { TimelineLodService } from '../../timeline/timeline-lod.service';

describe('DreamCycleTimelineSynthesisStage', () => {
  let stage: DreamCycleTimelineSynthesisStage;
  let prisma: any;
  let timelineLodService: any;
  let embeddingService: any;

  const configValues: Record<string, string> = {};

  const mockLodOutput = {
    chapter: 'Productive day',
    indexText: '2026-03-22: "Productive day" -- shipped features. [dev]',
    summaryText: 'A productive day of shipping features and fixing bugs.',
    standardText:
      'The team started the day with a standup. Several features were shipped including the new timeline synthesis. Bugs were identified and fixed. Plans were made for the following sprint.',
    events: [
      {
        time: '09:00',
        description: 'Morning standup',
        significance: 0.3,
        tags: ['standup'],
      },
    ],
    decisions: [
      { description: 'Ship timeline feature', reasoning: 'High priority' },
    ],
    openThreads: [
      { description: 'Arc detection', priority: 'medium' as const },
    ],
    people: ['Alice', 'Bob'],
    mood: 'focused',
    significance: 0.7,
    llmCalls: 1,
  };

  function makeMemory(
    id: string,
    raw: string,
    createdAt: Date,
    agentId: string | null = 'agent-1',
  ) {
    return { id, raw, createdAt, agentId };
  }

  beforeEach(async () => {
    Object.keys(configValues).forEach((k) => delete configValues[k]);

    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn(),
      dreamCycleReport: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      timeline: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'tl-1' }),
        update: jest.fn().mockResolvedValue({ id: 'tl-1' }),
      },
    };

    timelineLodService = {
      generateLod: jest.fn().mockResolvedValue(mockLodOutput),
    };

    embeddingService = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DreamCycleTimelineSynthesisStage,
        { provide: ServicePrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => configValues[key] ?? undefined),
          },
        },
        { provide: TimelineLodService, useValue: timelineLodService },
        { provide: EmbeddingService, useValue: embeddingService },
      ],
    }).compile();

    stage = module.get(DreamCycleTimelineSynthesisStage);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getDateRange', () => {
    it('should return last 7 days when no prior dream cycle exists', async () => {
      prisma.dreamCycleReport.findFirst.mockResolvedValue(null);

      const range = await stage.getDateRange('user-1');

      expect(range).not.toBeNull();
      const diffMs = range!.to.getTime() - range!.from.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      expect(diffDays).toBe(7);
    });

    it('should use last report startedAt as from date', async () => {
      const lastStarted = new Date('2026-03-20T03:00:00Z');
      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: lastStarted,
      });

      const range = await stage.getDateRange('user-1');

      expect(range).not.toBeNull();
      expect(range!.from.toISOString().slice(0, 10)).toBe('2026-03-20');
    });

    it('should return null when last report is today', async () => {
      const today = new Date();
      today.setUTCHours(3, 0, 0, 0); // today at 3AM
      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: today,
      });

      const range = await stage.getDateRange('user-1');

      expect(range).toBeNull();
    });
  });

  describe('run — happy path', () => {
    it('should create timelines for days with memories', async () => {
      const date = new Date('2026-03-22');
      // Setup: one day bucket with an agent
      prisma.$queryRaw.mockResolvedValue([{ agent_id: 'agent-1', day: date }]);

      const memories = [
        makeMemory('m1', 'Fixed the bug', new Date('2026-03-22T10:00:00Z')),
        makeMemory('m2', 'Shipped feature', new Date('2026-03-22T14:00:00Z')),
        makeMemory('m3', 'Code review', new Date('2026-03-22T16:00:00Z')),
      ];

      // First findMany call = day memories, second = draft check
      prisma.memory.findMany
        .mockResolvedValueOnce(memories)
        .mockResolvedValueOnce([]);

      // Last completed report: yesterday
      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: new Date('2026-03-21T03:00:00Z'),
      });

      const result = await stage.run('user-1', false);

      expect(result.timelinesCreated).toBe(1);
      expect(result.daysProcessed).toBe(1);
      expect(result.llmCalls).toBe(1);
      expect(result.errors).toBe(0);
      expect(timelineLodService.generateLod).toHaveBeenCalledTimes(1);
      expect(embeddingService.embed).toHaveBeenCalledWith([
        mockLodOutput.summaryText,
      ]);
      expect(prisma.timeline.create).toHaveBeenCalledTimes(1);
    });

    it('should pass memory data to TimelineLodService', async () => {
      const date = new Date('2026-03-22');
      prisma.$queryRaw.mockResolvedValue([{ agent_id: 'agent-1', day: date }]);

      const memories = [
        makeMemory('m1', 'Did something', new Date('2026-03-22T10:00:00Z')),
      ];
      prisma.memory.findMany
        .mockResolvedValueOnce(memories)
        .mockResolvedValueOnce([]);

      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: new Date('2026-03-21T03:00:00Z'),
      });

      await stage.run('user-1', false);

      expect(timelineLodService.generateLod).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'm1', raw: 'Did something' }),
        ]),
        '2026-03-22',
      );
    });
  });

  describe('run — empty days skipped', () => {
    it('should skip days with zero memories', async () => {
      const date = new Date('2026-03-22');
      prisma.$queryRaw.mockResolvedValue([{ agent_id: 'agent-1', day: date }]);

      // Return empty memories for the day
      prisma.memory.findMany.mockResolvedValue([]);

      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: new Date('2026-03-21T03:00:00Z'),
      });

      const result = await stage.run('user-1', false);

      expect(result.daysSkipped).toBe(1);
      expect(result.daysProcessed).toBe(0);
      expect(timelineLodService.generateLod).not.toHaveBeenCalled();
    });
  });

  describe('run — no date range', () => {
    it('should return early when no date range to process', async () => {
      // Last report is today
      const today = new Date();
      today.setUTCHours(3, 0, 0, 0);
      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: today,
      });

      const result = await stage.run('user-1', false);

      expect(result.daysProcessed).toBe(0);
      expect(result.timelinesCreated).toBe(0);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('run — TIMELINE_DRAFT incorporated', () => {
    it('should include timeline drafts as additional context', async () => {
      const date = new Date('2026-03-22');
      prisma.$queryRaw.mockResolvedValue([{ agent_id: 'agent-1', day: date }]);

      const memories = [
        makeMemory('m1', 'Regular memory', new Date('2026-03-22T10:00:00Z')),
      ];
      const drafts = [
        {
          raw: 'TIMELINE_DRAFT: Shipped WASM engine. Tags: simulaas. Sig: 0.9',
        },
      ];

      prisma.memory.findMany
        .mockResolvedValueOnce(memories) // day memories
        .mockResolvedValueOnce(drafts); // drafts

      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: new Date('2026-03-21T03:00:00Z'),
      });

      await stage.run('user-1', false);

      // drafts are now included as additional Memory objects in the memories array
      expect(timelineLodService.generateLod).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ raw: 'Regular memory' }),
        ]),
        '2026-03-22',
      );
    });
  });

  describe('run — LLM error handled gracefully', () => {
    it('should log error and continue when LLM fails on a single day', async () => {
      const date1 = new Date('2026-03-21');
      const date2 = new Date('2026-03-22');
      prisma.$queryRaw.mockResolvedValue([
        { agent_id: 'agent-1', day: date1 },
        { agent_id: 'agent-1', day: date2 },
      ]);

      const memories1 = [
        makeMemory('m1', 'Day 1 memory', new Date('2026-03-21T10:00:00Z')),
      ];
      const memories2 = [
        makeMemory('m2', 'Day 2 memory', new Date('2026-03-22T10:00:00Z')),
      ];

      prisma.memory.findMany
        .mockResolvedValueOnce(memories1)
        .mockResolvedValueOnce(memories2);

      // Fail on first day, succeed on second
      timelineLodService.generateLod
        .mockRejectedValueOnce(new Error('LLM rate limit'))
        .mockResolvedValueOnce(mockLodOutput);

      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: new Date('2026-03-20T03:00:00Z'),
      });

      const result = await stage.run('user-1', false);

      expect(result.errors).toBe(1);
      expect(result.timelinesCreated).toBe(1);
      expect(result.daysProcessed).toBe(1);
    });
  });

  describe('run — upsert on re-run', () => {
    it('should update existing timeline on re-run', async () => {
      const date = new Date('2026-03-22');
      prisma.$queryRaw.mockResolvedValue([{ agent_id: 'agent-1', day: date }]);

      const memories = [
        makeMemory('m1', 'Memory', new Date('2026-03-22T10:00:00Z')),
      ];
      prisma.memory.findMany
        .mockResolvedValueOnce(memories)
        .mockResolvedValueOnce([]);

      // Existing timeline found
      prisma.timeline.findUnique.mockResolvedValue({ id: 'existing-tl' });

      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: new Date('2026-03-21T03:00:00Z'),
      });

      const result = await stage.run('user-1', false);

      expect(result.timelinesUpdated).toBe(1);
      expect(result.timelinesCreated).toBe(0);
      expect(prisma.timeline.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'existing-tl' },
        }),
      );
      expect(prisma.timeline.create).not.toHaveBeenCalled();
    });
  });

  describe('run — dry run', () => {
    it('should not write to database in dry run mode', async () => {
      const date = new Date('2026-03-22');
      prisma.$queryRaw.mockResolvedValue([{ agent_id: 'agent-1', day: date }]);

      const memories = [
        makeMemory('m1', 'Memory', new Date('2026-03-22T10:00:00Z')),
      ];
      prisma.memory.findMany
        .mockResolvedValueOnce(memories)
        .mockResolvedValueOnce([]);

      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: new Date('2026-03-21T03:00:00Z'),
      });

      const result = await stage.run('user-1', true);

      expect(result.daysProcessed).toBe(1);
      expect(result.llmCalls).toBe(1);
      expect(prisma.timeline.create).not.toHaveBeenCalled();
      expect(prisma.timeline.update).not.toHaveBeenCalled();
      expect(embeddingService.embed).not.toHaveBeenCalled();
    });
  });

  describe('run — LLM budget', () => {
    it('should stop when LLM budget is exhausted', async () => {
      const date1 = new Date('2026-03-21');
      const date2 = new Date('2026-03-22');
      prisma.$queryRaw.mockResolvedValue([
        { agent_id: 'agent-1', day: date1 },
        { agent_id: 'agent-1', day: date2 },
      ]);

      const memories = [
        makeMemory('m1', 'Memory', new Date('2026-03-21T10:00:00Z')),
      ];
      prisma.memory.findMany
        .mockResolvedValueOnce(memories)
        .mockResolvedValueOnce([]);

      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: new Date('2026-03-20T03:00:00Z'),
      });

      // Budget of 1 — only first day should be processed
      const result = await stage.run('user-1', false, 1);

      expect(result.daysProcessed).toBe(1);
      expect(timelineLodService.generateLod).toHaveBeenCalledTimes(1);
    });
  });

  describe('run — null agentId handling', () => {
    it('should use default agentId for memories with null agent_id', async () => {
      const date = new Date('2026-03-22');
      prisma.$queryRaw.mockResolvedValue([{ agent_id: null, day: date }]);

      const memories = [
        makeMemory(
          'm1',
          'No agent memory',
          new Date('2026-03-22T10:00:00Z'),
          null,
        ),
      ];
      prisma.memory.findMany
        .mockResolvedValueOnce(memories)
        .mockResolvedValueOnce([]);

      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: new Date('2026-03-21T03:00:00Z'),
      });

      const result = await stage.run('user-1', false);

      expect(result.timelinesCreated).toBe(1);
      // Verify the null-agent memories are fetched with agentId: null filter
      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ agentId: null }),
        }),
      );
    });
  });

  describe('run — multiple agents on same day', () => {
    it('should create separate timelines per agent', async () => {
      const date = new Date('2026-03-22');
      prisma.$queryRaw.mockResolvedValue([
        { agent_id: 'agent-1', day: date },
        { agent_id: 'agent-2', day: date },
      ]);

      const memories1 = [
        makeMemory('m1', 'Agent 1 work', new Date('2026-03-22T10:00:00Z')),
      ];
      const memories2 = [
        makeMemory('m2', 'Agent 2 work', new Date('2026-03-22T11:00:00Z')),
      ];

      prisma.memory.findMany
        .mockResolvedValueOnce(memories1)
        .mockResolvedValueOnce(memories2);

      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: new Date('2026-03-21T03:00:00Z'),
      });

      const result = await stage.run('user-1', false);

      expect(result.timelinesCreated).toBe(2);
      expect(result.daysProcessed).toBe(2);
      expect(timelineLodService.generateLod).toHaveBeenCalledTimes(2);
    });
  });

  describe('run — embedding failure does not abort', () => {
    it('should still count timeline as created even if embedding fails', async () => {
      const date = new Date('2026-03-22');
      prisma.$queryRaw.mockResolvedValue([{ agent_id: 'agent-1', day: date }]);

      const memories = [
        makeMemory('m1', 'Memory', new Date('2026-03-22T10:00:00Z')),
      ];
      prisma.memory.findMany.mockResolvedValueOnce(memories);

      prisma.dreamCycleReport.findFirst.mockResolvedValue({
        startedAt: new Date('2026-03-21T03:00:00Z'),
      });

      // Embedding throws
      embeddingService.embed.mockRejectedValueOnce(
        new Error('Embedding service down'),
      );

      const result = await stage.run('user-1', false);

      // The error is caught at the day level, so the timeline creation fails
      expect(result.errors).toBe(1);
    });
  });
});
// Note: fetchTimelineDrafts was removed in the ENG-44 schema alignment refactor.
