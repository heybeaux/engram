import { MemoryQueryController } from './memory-query.controller';
import { MemoryService } from './memory.service';
import { MemoryQueryService } from './memory-query.service';
import { ContextualRecallService } from './contextual-recall.service';
import { TemporalGapService } from './temporal-gap.service';
import { ProjectStateService } from './project-state.service';

describe('MemoryQueryController', () => {
  let controller: MemoryQueryController;
  let memoryService: jest.Mocked<MemoryService>;
  let memoryQueryService: jest.Mocked<MemoryQueryService>;
  let contextualRecallService: jest.Mocked<ContextualRecallService>;
  let temporalGapService: jest.Mocked<TemporalGapService>;
  let projectStateService: jest.Mocked<ProjectStateService>;

  const userId = 'user-123';

  beforeEach(() => {
    memoryService = {
      recall: jest.fn(),
      getGraphData: jest.fn(),
      loadContext: jest.fn(),
      findContradictions: jest.fn(),
    } as any;

    contextualRecallService = {
      recall: jest.fn(),
    } as any;

    temporalGapService = {
      detectGaps: jest.fn(),
    } as any;

    const prismaService = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;

    const retrievalSignals = {
      logQuery: jest.fn().mockResolvedValue('query-id'),
    } as any;

    projectStateService = {
      synthesize: jest.fn(),
    } as any;

    memoryQueryService = {
      traceTimeline: jest.fn(),
    } as any;

    controller = new MemoryQueryController(
      memoryService,
      memoryQueryService,
      contextualRecallService,
      temporalGapService,
      prismaService,
      retrievalSignals,
      projectStateService,
    );
  });

  describe('recall', () => {
    it('should search memories', async () => {
      const dto = { query: 'test' } as any;
      const expected = { memories: [], total: 0 };
      memoryService.recall.mockResolvedValue(expected as any);

      const req = { isInstanceKey: false };
      const res = { set: jest.fn() } as any;
      const result = await controller.recall(userId, dto, req, res);

      expect(result).toEqual(expected);
      expect(memoryService.recall).toHaveBeenCalledWith(userId, dto);
    });

    // ENG-134: structured response format
    describe('response format switching (ENG-134)', () => {
      const createdAt = new Date('2026-05-21T14:32:11.000Z');
      const legacyResult = {
        recallId: 'rec-1',
        memories: [
          {
            id: 'mem-1',
            userId: 'user-123',
            raw: 'The user prefers dark mode.',
            sessionId: 'sess-abc',
            score: 0.87,
            createdAt,
            memoryType: 'PREFERENCE',
            layer: 'IDENTITY',
            confidence: 1.0, // intrinsic; must NOT bleed into structured.confidence
          },
          {
            id: 'mem-2',
            userId: 'user-123',
            raw: 'No session for this one.',
            sessionId: null,
            score: undefined,
            createdAt,
            memoryType: null,
            layer: 'PROJECT',
            confidence: 0.5,
          },
        ],
        queryTokens: 3,
        latencyMs: 12,
      };

      it('returns the legacy shape unchanged by default', async () => {
        memoryService.recall.mockResolvedValue(legacyResult as any);
        const res = { set: jest.fn() } as any;
        const result = await controller.recall(
          userId,
          { query: 'x' } as any,
          { isInstanceKey: false },
          res,
        );
        expect(result).toBe(legacyResult);
        expect((result as any).format).toBeUndefined();
        expect((result as any).memories[0].raw).toBe(
          'The user prefers dark mode.',
        );
        // Legacy response carries the raw Prisma fields; no `fact` projection.
        expect((result as any).memories[0].fact).toBeUndefined();
      });

      it('returns legacy shape when response_format=legacy is explicit', async () => {
        memoryService.recall.mockResolvedValue(legacyResult as any);
        const res = { set: jest.fn() } as any;
        const result = await controller.recall(
          userId,
          { query: 'x' } as any,
          { isInstanceKey: false },
          res,
          undefined,
          undefined,
          'legacy',
        );
        expect((result as any).format).toBeUndefined();
        expect((result as any).memories[0].raw).toBe(
          'The user prefers dark mode.',
        );
      });

      it('returns structured shape when response_format=structured', async () => {
        memoryService.recall.mockResolvedValue(legacyResult as any);
        const res = { set: jest.fn() } as any;
        const result: any = await controller.recall(
          userId,
          { query: 'x' } as any,
          { isInstanceKey: false },
          res,
          undefined,
          undefined,
          'structured',
        );
        expect(result.format).toBe('json_v2');
        expect(result.recallId).toBe('rec-1');
        expect(result.queryTokens).toBe(3);
        expect(result.latencyMs).toBe(12);
        expect(result.memories).toHaveLength(2);
        expect(result.memories[0]).toEqual({
          id: 'mem-1',
          fact: 'The user prefers dark mode.',
          source_session: 'sess-abc',
          confidence: 0.87, // retrieval score, NOT intrinsic memory.confidence
          timestamp: '2026-05-21T14:32:11.000Z',
          memory_type: 'PREFERENCE',
        });
        expect(result.memories[1]).toEqual({
          id: 'mem-2',
          fact: 'No session for this one.',
          source_session: null,
          confidence: null, // no score → null, not fabricated
          timestamp: '2026-05-21T14:32:11.000Z',
          memory_type: null,
        });
        expect(res.set).toHaveBeenCalledWith('X-Response-Format', 'json_v2');
      });

      it('also accepts response_format=json_v2 as an alias', async () => {
        memoryService.recall.mockResolvedValue(legacyResult as any);
        const res = { set: jest.fn() } as any;
        const result: any = await controller.recall(
          userId,
          { query: 'x' } as any,
          { isInstanceKey: false },
          res,
          undefined,
          undefined,
          'json_v2',
        );
        expect(result.format).toBe('json_v2');
      });

      it('switches via Accept: application/vnd.engram.v2+json header', async () => {
        memoryService.recall.mockResolvedValue(legacyResult as any);
        const res = { set: jest.fn() } as any;
        const result: any = await controller.recall(
          userId,
          { query: 'x' } as any,
          { isInstanceKey: false },
          res,
          undefined,
          undefined,
          undefined,
          'application/vnd.engram.v2+json',
        );
        expect(result.format).toBe('json_v2');
      });

      it('lets explicit response_format=legacy override an Accept v2 header', async () => {
        memoryService.recall.mockResolvedValue(legacyResult as any);
        const res = { set: jest.fn() } as any;
        const result: any = await controller.recall(
          userId,
          { query: 'x' } as any,
          { isInstanceKey: false },
          res,
          undefined,
          undefined,
          'legacy',
          'application/vnd.engram.v2+json',
        );
        expect(result.format).toBeUndefined();
        expect(result.memories[0].raw).toBe('The user prefers dark mode.');
      });
    });
  });

  describe('contextualRecall', () => {
    it('should delegate to contextualRecallService', async () => {
      const dto = { messages: [] } as any;
      const expected = { triggered: false, memories: [] };
      contextualRecallService.recall.mockResolvedValue(expected as any);

      const req = { isInstanceKey: false };
      const result = await controller.contextualRecall(userId, dto, req);

      expect(result).toEqual(expected);
    });
  });

  describe('getGraph', () => {
    it('should return graph data with defaults', async () => {
      const expected = { nodes: [], edges: [], entities: [] };
      memoryService.getGraphData.mockResolvedValue(expected as any);

      const mockReq = { user: { id: userId } } as any;
      const result = await controller.getGraph(userId, mockReq);

      expect(memoryService.getGraphData).toHaveBeenCalledWith(
        userId,
        500,
        false,
      );
      expect(result).toEqual(expected);
    });

    it('should parse limit and includeAgent params', async () => {
      memoryService.getGraphData.mockResolvedValue({
        nodes: [],
        edges: [],
        entities: [],
      } as any);

      const mockReq = { user: { id: userId } } as any;
      await controller.getGraph(userId, mockReq, '100', 'true');

      expect(memoryService.getGraphData).toHaveBeenCalledWith(
        userId,
        100,
        true,
      );
    });
  });

  describe('findContradictions', () => {
    it('should delegate to memoryService.findContradictions', async () => {
      const dto = { memoryId: 'mem-1' } as any;
      const expected = {
        sourceId: 'mem-1',
        sourceText: 'some fact',
        contradictions: [],
        total: 0,
        latencyMs: 5,
      };
      memoryService.findContradictions.mockResolvedValue(expected);

      const req = { isInstanceKey: false };
      const result = await controller.findContradictions(userId, dto, req);

      expect(result).toEqual(expected);
      expect(memoryService.findContradictions).toHaveBeenCalledWith(
        userId,
        dto,
      );
    });

    it('should resolve account user IDs when agentId provided', async () => {
      const dto = { text: 'the sky is green' } as any;
      const expected = {
        sourceId: null,
        sourceText: 'the sky is green',
        contradictions: [],
        total: 0,
        latencyMs: 3,
      };
      memoryService.findContradictions.mockResolvedValue(expected);

      const req = { isInstanceKey: false, accountId: 'acc-1' };
      await controller.findContradictions(userId, dto, req, 'agent-1');

      // When resolveAccountUserIds returns null (empty list), falls back to userId
      expect(memoryService.findContradictions).toHaveBeenCalledWith(
        userId,
        dto,
      );
    });
  });

  describe('loadContext', () => {
    it('should load context', async () => {
      const dto = { sessionHint: 'test' } as any;
      const expected = { memories: [], summary: '' };
      memoryService.loadContext.mockResolvedValue(expected as any);

      const result = await controller.loadContext(userId, dto);

      expect(result).toEqual(expected);
    });
  });

  describe('detectGaps', () => {
    const mockAgent = { id: 'agent-1', accountId: 'account-1' };

    it('should delegate to temporalGapService with correct params', async () => {
      const expected = {
        topic: 'deployment',
        range: { start: '2026-03-01', end: '2026-03-05' },
        totalMemories: 10,
        averagePerDay: 2,
        gaps: [],
        coverage: 100,
      };
      temporalGapService.detectGaps.mockResolvedValue(expected);

      const dto = {
        topic: 'deployment',
        start: '2026-03-01',
        end: '2026-03-05',
      } as any;
      const result = await controller.detectGaps(mockAgent, dto);

      expect(result).toEqual(expected);
      expect(temporalGapService.detectGaps).toHaveBeenCalledWith(
        'deployment',
        new Date('2026-03-01'),
        new Date('2026-03-05'),
        'agent-1',
      );
    });

    it('should use agent id for tenant isolation', async () => {
      temporalGapService.detectGaps.mockResolvedValue({
        topic: 'test',
        range: { start: '2026-03-01', end: '2026-03-01' },
        totalMemories: 0,
        averagePerDay: 0,
        gaps: [],
        coverage: 0,
      });

      const agent = { id: 'agent-other', accountId: 'account-2' };
      const dto = {
        topic: 'test',
        start: '2026-03-01',
        end: '2026-03-01',
      } as any;
      await controller.detectGaps(agent, dto);

      expect(temporalGapService.detectGaps).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Date),
        expect.any(Date),
        'agent-other',
      );
    });

    it('should return gap detection response', async () => {
      const gapResponse = {
        topic: 'meetings',
        range: { start: '2026-03-01', end: '2026-03-03' },
        totalMemories: 5,
        averagePerDay: 1.67,
        gaps: [{ date: '2026-03-02', memoryCount: 0, isAbsoluteGap: true }],
        coverage: 66.67,
      };
      temporalGapService.detectGaps.mockResolvedValue(gapResponse);

      const dto = {
        topic: 'meetings',
        start: '2026-03-01',
        end: '2026-03-03',
      } as any;
      const result = await controller.detectGaps(mockAgent, dto);

      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0].isAbsoluteGap).toBe(true);
      expect(result.coverage).toBe(66.67);
    });
  });

  describe('projectState', () => {
    it('should delegate to projectStateService.synthesize', async () => {
      const dto = { projectName: 'Alpha' } as any;
      const expected = {
        projectName: 'Alpha',
        lastActivity: null,
        totalMemories: 0,
        confidence: 0,
        summary: {
          goals: [],
          decisions: [],
          issues: [],
          outcomes: [],
          insights: [],
        },
        recentActivity: [],
      };
      projectStateService.synthesize.mockResolvedValue(expected);

      const req = { isInstanceKey: false };
      const result = await controller.projectState(userId, dto, req);

      expect(result).toEqual(expected);
      expect(projectStateService.synthesize).toHaveBeenCalledWith(userId, dto);
    });

    it('should resolve account user IDs when agentId is provided', async () => {
      const dto = { projectName: 'Beta' } as any;
      const expected = {
        projectName: 'Beta',
        lastActivity: null,
        totalMemories: 0,
        confidence: 0,
        summary: {
          goals: [],
          decisions: [],
          issues: [],
          outcomes: [],
          insights: [],
        },
        recentActivity: [],
      };
      projectStateService.synthesize.mockResolvedValue(expected);

      const req = { accountId: 'acc-1' };
      // The prisma.user.findMany will return users for the account
      const result = await controller.projectState(userId, dto, req, 'agent-1');

      expect(result).toEqual(expected);
    });
  });
});
