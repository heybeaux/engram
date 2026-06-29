import { Test, TestingModule } from '@nestjs/testing';
import { EmbeddingService, VectorSearchResult } from './embedding.service';
import { LLMService } from '../llm/llm.service';
import { VectorService } from '../vector/vector.service';
import { EmbeddingService as EmbedFacade } from '../embedding/embedding.service';
import { MemoryLayer } from '@prisma/client';

describe('EmbeddingService', () => {
  let service: EmbeddingService;
  let mockLlmService: jest.Mocked<LLMService>;
  let mockVectorService: jest.Mocked<VectorService>;
  let mockEmbedFacade: jest.Mocked<EmbedFacade>;

  const mockEmbedding = new Array(1536).fill(0).map(() => Math.random());

  beforeEach(async () => {
    mockLlmService = {
      embed: jest.fn(),
      chat: jest.fn(),
      json: jest.fn(),
      getProvider: jest.fn(),
      listProviders: jest.fn(),
      listEmbeddingProviders: jest.fn(),
    } as any;

    mockVectorService = {
      upsert: jest.fn(),
      upsertMany: jest.fn(),
      search: jest.fn(),
      delete: jest.fn(),
      deleteByUser: jest.fn(),
      getProviderName: jest.fn(),
      listProviders: jest.fn(),
    } as any;

    mockEmbedFacade = {
      embedOneWithOptions: jest.fn(),
      embedOne: jest.fn(),
      embed: jest.fn(),
      getModelName: jest.fn().mockReturnValue('bge-base-en-v1.5'),
      getDimensions: jest.fn().mockReturnValue(768),
      healthCheck: jest.fn(),
      getProviderName: jest.fn(),
      getProvider: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbeddingService,
        { provide: LLMService, useValue: mockLlmService },
        { provide: VectorService, useValue: mockVectorService },
        { provide: EmbedFacade, useValue: mockEmbedFacade },
      ],
    }).compile();

    service = module.get<EmbeddingService>(EmbeddingService);
  });

  describe('generate', () => {
    it('should generate embedding using EmbedFacade (write path uses same provider as recall)', async () => {
      mockEmbedFacade.embedOne.mockResolvedValue(mockEmbedding);

      const result = await service.generate('test text');

      expect(mockEmbedFacade.embedOne).toHaveBeenCalledWith('test text');
      expect(mockLlmService.embed).not.toHaveBeenCalled();
      expect(result).toEqual(mockEmbedding);
      expect(result.length).toBe(1536);
    });

    it('should update dimensions after generation', async () => {
      const embedding768 = new Array(768).fill(0);
      mockEmbedFacade.embedOne.mockResolvedValue(embedding768);

      await service.generate('test');

      expect(service.getDimensions()).toBe(768);
    });

    it('should fall back to LLM service when EmbedFacade is unavailable', async () => {
      // Build a service instance without the facade injected
      const moduleNoFacade = await Test.createTestingModule({
        providers: [
          EmbeddingService,
          { provide: LLMService, useValue: mockLlmService },
          { provide: VectorService, useValue: mockVectorService },
          // EmbedFacade intentionally omitted
        ],
      }).compile();
      const serviceNoFacade = moduleNoFacade.get<EmbeddingService>(EmbeddingService);

      mockLlmService.embed.mockResolvedValue({
        embedding: mockEmbedding,
        dimensions: 1536,
        model: 'text-embedding-3-small',
      });

      const result = await serviceNoFacade.generate('test text');

      expect(mockLlmService.embed).toHaveBeenCalledWith('test text');
      expect(result).toEqual(mockEmbedding);
    });

    it('should propagate errors from EmbedFacade', async () => {
      mockEmbedFacade.embedOne.mockRejectedValue(new Error('Embedding failed'));

      await expect(service.generate('test')).rejects.toThrow(
        'Embedding failed',
      );
    });
  });

  describe('generateForRecall', () => {
    it('should call embedOneWithOptions with recall priority and timeout', async () => {
      const recallEmbedding = new Array(768).fill(0.5);
      mockEmbedFacade.embedOneWithOptions.mockResolvedValue(recallEmbedding);

      const result = await service.generateForRecall('what do I know about X?');

      expect(mockEmbedFacade.embedOneWithOptions).toHaveBeenCalledWith(
        'what do I know about X?',
        { priority: 'recall', timeoutMs: 5_000 },
      );
      expect(result).toEqual(recallEmbedding);
    });

    it('should fall back to standard generate when priority embed fails', async () => {
      mockEmbedFacade.embedOneWithOptions.mockRejectedValue(
        new Error('timeout'),
      );
      // generate() now uses embedOne (facade) not llm.embed
      mockEmbedFacade.embedOne.mockResolvedValue(mockEmbedding);

      const result = await service.generateForRecall('fallback test');

      expect(result).toEqual(mockEmbedding);
      expect(mockEmbedFacade.embedOne).toHaveBeenCalledWith('fallback test');
    });

    it('should reset circuit breaker on successful recall embed', async () => {
      // Trip the circuit breaker with failures via generate() — facade fails
      mockEmbedFacade.embedOne.mockRejectedValue(new Error('down'));
      for (let i = 0; i < 5; i++) {
        await service.generate('fail').catch(() => {});
      }

      // Now recall succeeds via facade (embedOneWithOptions)
      const recallEmbedding = new Array(768).fill(0.1);
      mockEmbedFacade.embedOneWithOptions.mockResolvedValue(recallEmbedding);

      const result = await service.generateForRecall('recovery');
      expect(result).toEqual(recallEmbedding);

      // Circuit breaker should be reset — generate should work again
      mockEmbedFacade.embedOne.mockResolvedValue(mockEmbedding);
      const normalResult = await service.generate('normal');
      expect(normalResult).toEqual(mockEmbedding);
    });
  });

  describe('store', () => {
    it('should store embedding in vector service', async () => {
      mockVectorService.upsert.mockResolvedValue();

      const result = await service.store('memory-123', mockEmbedding);

      expect(mockVectorService.upsert).toHaveBeenCalledWith({
        id: 'memory-123',
        embedding: mockEmbedding,
        metadata: expect.objectContaining({
          userId: '',
          layer: MemoryLayer.SESSION,
          projectId: '',
          importance: 0.5,
        }),
      });
      expect(result).toBe('memory-123');
    });

    it('should include metadata when provided', async () => {
      mockVectorService.upsert.mockResolvedValue();
      const createdAt = new Date('2026-01-31T12:00:00Z');

      await service.store('memory-123', mockEmbedding, {
        userId: 'user-456',
        layer: MemoryLayer.IDENTITY,
        projectId: 'project-789',
        importance: 0.95,
        createdAt,
      });

      expect(mockVectorService.upsert).toHaveBeenCalledWith({
        id: 'memory-123',
        embedding: mockEmbedding,
        metadata: {
          userId: 'user-456',
          layer: MemoryLayer.IDENTITY,
          projectId: 'project-789',
          importance: 0.95,
          createdAt: createdAt.toISOString(),
        },
      });
    });

    it('should return the memory ID', async () => {
      mockVectorService.upsert.mockResolvedValue();

      const result = await service.store('my-memory-id', mockEmbedding);

      expect(result).toBe('my-memory-id');
    });
  });

  describe('search', () => {
    it('should search for similar embeddings', async () => {
      const searchResults: VectorSearchResult[] = [
        { id: 'memory-1', score: 0.95 },
        { id: 'memory-2', score: 0.88 },
      ];
      mockVectorService.search.mockResolvedValue(searchResults);

      const result = await service.search('user-123', mockEmbedding, 10);

      expect(mockVectorService.search).toHaveBeenCalledWith(mockEmbedding, {
        userId: 'user-123',
        limit: 10,
        filter: {
          layers: undefined,
          projectId: undefined,
        },
      });
      expect(result).toEqual(searchResults);
    });

    it('should filter by layers when provided', async () => {
      mockVectorService.search.mockResolvedValue([]);

      await service.search('user-123', mockEmbedding, 10, [
        MemoryLayer.IDENTITY,
        MemoryLayer.PROJECT,
      ]);

      expect(mockVectorService.search).toHaveBeenCalledWith(mockEmbedding, {
        userId: 'user-123',
        limit: 10,
        filter: {
          layers: [MemoryLayer.IDENTITY, MemoryLayer.PROJECT],
          projectId: undefined,
        },
      });
    });

    it('should filter by projectId when provided', async () => {
      mockVectorService.search.mockResolvedValue([]);

      await service.search(
        'user-123',
        mockEmbedding,
        10,
        undefined,
        'project-456',
      );

      expect(mockVectorService.search).toHaveBeenCalledWith(mockEmbedding, {
        userId: 'user-123',
        limit: 10,
        filter: {
          layers: undefined,
          projectId: 'project-456',
        },
      });
    });

    it('should use default limit of 10', async () => {
      mockVectorService.search.mockResolvedValue([]);

      await service.search('user-123', mockEmbedding);

      expect(mockVectorService.search).toHaveBeenCalledWith(
        mockEmbedding,
        expect.objectContaining({ limit: 10 }),
      );
    });
  });

  describe('delete', () => {
    it('should delete embedding from vector service', async () => {
      mockVectorService.delete.mockResolvedValue();

      await service.delete('memory-123');

      expect(mockVectorService.delete).toHaveBeenCalledWith('memory-123');
    });
  });

  describe('deleteAllForUser', () => {
    it('should delete all embeddings for a user', async () => {
      mockVectorService.deleteByUser.mockResolvedValue();

      await service.deleteAllForUser('user-456');

      expect(mockVectorService.deleteByUser).toHaveBeenCalledWith('user-456');
    });
  });

  describe('getDimensions', () => {
    it('should return default dimensions of 1536', () => {
      expect(service.getDimensions()).toBe(1536);
    });
  });

  describe('getProviderName', () => {
    it('should return provider name from vector service', () => {
      mockVectorService.getProviderName.mockReturnValue('pgvector');

      expect(service.getProviderName()).toBe('pgvector');
    });

    it('should return pinecone when configured', () => {
      mockVectorService.getProviderName.mockReturnValue('pinecone');

      expect(service.getProviderName()).toBe('pinecone');
    });
  });
});
