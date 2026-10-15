import { MemoryPipelineService } from './memory-pipeline.service';

describe('MemoryPipelineService — Embedding Decoupling (HEY-345)', () => {
  let service: MemoryPipelineService;
  let mockPrisma: any;
  let mockExtraction: any;
  let mockEmbedding: any;

  beforeEach(() => {
    mockPrisma = {
      memory: {
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      memoryExtraction: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      entity: { upsert: jest.fn().mockResolvedValue({ id: 'ent-1' }) },
      memoryEntity: { upsert: jest.fn().mockResolvedValue({}) },
      memoryChainLink: { upsert: jest.fn().mockResolvedValue({}) },
    };

    mockExtraction = {
      extract: jest.fn().mockResolvedValue({
        who: 'user',
        what: 'test',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
        memoryType: null,
        typeConfidence: null,
        confidence: {},
        capabilities: [],
        preferenceSignals: [],
        lesson: null,
      }),
      getPriorityForType: jest.fn().mockReturnValue(5),
    };

    mockEmbedding = {
      generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      store: jest.fn().mockResolvedValue('emb-1'),
      search: jest.fn().mockResolvedValue([]),
    };

    service = new MemoryPipelineService(
      mockPrisma,
      mockExtraction,
      mockEmbedding,
    );
  });

  describe('generateAndStoreEmbedding', () => {
    it('should generate and store embedding successfully', async () => {
      const result = await service.generateAndStoreEmbedding(
        'mem-1',
        'hello',
        'user-1',
      );
      expect(result).toBe(true);
      expect(mockEmbedding.generate).toHaveBeenCalledWith('hello');
      expect(mockEmbedding.store).toHaveBeenCalledWith(
        'mem-1',
        [0.1, 0.2, 0.3],
      );
      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        data: { embeddingId: 'emb-1', embeddingStatus: 'COMPLETE' },
      });
    });

    it('should queue for retry when embedding fails', async () => {
      mockEmbedding.generate.mockRejectedValue(new Error('Provider down'));

      const result = await service.generateAndStoreEmbedding(
        'mem-1',
        'hello',
        'user-1',
      );
      expect(result).toBe(false);
      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        data: { embeddingStatus: 'FAILED' },
      });
    });

    it('should remove from retry queue on success after previous failure', async () => {
      // First call fails
      mockEmbedding.generate.mockRejectedValueOnce(new Error('Provider down'));
      await service.generateAndStoreEmbedding('mem-1', 'hello', 'user-1');

      // Second call succeeds
      mockEmbedding.generate.mockResolvedValueOnce([0.1, 0.2]);
      const result = await service.generateAndStoreEmbedding(
        'mem-1',
        'hello',
        'user-1',
      );
      expect(result).toBe(true);
    });
  });

  describe('extractAndEmbed — Phase 1 completes even if Phase 2 fails', () => {
    it('should save extraction and entities even when embedding fails', async () => {
      mockEmbedding.generate.mockRejectedValue(new Error('Provider down'));

      await service.extractAndEmbed('mem-1', 'hello world', 'user-1');

      // Phase 1 completed
      expect(mockExtraction.extract).toHaveBeenCalled();
      expect(mockPrisma.memoryExtraction.create).toHaveBeenCalled();
      // Phase 2 failed gracefully (no throw)
      expect(mockPrisma.memory.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ embeddingId: expect.anything() }),
        }),
      );
    });
  });

  describe('retryFailedEmbeddings', () => {
    it('should retry failed embeddings and report results', async () => {
      // Fail an embedding first
      mockEmbedding.generate.mockRejectedValueOnce(new Error('down'));
      await service.generateAndStoreEmbedding('mem-1', 'hello', 'user-1');

      // Now retry succeeds; the DB still reports mem-1 as unembedded.
      mockEmbedding.generate.mockResolvedValueOnce([0.1, 0.2]);
      mockPrisma.memory.findMany.mockImplementation((args: any) =>
        Promise.resolve(args?.where?.id?.in ? [{ id: 'mem-1' }] : []),
      );

      const result = await service.retryFailedEmbeddings();
      expect(result.retried).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('should discover unembedded memories from DB', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        { id: 'mem-db-1', userId: 'user-1', raw: 'from db' },
      ]);
      mockEmbedding.generate.mockResolvedValue([0.1]);

      const result = await service.retryFailedEmbeddings();
      expect(result.discovered).toBe(1);
      expect(result.retried).toBe(1);
      expect(result.succeeded).toBe(1);
    });
  });

  describe('retryFailedEmbeddings — single-flight and bounded (ENG-61)', () => {
    const envKeys = [
      'EMBEDDING_RETRY_BATCH_SIZE',
      'EMBEDDING_RETRY_TIME_BUDGET_MS',
    ];
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const k of envKeys) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    });
    afterEach(() => {
      jest.restoreAllMocks();
      for (const k of envKeys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    const rows = (n: number, offset = 0) =>
      Array.from({ length: n }, (_, i) => ({
        id: `mem-${offset + i}`,
        userId: 'user-1',
        raw: `raw ${offset + i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 10_000 - offset - i)),
      }));

    /** discovery returns `discover`; the open-row re-check echoes the ids asked for */
    const mockDb = (discover: ReturnType<typeof rows>) => {
      mockPrisma.memory.findMany.mockImplementation((args: any) => {
        const ids = args?.where?.id?.in;
        if (ids) return Promise.resolve(ids.map((id: string) => ({ id })));
        return Promise.resolve(discover.slice(0, args.take));
      });
    };

    it('a call while the previous run is in flight is a no-op', async () => {
      mockDb(rows(3));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      mockEmbedding.generate.mockImplementation(() =>
        gate.then(() => [0.1, 0.2]),
      );

      const first = service.retryFailedEmbeddings();
      // Let the first run reach its first (blocked) embed call.
      await new Promise((r) => setImmediate(r));
      expect(mockEmbedding.generate).toHaveBeenCalledTimes(1);
      const findManyCalls = mockPrisma.memory.findMany.mock.calls.length;

      const second = await service.retryFailedEmbeddings();
      expect(second).toEqual({
        retried: 0,
        succeeded: 0,
        failed: 0,
        discovered: 0,
        exhaustedRetries: 0,
        skipped: true,
      });
      // No DB discovery and no extra embed call from the skipped tick.
      expect(mockPrisma.memory.findMany.mock.calls.length).toBe(findManyCalls);
      expect(mockEmbedding.generate).toHaveBeenCalledTimes(1);

      release();
      const firstResult = await first;
      expect(firstResult.skipped).toBeUndefined();
      expect(firstResult.retried).toBe(3);
      expect(mockEmbedding.generate).toHaveBeenCalledTimes(3);

      // Guard is released: the next call runs normally.
      const third = await service.retryFailedEmbeddings();
      expect(third.skipped).toBeUndefined();
    });

    it('releases the guard when a run throws', async () => {
      mockPrisma.memory.findMany.mockRejectedValueOnce(new Error('db down'));
      await expect(service.retryFailedEmbeddings()).rejects.toThrow('db down');
      mockDb([]);
      const next = await service.retryFailedEmbeddings();
      expect(next.skipped).toBeUndefined();
    });

    it('caps discovery and attempts at EMBEDDING_RETRY_BATCH_SIZE per run', async () => {
      process.env.EMBEDDING_RETRY_BATCH_SIZE = '5';
      const backlog = rows(12);
      mockDb(backlog);

      const result = await service.retryFailedEmbeddings();
      expect(result.discovered).toBe(5);
      expect(result.retried).toBe(5);
      expect(mockEmbedding.generate).toHaveBeenCalledTimes(5);
      const discovery = mockPrisma.memory.findMany.mock.calls[0][0];
      expect(discovery.take).toBe(5);
    });

    it('defaults to a batch of 100 per run', async () => {
      mockDb(rows(250));
      const result = await service.retryFailedEmbeddings();
      expect(result.discovered).toBe(100);
      expect(result.retried).toBe(100);
    });

    it('walks the backlog with a keyset cursor across runs and wraps', async () => {
      process.env.EMBEDDING_RETRY_BATCH_SIZE = '2';
      const backlog = rows(3);
      mockPrisma.memory.findMany.mockImplementation((args: any) => {
        const ids = args?.where?.id?.in;
        if (ids) return Promise.resolve(ids.map((id: string) => ({ id })));
        const cursorClause = args.where.AND[1];
        if (!cursorClause) return Promise.resolve(backlog.slice(0, args.take));
        const lt = cursorClause.OR[0].createdAt.lt as Date;
        return Promise.resolve(
          backlog.filter((r) => r.createdAt < lt).slice(0, args.take),
        );
      });

      const r1 = await service.retryFailedEmbeddings(); // mem-0, mem-1
      expect(r1.discovered).toBe(2);

      const r2 = await service.retryFailedEmbeddings(); // mem-2, then wrap
      expect(r2.discovered).toBe(1);
      const discoveryCalls = mockPrisma.memory.findMany.mock.calls
        .map((c: any[]) => c[0])
        .filter((a: any) => !a.where.id);
      expect(discoveryCalls[1].where.AND[1].OR[0].createdAt.lt).toEqual(
        backlog[1].createdAt,
      );

      await service.retryFailedEmbeddings();
      const discoveryCalls3 = mockPrisma.memory.findMany.mock.calls
        .map((c: any[]) => c[0])
        .filter((a: any) => !a.where.id);
      // Fewer than `take` rows came back last time → cursor reset to newest.
      expect(discoveryCalls3[2].where.AND[1]).toBeUndefined();
    });

    it('stops attempting new embeddings once the time budget is spent', async () => {
      process.env.EMBEDDING_RETRY_TIME_BUDGET_MS = '1000';
      mockDb(rows(10));
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      mockEmbedding.generate.mockImplementation(async () => {
        now += 400; // each embed "takes" 400 ms
        return [0.1];
      });

      const result = await service.retryFailedEmbeddings();
      // Attempts start at t=0, 400, 800; t=1200 is past the 1000 ms budget.
      expect(result.retried).toBe(3);
      expect(mockEmbedding.generate).toHaveBeenCalledTimes(3);
    });

    it('does not re-embed rows another path already finished', async () => {
      mockPrisma.memory.findMany.mockImplementation((args: any) => {
        if (args?.where?.id?.in) return Promise.resolve([{ id: 'mem-1' }]);
        return Promise.resolve(rows(3));
      });

      const result = await service.retryFailedEmbeddings();
      expect(result.retried).toBe(1);
      expect(mockEmbedding.generate).toHaveBeenCalledTimes(1);
      expect(mockEmbedding.generate).toHaveBeenCalledWith('raw 1');
      const status = await service.getEmbeddingStatus();
      expect(status.retryQueueSize).toBe(0);
    });
  });

  describe('getEmbeddingStatus', () => {
    it('should return counts', async () => {
      mockPrisma.memory.count
        .mockResolvedValueOnce(50) // with embedding
        .mockResolvedValueOnce(5); // without

      const status = await service.getEmbeddingStatus('user-1');
      expect(status.withEmbedding).toBe(50);
      expect(status.withoutEmbedding).toBe(5);
      expect(status.retryQueueSize).toBe(0);
      expect(status.exhaustedRetries).toBe(0);
    });
  });
});
