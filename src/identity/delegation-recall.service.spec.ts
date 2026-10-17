import { Test, TestingModule } from '@nestjs/testing';
import { DelegationRecallService } from './delegation-recall.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';

describe('DelegationRecallService', () => {
  let service: DelegationRecallService;
  let mockPrisma: any;
  let mockEmbedding: any;

  beforeEach(async () => {
    mockPrisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    mockEmbedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DelegationRecallService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbeddingService, useValue: mockEmbedding },
      ],
    }).compile();

    service = module.get<DelegationRecallService>(DelegationRecallService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('recall', () => {
    it('excludes hidden task memories', async () => {
      mockPrisma.memory.findMany.mockImplementation(async ({ where }: any) => {
        expect(where.userHidden).toBe(false);
        return [];
      });
      const result = await service.recall('Deploy application');
      expect(result.similarTasks).toEqual([]);
    });

    it('should return empty results when no similar tasks exist', async () => {
      const result = await service.recall('Deploy the application');

      expect(result.query).toBe('Deploy the application');
      expect(result.similarTasks).toEqual([]);
      expect(result.failurePatterns).toEqual([]);
      expect(result.recommendedAgent).toBeNull();
      expect(result.recommendationReason).toBeNull();
    });

    it('should find similar tasks and recommend agent', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        {
          id: 'mem1',
          raw: 'Task completed successfully: deploy app',
          subjectId: 'agent-deploy',
          importanceScore: 0.9,
          createdAt: new Date(),
          source: 'SYSTEM',
        },
        {
          id: 'mem2',
          raw: 'Task completed successfully: deploy service',
          subjectId: 'agent-deploy',
          importanceScore: 0.85,
          createdAt: new Date(),
          source: 'SYSTEM',
        },
      ]);

      const result = await service.recall('Deploy the new service');

      expect(result.similarTasks.length).toBe(2);
      expect(result.recommendedAgent).toBe('agent-deploy');
      expect(result.recommendationReason).toContain('agent-deploy');
      expect(result.recommendationReason).toContain('100%');
    });

    it('should identify failure patterns', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        {
          id: 'mem1',
          raw: 'Task failed: migration script crashed',
          subjectId: 'agent-1',
          importanceScore: 0.3,
          createdAt: new Date('2024-01-15'),
          source: 'SYSTEM',
        },
        {
          id: 'mem2',
          raw: 'Task partial completion: only 2 of 5 steps done',
          subjectId: 'agent-2',
          importanceScore: 0.4,
          createdAt: new Date('2024-02-01'),
          source: 'SYSTEM',
        },
      ]);

      const result = await service.recall('Run migration scripts');

      expect(result.failurePatterns.length).toBeGreaterThan(0);
    });

    it('should respect limit parameter', async () => {
      const memories = Array.from({ length: 20 }, (_, i) => ({
        id: `mem${i}`,
        raw: `Task completed: task ${i}`,
        subjectId: 'agent-1',
        importanceScore: 0.5 + i * 0.01,
        createdAt: new Date(),
        source: 'SYSTEM',
      }));
      mockPrisma.memory.findMany.mockResolvedValue(memories);

      const result = await service.recall('Do something', undefined, 3);

      expect(result.similarTasks.length).toBe(3);
    });

    it('should generate embeddings for the task query', async () => {
      await service.recall('Build a REST API');

      expect(mockEmbedding.embed).toHaveBeenCalledWith(['Build a REST API']);
    });

    it('should handle multiple agents and pick the best', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        {
          id: 'mem1',
          raw: 'Task completed successfully',
          subjectId: 'agent-good',
          importanceScore: 0.95,
          createdAt: new Date(),
          source: 'SYSTEM',
        },
        {
          id: 'mem2',
          raw: 'Task failed completely',
          subjectId: 'agent-bad',
          importanceScore: 0.2,
          createdAt: new Date(),
          source: 'SYSTEM',
        },
      ]);

      const result = await service.recall('Implement feature');

      expect(result.recommendedAgent).toBe('agent-good');
    });
  });
});
