import { ProjectStateService } from './project-state.service';
import { MemoryLayer } from '@prisma/client';

describe('ProjectStateService', () => {
  let service: ProjectStateService;
  let mockPrisma: any;
  let mockEmbedding: any;

  const userId = 'user-123';

  function makeMemory(overrides: Partial<any> = {}) {
    return {
      id: overrides.id ?? 'mem-1',
      userId,
      raw: overrides.raw ?? 'test memory',
      layer: overrides.layer ?? MemoryLayer.PROJECT,
      createdAt: overrides.createdAt ?? new Date(),
      deletedAt: null,
      supersededById: null,
      searchable: true,
      effectiveScore: 0.5,
      importanceScore: 0.5,
      projectId: null,
      extraction: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();

    mockPrisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    mockEmbedding = {
      generateForRecall: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      search: jest.fn().mockResolvedValue([]),
    };

    service = new ProjectStateService(mockPrisma, mockEmbedding);
  });

  describe('synthesize', () => {
    it('should return empty summary with zero confidence for empty project', async () => {
      const result = await service.synthesize(userId, {
        projectName: 'nonexistent',
      });

      expect(result.projectName).toBe('nonexistent');
      expect(result.totalMemories).toBe(0);
      expect(result.confidence).toBe(0);
      expect(result.lastActivity).toBeNull();
      expect(result.summary.goals).toEqual([]);
      expect(result.summary.decisions).toEqual([]);
      expect(result.summary.issues).toEqual([]);
      expect(result.summary.outcomes).toEqual([]);
      expect(result.summary.insights).toEqual([]);
      expect(result.recentActivity).toEqual([]);
    });

    it('should find project memories and categorize goals', async () => {
      const goalMemory = makeMemory({
        id: 'goal-1',
        raw: 'The goal is to ship v2 by March',
        createdAt: new Date(),
      });
      mockPrisma.memory.findMany.mockResolvedValueOnce([goalMemory]);

      const result = await service.synthesize(userId, {
        projectName: 'test-project',
      });

      expect(result.totalMemories).toBe(1);
      expect(result.summary.goals).toHaveLength(1);
      expect(result.summary.goals[0].id).toBe('goal-1');
    });

    it('should categorize decisions', async () => {
      const decisionMemory = makeMemory({
        id: 'dec-1',
        raw: 'We decided to use PostgreSQL for the database',
        createdAt: new Date(),
      });
      mockPrisma.memory.findMany.mockResolvedValueOnce([decisionMemory]);

      const result = await service.synthesize(userId, {
        projectName: 'test-project',
      });

      expect(result.summary.decisions).toHaveLength(1);
      expect(result.summary.decisions[0].id).toBe('dec-1');
      expect(result.summary.decisions[0].date).toBeDefined();
    });

    it('should categorize issues with severity', async () => {
      const criticalIssue = makeMemory({
        id: 'issue-1',
        raw: 'Critical security bug found in auth module',
        createdAt: new Date(),
      });
      const mediumIssue = makeMemory({
        id: 'issue-2',
        raw: 'Minor bug in the display logic',
        createdAt: new Date(),
      });
      mockPrisma.memory.findMany.mockResolvedValueOnce([
        criticalIssue,
        mediumIssue,
      ]);

      const result = await service.synthesize(userId, {
        projectName: 'test-project',
      });

      expect(result.summary.issues).toHaveLength(2);
      expect(
        result.summary.issues.find((i) => i.id === 'issue-1')?.severity,
      ).toBe('critical');
      expect(
        result.summary.issues.find((i) => i.id === 'issue-2')?.severity,
      ).toBe('medium');
    });

    it('should categorize outcomes', async () => {
      const outcomeMemory = makeMemory({
        id: 'out-1',
        raw: 'Successfully deployed the new API to production',
        createdAt: new Date(),
      });
      mockPrisma.memory.findMany.mockResolvedValueOnce([outcomeMemory]);

      const result = await service.synthesize(userId, {
        projectName: 'test-project',
      });

      expect(result.summary.outcomes).toHaveLength(1);
      expect(result.summary.outcomes[0].id).toBe('out-1');
    });

    it('should place INSIGHT layer memories into insights category', async () => {
      const insightMemory = makeMemory({
        id: 'ins-1',
        raw: 'Pattern: most bugs occur after Friday deploys',
        layer: MemoryLayer.INSIGHT,
        createdAt: new Date(),
      });
      // Project memories query returns the insight (since it's related)
      mockPrisma.memory.findMany.mockResolvedValueOnce([insightMemory]);

      const result = await service.synthesize(userId, {
        projectName: 'test-project',
        includeRelated: false,
      });

      expect(result.summary.insights).toHaveLength(1);
      expect(result.summary.insights[0].id).toBe('ins-1');
    });

    it('should include related memories from other layers when includeRelated=true', async () => {
      const projectMem = makeMemory({
        id: 'proj-1',
        raw: 'Project Alpha goal is to build a dashboard',
        createdAt: new Date(),
      });
      const taskMem = makeMemory({
        id: 'task-1',
        raw: 'Task: fix the error in the dashboard layout',
        layer: MemoryLayer.TASK,
        createdAt: new Date(),
      });

      // First call: project memories
      mockPrisma.memory.findMany.mockResolvedValueOnce([projectMem]);
      // Embedding search returns related task
      mockEmbedding.search.mockResolvedValueOnce([
        { id: 'task-1', score: 0.8 },
      ]);
      // Second call: related memories
      mockPrisma.memory.findMany.mockResolvedValueOnce([taskMem]);

      const result = await service.synthesize(userId, {
        projectName: 'Alpha',
        includeRelated: true,
      });

      expect(result.totalMemories).toBe(2);
      expect(result.summary.goals).toHaveLength(1);
      expect(result.summary.issues).toHaveLength(1);
    });

    it('should not include related memories when includeRelated=false', async () => {
      const projectMem = makeMemory({
        id: 'proj-1',
        raw: 'Project Alpha goal is to build a dashboard',
        createdAt: new Date(),
      });
      mockPrisma.memory.findMany.mockResolvedValueOnce([projectMem]);

      const result = await service.synthesize(userId, {
        projectName: 'Alpha',
        includeRelated: false,
      });

      expect(mockEmbedding.generateForRecall).not.toHaveBeenCalled();
      expect(result.totalMemories).toBe(1);
    });

    it('should populate recentActivity with last 7 days of memories', async () => {
      const recentMem = makeMemory({
        id: 'recent-1',
        raw: 'Recent update to project',
        createdAt: new Date(), // today
      });
      const oldMem = makeMemory({
        id: 'old-1',
        raw: 'Old update to project',
        createdAt: new Date('2020-01-01'),
      });
      mockPrisma.memory.findMany.mockResolvedValueOnce([recentMem, oldMem]);

      const result = await service.synthesize(userId, {
        projectName: 'test',
        includeRelated: false,
      });

      expect(result.recentActivity).toHaveLength(1);
      expect(result.recentActivity[0].id).toBe('recent-1');
      expect(result.recentActivity[0].layer).toBe(MemoryLayer.PROJECT);
    });

    it('should enforce agentId isolation via userId filter', async () => {
      const accountUserIds = ['user-a', 'user-b'];
      mockPrisma.memory.findMany.mockResolvedValueOnce([]);

      await service.synthesize(accountUserIds, {
        projectName: 'test',
        includeRelated: false,
      });

      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: { in: accountUserIds },
          }),
        }),
      );
    });

    it('should respect lookbackDays', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce([]);

      await service.synthesize(userId, {
        projectName: 'test',
        lookbackDays: 7,
        includeRelated: false,
      });

      const callArgs = mockPrisma.memory.findMany.mock.calls[0][0];
      const cutoff = callArgs.where.createdAt.gte;
      const daysDiff = (Date.now() - cutoff.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysDiff).toBeGreaterThanOrEqual(6.9);
      expect(daysDiff).toBeLessThanOrEqual(7.1);
    });

    it('should handle embedding search failure gracefully', async () => {
      const projectMem = makeMemory({
        id: 'proj-1',
        raw: 'Project test goal to ship feature',
        createdAt: new Date(),
      });
      mockPrisma.memory.findMany.mockResolvedValueOnce([projectMem]);
      mockEmbedding.generateForRecall.mockRejectedValueOnce(
        new Error('Embedding service down'),
      );

      const result = await service.synthesize(userId, {
        projectName: 'test',
        includeRelated: true,
      });

      // Should still return project memories
      expect(result.totalMemories).toBe(1);
    });

    it('should filter low-score related memories (below 0.3)', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce([]); // project memories
      mockEmbedding.search.mockResolvedValueOnce([
        { id: 'low-1', score: 0.1 },
        { id: 'high-1', score: 0.8 },
      ]);
      mockPrisma.memory.findMany.mockResolvedValueOnce([
        makeMemory({
          id: 'high-1',
          raw: 'relevant task',
          layer: MemoryLayer.TASK,
        }),
      ]);

      const result = await service.synthesize(userId, {
        projectName: 'test',
        includeRelated: true,
      });

      // Only high-score memory should be fetched
      const secondCall = mockPrisma.memory.findMany.mock.calls[1][0];
      expect(secondCall.where.id.in).toEqual(['high-1']);
    });
  });

  describe('calculateConfidence', () => {
    it('should return 0 for zero memories', () => {
      expect(
        service.calculateConfidence(0, null, {
          goals: [],
          decisions: [],
          issues: [],
          outcomes: [],
          insights: [],
        }),
      ).toBe(0);
    });

    it('should return higher confidence with more memories', () => {
      const low = service.calculateConfidence(5, new Date().toISOString(), {
        goals: [{}],
        decisions: [],
        issues: [],
        outcomes: [],
        insights: [],
      });
      const high = service.calculateConfidence(50, new Date().toISOString(), {
        goals: [{}],
        decisions: [],
        issues: [],
        outcomes: [],
        insights: [],
      });
      expect(high).toBeGreaterThan(low);
    });

    it('should return higher confidence with more recent activity', () => {
      const recent = service.calculateConfidence(10, new Date().toISOString(), {
        goals: [{}],
        decisions: [],
        issues: [],
        outcomes: [],
        insights: [],
      });
      const old = service.calculateConfidence(
        10,
        new Date('2020-01-01').toISOString(),
        {
          goals: [{}],
          decisions: [],
          issues: [],
          outcomes: [],
          insights: [],
        },
      );
      expect(recent).toBeGreaterThan(old);
    });

    it('should return higher confidence with more diverse categories', () => {
      const oneCategory = service.calculateConfidence(
        10,
        new Date().toISOString(),
        {
          goals: [{}],
          decisions: [],
          issues: [],
          outcomes: [],
          insights: [],
        },
      );
      const fiveCategories = service.calculateConfidence(
        10,
        new Date().toISOString(),
        {
          goals: [{}],
          decisions: [{}],
          issues: [{}],
          outcomes: [{}],
          insights: [{}],
        },
      );
      expect(fiveCategories).toBeGreaterThan(oneCategory);
    });
  });
});
