import { Test, TestingModule } from '@nestjs/testing';
import { RetrievalSignalsService } from './retrieval-signals.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueryType } from '@prisma/client';

describe('RetrievalSignalsService', () => {
  let service: RetrievalSignalsService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      retrievalLog: {
        create: jest.fn(),
      },
      retrievalSignal: {
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetrievalSignalsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<RetrievalSignalsService>(RetrievalSignalsService);
    jest.clearAllMocks();
  });

  describe('classifyQueryType', () => {
    it('should classify temporal queries', () => {
      expect(service.classifyQueryType('what happened yesterday')).toBe(
        QueryType.TEMPORAL,
      );
      expect(service.classifyQueryType('meetings last week')).toBe(
        QueryType.TEMPORAL,
      );
      expect(service.classifyQueryType('notes from March')).toBe(
        QueryType.TEMPORAL,
      );
      expect(service.classifyQueryType('when did we discuss the project')).toBe(
        QueryType.TEMPORAL,
      );
      expect(service.classifyQueryType('recent conversations')).toBe(
        QueryType.TEMPORAL,
      );
      expect(service.classifyQueryType('what happened on 2026-03-15')).toBe(
        QueryType.TEMPORAL,
      );
    });

    it('should classify factual queries', () => {
      expect(service.classifyQueryType('what is the API key')).toBe(
        QueryType.FACTUAL,
      );
      expect(service.classifyQueryType('who is the CEO')).toBe(
        QueryType.FACTUAL,
      );
      expect(service.classifyQueryType('email address')).toBe(
        QueryType.FACTUAL,
      );
      expect(service.classifyQueryType('phone number')).toBe(QueryType.FACTUAL);
      expect(service.classifyQueryType('where is the office')).toBe(
        QueryType.FACTUAL,
      );
    });

    it('should classify semantic queries', () => {
      expect(
        service.classifyQueryType(
          'how do I feel about the project direction and team dynamics',
        ),
      ).toBe(QueryType.SEMANTIC);
      expect(
        service.classifyQueryType('thoughts on improving the architecture'),
      ).toBe(QueryType.SEMANTIC);
      expect(
        service.classifyQueryType('my preferences for code review style'),
      ).toBe(QueryType.SEMANTIC);
    });

    it('should default to SEMANTIC for ambiguous queries', () => {
      expect(service.classifyQueryType('tell me more about this')).toBe(
        QueryType.SEMANTIC,
      );
      expect(
        service.classifyQueryType('interesting patterns in the data'),
      ).toBe(QueryType.SEMANTIC);
    });
  });

  describe('logQuery', () => {
    it('should create a retrieval log with classified query type', async () => {
      const mockLog = { id: 'log-123', accountId: 'acc-1' };
      mockPrisma.retrievalLog.create.mockResolvedValue(mockLog);

      const result = await service.logQuery({
        accountId: 'acc-1',
        queryText: 'what happened yesterday',
        strategyConfig: { vectorWeight: 0.6, bm25Weight: 0.4 },
        resultCount: 5,
        latencyMs: 42,
      });

      expect(result).toBe('log-123');
      expect(mockPrisma.retrievalLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountId: 'acc-1',
          queryText: 'what happened yesterday',
          queryType: QueryType.TEMPORAL,
          strategyConfig: { vectorWeight: 0.6, bm25Weight: 0.4 },
          resultCount: 5,
          latencyMs: 42,
        }),
      });
    });

    it('should use provided queryType when specified', async () => {
      mockPrisma.retrievalLog.create.mockResolvedValue({ id: 'log-456' });

      await service.logQuery({
        accountId: 'acc-1',
        queryText: 'some query',
        queryType: QueryType.FACTUAL,
        resultCount: 3,
        latencyMs: 30,
      });

      expect(mockPrisma.retrievalLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          queryType: QueryType.FACTUAL,
        }),
      });
    });

    it('should handle zero results', async () => {
      mockPrisma.retrievalLog.create.mockResolvedValue({ id: 'log-789' });

      const result = await service.logQuery({
        accountId: 'acc-1',
        queryText: 'nonexistent topic',
        resultCount: 0,
        latencyMs: 15,
      });

      expect(result).toBe('log-789');
      expect(mockPrisma.retrievalLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resultCount: 0,
        }),
      });
    });
  });

  describe('logSignal', () => {
    it('should create a retrieval signal with 90-day expiry', async () => {
      const mockSignal = { id: 'sig-123' };
      mockPrisma.retrievalSignal.create.mockResolvedValue(mockSignal);

      const result = await service.logSignal({
        accountId: 'acc-1',
        queryId: 'query-1',
        memoryId: 'mem-1',
        signalType: 'EXPLICIT_HIT' as any,
        weight: 2.0,
        rank: 1,
        propensity: 0.15,
      });

      expect(result).toBe('sig-123');
      const callData = mockPrisma.retrievalSignal.create.mock.calls[0][0].data;
      expect(callData.accountId).toBe('acc-1');
      expect(callData.queryId).toBe('query-1');
      expect(callData.memoryId).toBe('mem-1');
      expect(callData.weight).toBe(2.0);
      expect(callData.rank).toBe(1);
      expect(callData.propensity).toBe(0.15);

      // Verify 90-day expiry (with 1-day tolerance)
      const expiresAt = new Date(callData.expiresAt);
      const expectedExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      const diffMs = Math.abs(expiresAt.getTime() - expectedExpiry.getTime());
      expect(diffMs).toBeLessThan(24 * 60 * 60 * 1000);
    });

    it('should allow null memoryId for null-result signals', async () => {
      mockPrisma.retrievalSignal.create.mockResolvedValue({ id: 'sig-456' });

      await service.logSignal({
        accountId: 'acc-1',
        queryId: 'query-2',
        signalType: 'NULL_RESULT' as any,
        weight: -1.0,
      });

      const callData = mockPrisma.retrievalSignal.create.mock.calls[0][0].data;
      expect(callData.memoryId).toBeUndefined();
    });
  });

  describe('computePropensity', () => {
    it('should return higher propensity for rank 1 than rank 10', () => {
      const p1 = service.computePropensity(0, 20);
      const p10 = service.computePropensity(9, 20);
      expect(p1).toBeGreaterThan(p10);
    });

    it('should return 0 when resultCount is 0', () => {
      expect(service.computePropensity(0, 0)).toBe(0);
    });

    it('should sum to approximately 1.0 across all ranks', () => {
      const resultCount = 20;
      let totalPropensity = 0;
      for (let i = 0; i < resultCount; i++) {
        totalPropensity += service.computePropensity(i, resultCount);
      }
      expect(totalPropensity).toBeCloseTo(1.0, 5);
    });

    it('should respect custom rrfK parameter', () => {
      const pDefault = service.computePropensity(0, 10, 60);
      const pSmallK = service.computePropensity(0, 10, 10);
      // Smaller k gives more weight to top ranks
      expect(pSmallK).toBeGreaterThan(pDefault);
    });
  });
});
