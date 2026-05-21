import { ConsolidationController } from './consolidation.controller';
import { DreamCycleService, DreamCycleResult } from './dream-cycle.service';
import {
  GenerateContextService,
  GenerateContextResult,
} from './generate-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { DreamCycleQueueProducer } from './dream-cycle-queue.producer';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockDreamCycle = {
  run: jest.fn(),
};

const mockGenerateContext = {
  generate: jest.fn(),
};

const mockPrisma = {
  dreamCycleReport: {
    findMany: jest.fn(),
  },
};

const mockQueueProducer = {
  enqueue: jest.fn(),
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('ConsolidationController', () => {
  let controller: ConsolidationController;

  const dreamCycleResult: DreamCycleResult = {
    consolidated: 10,
    promoted: 2,
    pruned: 1,
    dryRun: false,
    durationMs: 500,
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new ConsolidationController(
      mockDreamCycle as unknown as DreamCycleService,
      mockGenerateContext as unknown as GenerateContextService,
      mockPrisma as unknown as PrismaService,
      mockQueueProducer as unknown as DreamCycleQueueProducer,
    );
  });

  // ── Guard enforcement ──────────────────────────────────────────────────────

  describe('Guard enforcement', () => {
    it('should apply ApiKeyOrJwtGuard at class level', () => {
      const guards: any[] =
        Reflect.getMetadata('__guards__', ConsolidationController) ?? [];
      const names = guards.map((g) =>
        typeof g === 'function' ? g.name : g?.constructor?.name,
      );
      expect(names).toContain(ApiKeyOrJwtGuard.name);
    });
  });

  // ── runDreamCycle ──────────────────────────────────────────────────────────

  describe('runDreamCycle', () => {
    it('should run synchronous dream cycle with defaults', async () => {
      mockDreamCycle.run.mockResolvedValue(dreamCycleResult);

      const result = await controller.runDreamCycle();

      expect(mockDreamCycle.run).toHaveBeenCalledWith({
        dryRun: false,
        stages: undefined,
        userId: undefined,
        maxMemories: undefined,
      });
      expect(result).toEqual(dreamCycleResult);
    });

    it('should pass dryRun=true when query param is "true"', async () => {
      mockDreamCycle.run.mockResolvedValue(dreamCycleResult);

      await controller.runDreamCycle('true');

      expect(mockDreamCycle.run).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true }),
      );
    });

    it('should pass dryRun=true when query param is "1"', async () => {
      mockDreamCycle.run.mockResolvedValue(dreamCycleResult);

      await controller.runDreamCycle('1');

      expect(mockDreamCycle.run).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true }),
      );
    });

    it('should pass stages and userId from body', async () => {
      mockDreamCycle.run.mockResolvedValue(dreamCycleResult);

      const body = {
        stages: ['consolidate', 'prune'] as any,
        userId: 'user-99',
        maxMemories: 200,
      };
      await controller.runDreamCycle(undefined, body);

      expect(mockDreamCycle.run).toHaveBeenCalledWith({
        dryRun: false,
        stages: body.stages,
        userId: 'user-99',
        maxMemories: 200,
      });
    });

    it('should propagate service errors', async () => {
      mockDreamCycle.run.mockRejectedValue(new Error('dream cycle failed'));
      await expect(controller.runDreamCycle()).rejects.toThrow(
        'dream cycle failed',
      );
    });
  });

  // ── startDreamCycleAsync ───────────────────────────────────────────────────

  describe('startDreamCycleAsync', () => {
    it('should enqueue and return runId with queued status', async () => {
      mockQueueProducer.enqueue.mockResolvedValue('run-123');

      const req = { user: { id: 'user-1' } };
      const result = await controller.startDreamCycleAsync({}, req as any);

      expect(result).toEqual({ runId: 'run-123', status: 'queued' });
      expect(mockQueueProducer.enqueue).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ dryRun: false }),
      );
    });

    it('should prefer body.userId over req.user.id', async () => {
      mockQueueProducer.enqueue.mockResolvedValue('run-456');

      const req = { user: { id: 'user-from-token' } };
      const body = { userId: 'explicit-user' };
      await controller.startDreamCycleAsync(body as any, req as any);

      expect(mockQueueProducer.enqueue).toHaveBeenCalledWith(
        'explicit-user',
        expect.any(Object),
      );
    });

    it('should fall back to req.agent.userId when no user', async () => {
      mockQueueProducer.enqueue.mockResolvedValue('run-789');

      const req = { agent: { userId: 'agent-user' } };
      await controller.startDreamCycleAsync({} as any, req as any);

      expect(mockQueueProducer.enqueue).toHaveBeenCalledWith(
        'agent-user',
        expect.any(Object),
      );
    });

    it('should fall back to "default" user when nothing is available', async () => {
      mockQueueProducer.enqueue.mockResolvedValue('run-def');

      const req = {};
      await controller.startDreamCycleAsync({} as any, req as any);

      expect(mockQueueProducer.enqueue).toHaveBeenCalledWith(
        'default',
        expect.any(Object),
      );
    });

    it('should throw when queueProducer is not configured', async () => {
      const controllerNoQueue = new ConsolidationController(
        mockDreamCycle as any,
        mockGenerateContext as any,
        mockPrisma as any,
        undefined, // no queue producer
      );
      await expect(
        controllerNoQueue.startDreamCycleAsync({} as any, {} as any),
      ).rejects.toThrow('Queue not configured');
    });

    it('should pass dryRun, maxLlmCalls, maxMemories to producer', async () => {
      mockQueueProducer.enqueue.mockResolvedValue('run-opts');

      const body = { dryRun: true, maxLlmCalls: 50, maxMemories: 100 };
      const req = { user: { id: 'u1' } };
      await controller.startDreamCycleAsync(body as any, req as any);

      expect(mockQueueProducer.enqueue).toHaveBeenCalledWith('u1', {
        dryRun: true,
        maxLlmCalls: 50,
        maxMemories: 100,
      });
    });
  });

  // ── generateContextEndpoint ────────────────────────────────────────────────

  describe('generateContextEndpoint', () => {
    const contextResult: GenerateContextResult = {
      context: 'Here is your context...',
      memoryCount: 5,
      tokenCount: 300,
    } as any;

    it('should call generateContext with accountId and no userId (no explicit header)', async () => {
      mockGenerateContext.generate.mockResolvedValue(contextResult);

      const req = { accountId: 'acc-1', headers: {} };
      const result = await controller.generateContextEndpoint(
        req as any,
        'user-1',
      );

      expect(result).toEqual(contextResult);
      expect(mockGenerateContext.generate).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'acc-1', userId: undefined }),
      );
    });

    it('should pass userId when X-AM-User-ID header is present', async () => {
      mockGenerateContext.generate.mockResolvedValue(contextResult);

      const req = { accountId: 'acc-1', headers: { 'x-am-user-id': 'u99' } };
      await controller.generateContextEndpoint(req as any, 'u99');

      expect(mockGenerateContext.generate).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u99' }),
      );
    });

    it('should parse includeStale=true query param', async () => {
      mockGenerateContext.generate.mockResolvedValue(contextResult);

      const req = { accountId: 'acc-1', headers: {} };
      await controller.generateContextEndpoint(req as any, null, 'true');

      expect(mockGenerateContext.generate).toHaveBeenCalledWith(
        expect.objectContaining({ includeStale: true }),
      );
    });

    it('should parse includeStale=1 query param', async () => {
      mockGenerateContext.generate.mockResolvedValue(contextResult);

      const req = { accountId: 'acc-1', headers: {} };
      await controller.generateContextEndpoint(req as any, null, '1');

      expect(mockGenerateContext.generate).toHaveBeenCalledWith(
        expect.objectContaining({ includeStale: true }),
      );
    });

    it('should parse tokenBudget query param', async () => {
      mockGenerateContext.generate.mockResolvedValue(contextResult);

      const req = { accountId: 'acc-1', headers: {} };
      await controller.generateContextEndpoint(
        req as any,
        null,
        undefined,
        '4096',
      );

      expect(mockGenerateContext.generate).toHaveBeenCalledWith(
        expect.objectContaining({ tokenBudget: 4096 }),
      );
    });

    it('should ignore invalid tokenBudget', async () => {
      mockGenerateContext.generate.mockResolvedValue(contextResult);

      const req = { accountId: 'acc-1', headers: {} };
      await controller.generateContextEndpoint(
        req as any,
        null,
        undefined,
        'NaN',
      );

      const opts = mockGenerateContext.generate.mock.calls[0][0];
      expect(opts.tokenBudget).toBeUndefined();
    });

    it('should ignore zero tokenBudget', async () => {
      mockGenerateContext.generate.mockResolvedValue(contextResult);

      const req = { accountId: 'acc-1', headers: {} };
      await controller.generateContextEndpoint(
        req as any,
        null,
        undefined,
        '0',
      );

      const opts = mockGenerateContext.generate.mock.calls[0][0];
      expect(opts.tokenBudget).toBeUndefined();
    });

    it('should fall back to req.agent.accountId', async () => {
      mockGenerateContext.generate.mockResolvedValue(contextResult);

      const req = { agent: { accountId: 'acc-from-agent' }, headers: {} };
      await controller.generateContextEndpoint(req as any, null);

      expect(mockGenerateContext.generate).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'acc-from-agent' }),
      );
    });

    it('should merge body options', async () => {
      mockGenerateContext.generate.mockResolvedValue(contextResult);

      const req = { accountId: 'acc-1', headers: {} };
      const body = { agentId: 'agent-x', query: 'What happened?' };
      await controller.generateContextEndpoint(
        req as any,
        null,
        undefined,
        undefined,
        body as any,
      );

      expect(mockGenerateContext.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-x',
          query: 'What happened?',
        }),
      );
    });

    it('should propagate errors', async () => {
      mockGenerateContext.generate.mockRejectedValue(new Error('context fail'));
      const req = { accountId: 'acc-1', headers: {} };
      await expect(
        controller.generateContextEndpoint(req as any, null),
      ).rejects.toThrow('context fail');
    });
  });

  // ── getReports ─────────────────────────────────────────────────────────────

  describe('getReports', () => {
    const reports = [
      { id: 'r1', userId: 'u1', createdAt: new Date() },
      { id: 'r2', userId: 'u1', createdAt: new Date() },
    ];

    it('should return reports with default limit of 10', async () => {
      mockPrisma.dreamCycleReport.findMany.mockResolvedValue(reports);

      const result = await controller.getReports();

      expect(result).toEqual(reports);
      expect(mockPrisma.dreamCycleReport.findMany).toHaveBeenCalledWith({
        where: undefined,
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
    });

    it('should filter by userId when provided', async () => {
      mockPrisma.dreamCycleReport.findMany.mockResolvedValue(reports);

      await controller.getReports('u1');

      expect(mockPrisma.dreamCycleReport.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
    });

    it('should parse custom limit', async () => {
      mockPrisma.dreamCycleReport.findMany.mockResolvedValue([]);

      await controller.getReports(undefined, '25');

      expect(mockPrisma.dreamCycleReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 25 }),
      );
    });

    it('should propagate errors', async () => {
      mockPrisma.dreamCycleReport.findMany.mockRejectedValue(
        new Error('DB error'),
      );
      await expect(controller.getReports()).rejects.toThrow('DB error');
    });
  });
});
