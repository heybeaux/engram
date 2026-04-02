import { MemoryFailureService } from './memory-failure.service';
import { MemoryQueryController } from './memory-query.controller';
import { MemoryService } from './memory.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { FindFailuresDto } from './dto/find-failures.dto';

describe('findFailures (ENG-116)', () => {
  // ─── Service tests ─────────────────────────────────────────────
  describe('MemoryFailureService.findFailures', () => {
    let service: MemoryFailureService;
    let prisma: jest.Mocked<PrismaService>;
    let embedding: jest.Mocked<EmbeddingService>;

    const userId = 'user-123';
    const mockEmbedding = [0.1, 0.2, 0.3];

    beforeEach(() => {
      jest.clearAllMocks();

      prisma = {
        memory: {
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      } as any;

      embedding = {
        generate: jest.fn().mockResolvedValue(mockEmbedding),
        generateForRecall: jest.fn().mockResolvedValue(mockEmbedding),
        search: jest.fn().mockResolvedValue([]),
      } as any;

      service = new MemoryFailureService(
        prisma,
        embedding,
      );
    });

    it('should return matching failure memories with similarity scores', async () => {
      const mockRows = [
        {
          id: 'mem-1',
          raw: 'Deploy failed due to missing env vars',
          layer: 'SESSION',
          created_at: new Date('2026-03-20'),
          metadata: { outcome: 'failure' },
          tags: ['deploy'],
          similarity: 0.85,
        },
        {
          id: 'mem-2',
          raw: 'Auth service crashed on startup',
          layer: 'PROJECT',
          created_at: new Date('2026-03-19'),
          metadata: {},
          tags: [],
          similarity: 0.78,
        },
      ];
      prisma.$queryRawUnsafe.mockResolvedValue(mockRows);

      const dto: FindFailuresDto = {
        goal: 'Deploy the authentication service',
      };
      const result = await service.findFailures(userId, dto);

      expect(result.failures).toHaveLength(2);
      expect(result.failures[0].id).toBe('mem-1');
      expect(result.failures[0].similarity).toBe(0.85);
      expect(result.failures[1].id).toBe('mem-2');
      expect(result.total).toBe(2);
      expect(result.goal).toBe('Deploy the authentication service');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(embedding.generateForRecall).toHaveBeenCalledWith(
        'Deploy the authentication service',
      );
    });

    it('should return empty results when no failures exist', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      const dto: FindFailuresDto = { goal: 'Simple task with no failures' };
      const result = await service.findFailures(userId, dto);

      expect(result.failures).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.goal).toBe('Simple task with no failures');
    });

    it('should filter by agentId for multi-tenant isolation', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      const dto: FindFailuresDto = {
        goal: 'Deploy service',
        agentId: 'agent-abc',
      };
      await service.findFailures(userId, dto);

      const queryArg = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(queryArg).toContain('m.agent_id =');

      // agentId should be in the params
      const params = prisma.$queryRawUnsafe.mock.calls[0];
      expect(params).toContain('agent-abc');
    });

    it('should not include agent_id filter when agentId is not provided', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      const dto: FindFailuresDto = { goal: 'Deploy service' };
      await service.findFailures(userId, dto);

      const queryArg = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(queryArg).not.toContain('m.agent_id');
    });

    it('should handle array userId for account-wide search', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      const dto: FindFailuresDto = { goal: 'Deploy service' };
      await service.findFailures(['user-1', 'user-2'], dto);

      const params = prisma.$queryRawUnsafe.mock.calls[0];
      expect(params).toContainEqual(['user-1', 'user-2']);
    });

    it('should handle null userId (account-wide, no user filter)', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      const dto: FindFailuresDto = { goal: 'Deploy service' };
      await service.findFailures(null, dto);

      const queryArg = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(queryArg).not.toContain('m.user_id');
    });

    it('should respect custom limit and minSimilarity', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      const dto: FindFailuresDto = {
        goal: 'Deploy service',
        limit: 5,
        minSimilarity: 0.8,
      };
      await service.findFailures(userId, dto);

      const params = prisma.$queryRawUnsafe.mock.calls[0];
      expect(params).toContain(0.8);
      expect(params).toContain(5);
    });

    it('should include extra keywords in the query', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([]);

      const dto: FindFailuresDto = {
        goal: 'Deploy service',
        extraKeywords: ['timeout', 'rejected'],
      };
      await service.findFailures(userId, dto);

      const patternsParam = prisma.$queryRawUnsafe.mock.calls[0].find(
        (p: any) => typeof p === 'string' && p.startsWith('{'),
      ) as string;
      expect(patternsParam).toContain('%timeout%');
      expect(patternsParam).toContain('%rejected%');
    });
  });

  // ─── Controller tests ──────────────────────────────────────────
  describe('MemoryQueryController.findFailures', () => {
    let controller: MemoryQueryController;
    let memoryService: jest.Mocked<MemoryService>;

    const userId = 'user-456';

    beforeEach(() => {
      jest.clearAllMocks();

      memoryService = {
        recall: jest.fn(),
        getGraphData: jest.fn(),
        loadContext: jest.fn(),
        findFailures: jest.fn(),
      } as any;

      const contextualRecallService = { recall: jest.fn() } as any;
      const prismaService = {
        user: { findMany: jest.fn().mockResolvedValue([]) },
      } as any;
      const retrievalSignals = {
        logQuery: jest.fn().mockResolvedValue('query-id'),
      } as any;

      controller = new MemoryQueryController(
        memoryService,
        {} as any, // memoryQueryService
        contextualRecallService,
        {} as any, // temporalGapService
        prismaService,
        retrievalSignals,
        {} as any, // projectStateService
      );
    });

    it('should delegate to memoryService.findFailures', async () => {
      const expected = {
        failures: [],
        total: 0,
        goal: 'test goal',
        latencyMs: 5,
      };
      memoryService.findFailures.mockResolvedValue(expected);

      const dto: FindFailuresDto = { goal: 'test goal' };
      const req = { isInstanceKey: false };

      const result = await controller.findFailures(userId, dto, req);

      expect(result).toEqual(expected);
      expect(memoryService.findFailures).toHaveBeenCalledWith(userId, dto);
    });

    it('should resolve account user IDs when accountId present', async () => {
      const expected = {
        failures: [],
        total: 0,
        goal: 'test goal',
        latencyMs: 5,
      };
      memoryService.findFailures.mockResolvedValue(expected);

      const dto: FindFailuresDto = { goal: 'test goal' };
      const req = { accountId: 'acc-1', isInstanceKey: false };

      // The controller calls resolveAccountUserIds which queries prisma.user.findMany
      // Since mock returns [], it falls back to userId
      const result = await controller.findFailures(userId, dto, req);

      expect(result).toEqual(expected);
      expect(memoryService.findFailures).toHaveBeenCalledWith(userId, dto);
    });

    it('should pass agentId to resolveAccountUserIds', async () => {
      const expected = {
        failures: [],
        total: 0,
        goal: 'test goal',
        latencyMs: 3,
      };
      memoryService.findFailures.mockResolvedValue(expected);

      const dto: FindFailuresDto = { goal: 'test goal' };
      const req = { accountId: 'acc-1' };

      await controller.findFailures(userId, dto, req, 'agent-xyz');

      expect(memoryService.findFailures).toHaveBeenCalled();
    });
  });

  // ─── DTO validation tests ─────────────────────────────────────
  describe('FindFailuresDto validation', () => {
    it('should have correct default values', () => {
      const dto = new FindFailuresDto();
      expect(dto.limit).toBe(10);
      expect(dto.minSimilarity).toBe(0.7);
    });
  });
});
