import { MemoryWriteService } from './memory-write.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractionService } from './extraction.service';
import { EmbeddingService } from './embedding.service';
import { ImportanceService } from './importance.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import { EmbeddingQueueProducer } from './embedding-queue.producer';
import { ImportanceHint, MemoryLayer, MemorySource } from '@prisma/client';
import { ElasticsearchService } from '../search/elasticsearch.service';

describe('MemoryWriteService', () => {
  let service: MemoryWriteService;
  let mockPrisma: any;
  let mockExtraction: any;
  let mockEmbedding: any;
  let mockImportance: any;
  let mockPipelineService: any;
  let mockEmbeddingQueue: any;
  let mockElasticsearchService: Partial<ElasticsearchService>;

  const mockMemory = {
    id: 'mem-123',
    userId: 'user-456',
    raw: 'Test memory content',
    layer: MemoryLayer.SESSION,
    source: MemorySource.EXPLICIT_STATEMENT,
    importanceHint: ImportanceHint.MEDIUM,
    importanceScore: 0.5,
    confidence: 1.0,
    retrievalCount: 0,
    usedCount: 0,
    consolidated: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  beforeEach(() => {
    mockPrisma = {
      memory: {
        create: jest.fn(),
        createMany: jest.fn(),
        findMany: jest.fn(),
      },
      session: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new-session' }),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'user-456', externalId: 'TestUser' }),
      },
    };

    mockExtraction = {
      extract: jest.fn().mockResolvedValue({
        who: null,
        what: 'Test',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
        memoryType: null,
        typeConfidence: null,
        confidence: {
          whoConfidence: null,
          whatConfidence: null,
          whenConfidence: null,
          whereConfidence: null,
          whyConfidence: null,
          howConfidence: null,
        },
        lesson: null,
      }),
      getPriorityForType: jest.fn().mockReturnValue(3),
      classifyLayer: jest.fn().mockReturnValue('SESSION'),
    };

    mockEmbedding = {
      generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      store: jest.fn().mockResolvedValue('embed-123'),
      search: jest.fn().mockResolvedValue([]),
    };

    mockImportance = {
      calculate: jest.fn(),
    };

    mockPipelineService = {
      extractAndEmbed: jest.fn().mockResolvedValue(undefined),
      storeEntities: jest.fn().mockResolvedValue(undefined),
      linkRelatedMemories: jest.fn().mockResolvedValue(undefined),
    };

    mockEmbeddingQueue = {
      enqueueEmbedding: jest.fn().mockResolvedValue(undefined),
    };

    mockElasticsearchService = {
      indexMemory: jest.fn().mockResolvedValue(undefined),
    };

    service = new MemoryWriteService(
      mockPrisma,
      mockExtraction,
      mockEmbedding,
      mockImportance,
      mockPipelineService,
      mockElasticsearchService as ElasticsearchService,
      undefined, // correctionService
      undefined, // memoryPoolService
      undefined, // memoryAccessLogService
      undefined, // eventEmitter
      mockEmbeddingQueue,
    );
  });

  describe('remember', () => {
    it('should create a memory with calculated importance', async () => {
      mockImportance.calculate.mockReturnValue(0.6);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      const result = await service.remember('user-456', {
        raw: 'Test memory content',
        layer: MemoryLayer.SESSION,
        importanceHint: ImportanceHint.MEDIUM,
      });

      expect(mockImportance.calculate).toHaveBeenCalledWith({
        hint: ImportanceHint.MEDIUM,
        layer: MemoryLayer.SESSION,
      });
      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-456',
          raw: 'Test memory content',
          layer: MemoryLayer.SESSION,
          source: MemorySource.EXPLICIT_STATEMENT,
          importanceHint: ImportanceHint.MEDIUM,
          importanceScore: 0.6,
        }),
      });
      expect(result).toEqual(mockMemory);
    });

    it('should default to SESSION layer when not specified', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      await service.remember('user-456', { raw: 'Test' });

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          layer: MemoryLayer.SESSION,
        }),
      });
    });

    it('should include project and session context when provided', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);
      mockPrisma.session.findUnique.mockResolvedValue({ id: 'session-456' });

      await service.remember('user-456', {
        raw: 'Test',
        context: {
          projectId: 'project-123',
          sessionId: 'session-456',
        },
      });

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          projectId: 'project-123',
          sessionId: 'session-456',
        }),
      });
    });

    it('should enqueue embedding via EmbeddingQueueProducer (HEY-462: async dedup)', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      const result = await service.remember('user-456', { raw: 'Test' });

      expect(result).toEqual(mockMemory);
      expect(mockEmbeddingQueue.enqueueEmbedding).toHaveBeenCalledWith({
        memoryId: mockMemory.id,
        userId: 'user-456',
        raw: 'Test',
        runDedup: true,
      });
    });

    it('should throw when no content provided', async () => {
      await expect(service.remember('user-456', {} as any)).rejects.toThrow(
        'Memory content is required',
      );
    });

    it('should persist tags when provided (ENG-42)', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue({
        ...mockMemory,
        tags: ['google-ads', 'campaign'],
      });

      await service.remember('user-456', {
        raw: 'Campaign launched for Google Ads',
        tags: ['google-ads', 'campaign'],
      });

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tags: ['google-ads', 'campaign'],
        }),
      });
    });

    it('should default tags to empty array when not provided (ENG-42)', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      await service.remember('user-456', { raw: 'No tags here' });

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tags: [],
        }),
      });
    });
  });

  describe('rememberAll', () => {
    it('should create multiple memories in batch', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      const result = await service.rememberAll('user-456', {
        memories: [
          { raw: 'Memory 1' },
          { raw: 'Memory 2' },
          { raw: 'Memory 3' },
        ],
      });

      expect(mockPrisma.memory.create).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ created: 3, failed: 0 });
    });

    it('should count failures without stopping batch', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create
        .mockResolvedValueOnce(mockMemory)
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce(mockMemory);

      const result = await service.rememberAll('user-456', {
        memories: [
          { raw: 'Memory 1' },
          { raw: 'Memory 2' },
          { raw: 'Memory 3' },
        ],
      });

      expect(result).toEqual({ created: 2, failed: 1 });
    });

    it('should respect individual memory settings', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      await service.rememberAll('user-456', {
        memories: [
          {
            raw: 'Memory 1',
            layer: MemoryLayer.IDENTITY,
            importanceHint: ImportanceHint.CRITICAL,
          },
        ],
        context: { projectId: 'project-123' },
      });

      expect(mockImportance.calculate).toHaveBeenCalledWith({
        hint: ImportanceHint.CRITICAL,
        layer: MemoryLayer.IDENTITY,
      });
    });
  });

  describe('chunkText', () => {
    it('should return single chunk for short text', () => {
      const result = service.chunkText('Short text.', 3500);
      expect(result).toEqual(['Short text.']);
    });

    it('should split on paragraph boundaries', () => {
      const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
      const result = service.chunkText(text, 20);
      expect(result.length).toBeGreaterThan(1);
    });

    it('should split long paragraphs on sentence boundaries', () => {
      const text = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
      const result = service.chunkText(text, 30);
      expect(result.length).toBeGreaterThan(1);
    });
  });

  describe('resolveSessionId', () => {
    it('should return undefined when no sessionId provided', async () => {
      const result = await service.resolveSessionId('user-456');
      expect(result).toBeUndefined();
    });

    it('should return existing session ID when found by ID', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ id: 'session-123' });

      const result = await service.resolveSessionId('user-456', 'session-123');
      expect(result).toBe('session-123');
    });

    it('should return existing session ID when found by external ID', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);
      mockPrisma.session.findFirst.mockResolvedValue({ id: 'internal-id' });

      const result = await service.resolveSessionId('user-456', 'external-id');
      expect(result).toBe('internal-id');
    });

    it('should create new session when not found', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);
      mockPrisma.session.findFirst.mockResolvedValue(null);
      mockPrisma.session.create.mockResolvedValue({ id: 'new-session-id' });

      const result = await service.resolveSessionId('user-456', 'new-session');
      expect(result).toBe('new-session-id');
      expect(mockPrisma.session.create).toHaveBeenCalledWith({
        data: { userId: 'user-456', externalId: 'new-session' },
      });
    });
  });
});
