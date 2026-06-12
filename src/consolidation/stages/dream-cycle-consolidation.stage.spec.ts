import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DreamCycleConsolidationStage } from './dream-cycle-consolidation.stage';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { EmbeddingService } from '../../embedding/embedding.service';
import { LLMService } from '../../llm/llm.service';
import { EmbeddingWriteService } from '../../vector/embedding-write.service';

describe('DreamCycleConsolidationStage', () => {
  let stage: DreamCycleConsolidationStage;
  let prisma: jest.Mocked<ServicePrismaService>;
  let llmService: jest.Mocked<LLMService>;
  let embeddingService: jest.Mocked<EmbeddingService>;

  const configValues: Record<string, string> = {};

  beforeEach(async () => {
    configValues['DREAM_CONSOLIDATION_SIMILARITY'] = '0.82';
    configValues['DREAM_CONSOLIDATION_MIN_CLUSTER'] = '3';
    configValues['DREAM_MAX_CONSOLIDATIONS'] = '10';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DreamCycleConsolidationStage,
        {
          provide: ServicePrismaService,
          useValue: {
            $queryRaw: jest.fn().mockResolvedValue([]),
            $transaction: jest.fn(),
            $executeRaw: jest.fn(),
            memory: {
              create: jest.fn(),
              updateMany: jest.fn(),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => configValues[key] ?? undefined),
          },
        },
        {
          provide: EmbeddingService,
          useValue: {
            embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
          },
        },
        {
          provide: LLMService,
          useValue: {
            chat: jest
              .fn()
              .mockResolvedValue({ content: 'Consolidated memory content' }),
          },
        },
        {
          provide: EmbeddingWriteService,
          useValue: {
            writeLegacyInlineEmbedding: jest.fn().mockResolvedValue(undefined),
            writeMemoryEmbedding: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    stage = module.get(DreamCycleConsolidationStage);
    prisma = module.get(ServicePrismaService);
    llmService = module.get(LLMService);
    embeddingService = module.get(EmbeddingService);
  });

  // Helper to make a normalized vector
  function makeVec(seed: number): number[] {
    const v = Array.from({ length: 3 }, (_, i) => Math.sin(seed + i));
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / norm);
  }

  describe('clusterMemories', () => {
    it('should cluster memories with high similarity', () => {
      const vec = makeVec(1);
      const memories = [
        { id: '1', content: 'a', embedding: vec },
        { id: '2', content: 'b', embedding: vec },
        { id: '3', content: 'c', embedding: vec },
      ];
      const clusters = stage.clusterMemories(memories);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toHaveLength(3);
    });

    it('should not cluster memories below similarity threshold', () => {
      const memories = [
        { id: '1', content: 'a', embedding: [1, 0, 0] },
        { id: '2', content: 'b', embedding: [0, 1, 0] },
        { id: '3', content: 'c', embedding: [0, 0, 1] },
      ];
      const clusters = stage.clusterMemories(memories);
      expect(clusters).toHaveLength(0);
    });

    it('should enforce minimum cluster size', () => {
      const vec = makeVec(1);
      const memories = [
        { id: '1', content: 'a', embedding: vec },
        { id: '2', content: 'b', embedding: vec },
        // Only 2 — below default min of 3
      ];
      const clusters = stage.clusterMemories(memories);
      expect(clusters).toHaveLength(0);
    });

    it('should skip memories without embeddings', () => {
      const vec = makeVec(1);
      const memories = [
        { id: '1', content: 'a', embedding: null },
        { id: '2', content: 'b', embedding: vec },
        { id: '3', content: 'c', embedding: vec },
        { id: '4', content: 'd', embedding: vec },
      ];
      const clusters = stage.clusterMemories(memories);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toHaveLength(3);
      expect(clusters[0].find((m) => m.id === '1')).toBeUndefined();
    });
  });

  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      expect(stage.cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    });

    it('should return 0 for orthogonal vectors', () => {
      expect(stage.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    });

    it('should handle zero vectors', () => {
      expect(stage.cosineSimilarity([0, 0], [1, 0])).toBe(0);
    });
  });

  describe('run', () => {
    it('should return early when too few cold memories', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      const result = await stage.run('user1', false);
      expect(result.clustersFound).toBe(0);
      expect(result.consolidated).toBe(0);
    });

    it('should consolidate clusters and call LLM', async () => {
      const vec = makeVec(1);
      const vecStr = `[${vec.join(',')}]`;
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        { id: '1', content: 'mem1', embedding: vecStr },
        { id: '2', content: 'mem2', embedding: vecStr },
        { id: '3', content: 'mem3', embedding: vecStr },
      ]);

      const newMemory = { id: 'new-1' };
      (prisma.$transaction as jest.Mock).mockImplementation(async (fn) => {
        const tx = {
          memory: {
            create: jest.fn().mockResolvedValue(newMemory),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 3 }),
          },
          $executeRaw: jest.fn(),
        };
        return fn(tx);
      });

      const result = await stage.run('user1', false);
      expect(result.clustersFound).toBe(1);
      expect(result.consolidated).toBe(1);
      expect(result.archived).toBe(3);
      expect(result.llmCalls).toBe(1);
      expect(llmService.chat).toHaveBeenCalledTimes(1);
      expect(embeddingService.embed).toHaveBeenCalledTimes(1);
    });

    it('should include userId in archive updateMany to prevent cross-account leakage', async () => {
      const vec = makeVec(1);
      const vecStr = `[${vec.join(',')}]`;
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        { id: '1', content: 'mem1', embedding: vecStr },
        { id: '2', content: 'mem2', embedding: vecStr },
        { id: '3', content: 'mem3', embedding: vecStr },
      ]);

      let capturedUpdateMany: any;
      (prisma.$transaction as jest.Mock).mockImplementation(async (fn) => {
        const tx = {
          memory: {
            create: jest.fn().mockResolvedValue({ id: 'new-1' }),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockImplementation((args) => {
              capturedUpdateMany = args;
              return { count: 3 };
            }),
          },
          $executeRaw: jest.fn(),
        };
        return fn(tx);
      });

      await stage.run('user1', false);

      // The archive updateMany must include userId for account isolation
      expect(capturedUpdateMany.where).toHaveProperty('userId', 'user1');
    });

    it('should respect max consolidations cap', async () => {
      // Create enough memories for multiple clusters by using different vectors
      const vecs = Array.from({ length: 15 }, (_, i) => {
        // 5 groups of 3, each group shares a vector
        const group = Math.floor(i / 3);
        return makeVec(group * 100);
      });

      (prisma.$queryRaw as jest.Mock).mockResolvedValue(
        vecs.map((v, i) => ({
          id: `mem-${i}`,
          content: `content ${i}`,
          embedding: `[${v.join(',')}]`,
        })),
      );

      (prisma.$transaction as jest.Mock).mockImplementation(async (fn) => {
        const tx = {
          memory: {
            create: jest.fn().mockResolvedValue({ id: `new-${Math.random()}` }),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 3 }),
          },
          $executeRaw: jest.fn(),
        };
        return fn(tx);
      });

      // Set max to 2
      configValues['DREAM_MAX_CONSOLIDATIONS'] = '2';
      const module = await Test.createTestingModule({
        providers: [
          DreamCycleConsolidationStage,
          { provide: ServicePrismaService, useValue: prisma },
          {
            provide: ConfigService,
            useValue: {
              get: (key: string) => configValues[key] ?? undefined,
            },
          },
          { provide: EmbeddingService, useValue: embeddingService },
          { provide: LLMService, useValue: llmService },
          {
            provide: EmbeddingWriteService,
            useValue: {
              writeLegacyInlineEmbedding: jest.fn().mockResolvedValue(undefined),
              writeMemoryEmbedding: jest.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }).compile();

      const capped = module.get(DreamCycleConsolidationStage);
      const result = await capped.run('user1', false);
      expect(result.consolidated).toBeLessThanOrEqual(2);
    });

    it('should not call LLM in dry run mode', async () => {
      const vec = makeVec(1);
      const vecStr = `[${vec.join(',')}]`;
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        { id: '1', content: 'mem1', embedding: vecStr },
        { id: '2', content: 'mem2', embedding: vecStr },
        { id: '3', content: 'mem3', embedding: vecStr },
      ]);

      const result = await stage.run('user1', true);
      expect(result.clustersFound).toBe(1);
      expect(result.consolidated).toBe(1);
      expect(result.llmCalls).toBe(0);
      expect(llmService.chat).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should count errors and continue', async () => {
      const vec = makeVec(1);
      const vecStr = `[${vec.join(',')}]`;
      // Two clusters worth
      const vec2 = makeVec(200);
      const vecStr2 = `[${vec2.join(',')}]`;
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        { id: '1', content: 'a', embedding: vecStr },
        { id: '2', content: 'b', embedding: vecStr },
        { id: '3', content: 'c', embedding: vecStr },
        { id: '4', content: 'd', embedding: vecStr2 },
        { id: '5', content: 'e', embedding: vecStr2 },
        { id: '6', content: 'f', embedding: vecStr2 },
      ]);

      let callCount = 0;
      (prisma.$transaction as jest.Mock).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('DB error');
        return;
      });

      const result = await stage.run('user1', false);
      expect(result.errors).toBeGreaterThanOrEqual(1);
    });
  });

  describe('env var defaults', () => {
    it('should use defaults when env vars are not set', async () => {
      const module = await Test.createTestingModule({
        providers: [
          DreamCycleConsolidationStage,
          { provide: ServicePrismaService, useValue: prisma },
          {
            provide: ConfigService,
            useValue: { get: () => undefined },
          },
          { provide: EmbeddingService, useValue: embeddingService },
          { provide: LLMService, useValue: llmService },
          {
            provide: EmbeddingWriteService,
            useValue: {
              writeLegacyInlineEmbedding: jest.fn().mockResolvedValue(undefined),
              writeMemoryEmbedding: jest.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }).compile();

      const defaultStage = module.get(DreamCycleConsolidationStage);
      // Access private fields via any
      expect((defaultStage as any).similarityThreshold).toBe(0.82);
      expect((defaultStage as any).minClusterSize).toBe(3);
      expect((defaultStage as any).maxConsolidations).toBe(10);
    });
  });
});
