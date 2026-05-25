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
      memoryExtraction: { create: jest.fn().mockResolvedValue({}) },
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

      // Now retry succeeds
      mockEmbedding.generate.mockResolvedValueOnce([0.1, 0.2]);

      const result = await service.retryFailedEmbeddings();
      expect(result.retried).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('should NOT sweep the DB for unembedded memories (extraction is sync at write time)', async () => {
      // Cron path must only retry in-memory transient failures — it must not
      // discover work from the DB. That lazy-cron path was a backlog trap.
      mockPrisma.memory.findMany.mockResolvedValue([
        { id: 'mem-db-1', userId: 'user-1', raw: 'from db' },
      ]);
      mockEmbedding.generate.mockResolvedValue([0.1]);

      const result = await service.retryFailedEmbeddings();
      expect(mockPrisma.memory.findMany).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('discovered');
      expect(result.retried).toBe(0);
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
