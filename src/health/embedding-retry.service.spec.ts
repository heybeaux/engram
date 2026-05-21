import { Test, TestingModule } from '@nestjs/testing';
import { EmbeddingRetryService } from './embedding-retry.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbedHealthService } from './embed-health.service';
import { EmbeddingService } from '../memory/embedding.service';

const mockPrisma = {
  memory: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
};

const mockEmbedHealth = {
  isAvailable: jest.fn(),
};

const mockEmbeddingService = {
  generate: jest.fn(),
  store: jest.fn(),
};

describe('EmbeddingRetryService', () => {
  let service: EmbeddingRetryService;

  beforeEach(async () => {
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbeddingRetryService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbedHealthService, useValue: mockEmbedHealth },
        { provide: EmbeddingService, useValue: mockEmbeddingService },
      ],
    }).compile();

    service = module.get<EmbeddingRetryService>(EmbeddingRetryService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should set up an interval timer', () => {
      service.onModuleInit();
      expect((service as any).timer).not.toBeNull();
    });
  });

  describe('onModuleDestroy', () => {
    it('should clear the interval timer', () => {
      service.onModuleInit();
      expect((service as any).timer).not.toBeNull();

      service.onModuleDestroy();
      expect((service as any).timer).toBeNull();
    });

    it('should handle being called when no timer exists', () => {
      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });

  describe('retryPendingEmbeddings', () => {
    it('should skip when embed service is not available', async () => {
      mockEmbedHealth.isAvailable.mockResolvedValue(false);

      await service.retryPendingEmbeddings();

      expect(mockEmbedHealth.isAvailable).toHaveBeenCalled();
      expect(mockPrisma.memory.findMany).not.toHaveBeenCalled();
    });

    it('should skip when no pending memories found', async () => {
      mockEmbedHealth.isAvailable.mockResolvedValue(true);
      mockPrisma.memory.findMany.mockResolvedValue([]);

      await service.retryPendingEmbeddings();

      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith({
        where: { embeddingId: null, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          raw: true,
          userId: true,
          layer: true,
          importanceScore: true,
        },
      });
      expect(mockEmbeddingService.generate).not.toHaveBeenCalled();
    });

    it('should generate and store embeddings for pending memories', async () => {
      mockEmbedHealth.isAvailable.mockResolvedValue(true);
      const pendingMemories = [
        {
          id: 'mem-1',
          raw: 'text 1',
          userId: 'u1',
          layer: 'EPISODIC',
          importanceScore: 0.8,
        },
        {
          id: 'mem-2',
          raw: 'text 2',
          userId: 'u1',
          layer: 'SEMANTIC',
          importanceScore: 0.6,
        },
      ];
      mockPrisma.memory.findMany.mockResolvedValue(pendingMemories);
      mockEmbeddingService.generate.mockResolvedValue([0.1, 0.2, 0.3]);
      mockEmbeddingService.store
        .mockResolvedValueOnce('emb-1')
        .mockResolvedValueOnce('emb-2');
      mockPrisma.memory.update.mockResolvedValue({});

      await service.retryPendingEmbeddings();

      expect(mockEmbeddingService.generate).toHaveBeenCalledTimes(2);
      expect(mockEmbeddingService.store).toHaveBeenCalledWith(
        'mem-1',
        [0.1, 0.2, 0.3],
        {
          userId: 'u1',
          layer: 'EPISODIC',
          importance: 0.8,
        },
      );
      expect(mockPrisma.memory.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'mem-1' },
        data: { embeddingId: 'emb-1' },
      });
    });

    it('should stop batch after 3 consecutive failures', async () => {
      mockEmbedHealth.isAvailable.mockResolvedValue(true);
      const pendingMemories = [
        {
          id: 'mem-1',
          raw: 'text 1',
          userId: 'u1',
          layer: 'EPISODIC',
          importanceScore: 0.5,
        },
        {
          id: 'mem-2',
          raw: 'text 2',
          userId: 'u1',
          layer: 'EPISODIC',
          importanceScore: 0.5,
        },
        {
          id: 'mem-3',
          raw: 'text 3',
          userId: 'u1',
          layer: 'EPISODIC',
          importanceScore: 0.5,
        },
        {
          id: 'mem-4',
          raw: 'text 4',
          userId: 'u1',
          layer: 'EPISODIC',
          importanceScore: 0.5,
        },
      ];
      mockPrisma.memory.findMany.mockResolvedValue(pendingMemories);
      mockEmbeddingService.generate.mockRejectedValue(new Error('embed down'));

      await service.retryPendingEmbeddings();

      // Should stop after 3 failures, not attempt the 4th
      expect(mockEmbeddingService.generate).toHaveBeenCalledTimes(3);
    });

    it('should continue after individual failures until threshold', async () => {
      mockEmbedHealth.isAvailable.mockResolvedValue(true);
      const pendingMemories = [
        {
          id: 'mem-1',
          raw: 'text 1',
          userId: 'u1',
          layer: 'EPISODIC',
          importanceScore: 0.5,
        },
        {
          id: 'mem-2',
          raw: 'text 2',
          userId: 'u1',
          layer: 'EPISODIC',
          importanceScore: 0.5,
        },
        {
          id: 'mem-3',
          raw: 'text 3',
          userId: 'u1',
          layer: 'EPISODIC',
          importanceScore: 0.5,
        },
      ];
      mockPrisma.memory.findMany.mockResolvedValue(pendingMemories);
      mockEmbeddingService.generate
        .mockResolvedValueOnce([0.1]) // success
        .mockRejectedValueOnce(new Error('fail')) // fail 1
        .mockRejectedValueOnce(new Error('fail')); // fail 2 — should not reach 3 failures to stop

      mockEmbeddingService.store.mockResolvedValue('emb-1');
      mockPrisma.memory.update.mockResolvedValue({});

      await service.retryPendingEmbeddings();

      expect(mockEmbeddingService.generate).toHaveBeenCalledTimes(3);
      expect(mockPrisma.memory.update).toHaveBeenCalledTimes(1);
    });
  });
});
