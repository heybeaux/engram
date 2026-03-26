import { Test, TestingModule } from '@nestjs/testing';
import { QueryLogService, QueryLogEntry } from './query-log.service';
import { PrismaService } from '../prisma/prisma.service';

describe('QueryLogService', () => {
  let service: QueryLogService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      queryLog: {
        create: jest.fn().mockResolvedValue({ id: 'ql-1' }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueryLogService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<QueryLogService>(QueryLogService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('writeQueryLog', () => {
    const entry: QueryLogEntry = {
      queryText: 'What are user preferences?',
      queryEmbedding: [0.1, 0.2, 0.3],
      agentId: 'agent-1',
      sessionKey: 'agent:main',
      results: [
        { memoryId: 'm1', cosineScore: 0.95, rank: 1 },
        { memoryId: 'm2', cosineScore: 0.82, rank: 2 },
      ],
      latencyMs: 45,
    };

    it('should write a query log entry to the database', async () => {
      await service.writeQueryLog(entry);

      expect(prisma.queryLog.create).toHaveBeenCalledWith({
        data: {
          queryText: 'What are user preferences?',
          queryEmbedding: [0.1, 0.2, 0.3],
          agentId: 'agent-1',
          sessionKey: 'agent:main',
          resultsReturned: [
            { memory_id: 'm1', cosine_score: 0.95, rank: 1 },
            { memory_id: 'm2', cosine_score: 0.82, rank: 2 },
          ],
          resultCount: 2,
          latencyMs: 45,
        },
      });
    });

    it('should handle entries with no results', async () => {
      const emptyEntry: QueryLogEntry = {
        queryText: 'obscure query',
        queryEmbedding: [0.5, 0.6],
        results: [],
        latencyMs: 12,
      };

      await service.writeQueryLog(emptyEntry);

      expect(prisma.queryLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resultCount: 0,
          resultsReturned: [],
          agentId: undefined,
          sessionKey: undefined,
        }),
      });
    });

    it('should propagate database errors', async () => {
      prisma.queryLog.create.mockRejectedValue(new Error('DB connection lost'));

      await expect(service.writeQueryLog(entry)).rejects.toThrow(
        'DB connection lost',
      );
    });
  });

  describe('logQuery (fire-and-forget)', () => {
    it('should not throw when the write fails', () => {
      prisma.queryLog.create.mockRejectedValue(new Error('DB error'));

      // logQuery is fire-and-forget — should not throw
      expect(() =>
        service.logQuery({
          queryText: 'test',
          queryEmbedding: [0.1],
          results: [],
          latencyMs: 5,
        }),
      ).not.toThrow();
    });

    it('should call writeQueryLog internally', () => {
      const spy = jest.spyOn(service, 'writeQueryLog').mockResolvedValue();

      service.logQuery({
        queryText: 'test query',
        queryEmbedding: [0.1, 0.2],
        results: [{ memoryId: 'm1', cosineScore: 0.9, rank: 1 }],
        latencyMs: 30,
      });

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
