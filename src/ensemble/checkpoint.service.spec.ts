import { Test, TestingModule } from '@nestjs/testing';
import { CheckpointService } from './checkpoint.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReembedCheckpoint } from './ensemble.types';

describe('CheckpointService', () => {
  let service: CheckpointService;
  let prisma: {
    ensembleReembedCheckpoint: {
      upsert: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      deleteMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      ensembleReembedCheckpoint: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckpointService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CheckpointService>(CheckpointService);
  });

  const mockCheckpoint: ReembedCheckpoint = {
    jobId: 'test-job-1',
    createdAt: new Date('2026-02-27T00:00:00Z'),
    lastProcessedId: 'mem-123',
    progress: { processed: 50, total: 100, percentage: 50 } as any,
    completedModels: [] as any,
    metrics: {} as any,
  };

  describe('save', () => {
    it('should upsert a checkpoint', async () => {
      prisma.ensembleReembedCheckpoint.upsert.mockResolvedValue(mockCheckpoint);

      await service.save(mockCheckpoint);

      expect(prisma.ensembleReembedCheckpoint.upsert).toHaveBeenCalledWith({
        where: { jobId: 'test-job-1' },
        create: expect.objectContaining({ jobId: 'test-job-1' }),
        update: expect.objectContaining({ lastProcessedId: 'mem-123' }),
      });
    });
  });

  describe('get', () => {
    it('should return a checkpoint when found', async () => {
      prisma.ensembleReembedCheckpoint.findUnique.mockResolvedValue({
        jobId: 'test-job-1',
        createdAt: new Date('2026-02-27T00:00:00Z'),
        lastProcessedId: 'mem-123',
        progress: { processed: 50, total: 100 },
        completedModels: [],
        metrics: {},
      });

      const result = await service.get('test-job-1');

      expect(result).not.toBeNull();
      expect(result!.jobId).toBe('test-job-1');
      expect(result!.lastProcessedId).toBe('mem-123');
    });

    it('should return null when not found', async () => {
      prisma.ensembleReembedCheckpoint.findUnique.mockResolvedValue(null);

      const result = await service.get('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete by jobId', async () => {
      prisma.ensembleReembedCheckpoint.deleteMany.mockResolvedValue({
        count: 1,
      });

      await service.delete('test-job-1');

      expect(prisma.ensembleReembedCheckpoint.deleteMany).toHaveBeenCalledWith({
        where: { jobId: 'test-job-1' },
      });
    });
  });

  describe('findActiveCheckpoint', () => {
    it('should return the most recent non-stale checkpoint', async () => {
      prisma.ensembleReembedCheckpoint.findFirst.mockResolvedValue({
        jobId: 'active-job',
        createdAt: new Date(),
        lastProcessedId: 'mem-456',
        progress: { processed: 10, total: 50 },
        completedModels: [],
        metrics: {},
      });

      const result = await service.findActiveCheckpoint();

      expect(result).not.toBeNull();
      expect(result!.jobId).toBe('active-job');
      expect(prisma.ensembleReembedCheckpoint.findFirst).toHaveBeenCalledWith({
        where: { createdAt: { gt: expect.any(Date) } },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should return null when no active checkpoints', async () => {
      prisma.ensembleReembedCheckpoint.findFirst.mockResolvedValue(null);

      const result = await service.findActiveCheckpoint();

      expect(result).toBeNull();
    });
  });

  describe('listActive', () => {
    it('should return all non-stale checkpoints', async () => {
      prisma.ensembleReembedCheckpoint.findMany.mockResolvedValue([
        {
          jobId: 'job-1',
          createdAt: new Date(),
          lastProcessedId: 'mem-1',
          progress: {},
          completedModels: [],
          metrics: {},
        },
        {
          jobId: 'job-2',
          createdAt: new Date(),
          lastProcessedId: 'mem-2',
          progress: {},
          completedModels: [],
          metrics: {},
        },
      ]);

      const result = await service.listActive();

      expect(result).toHaveLength(2);
      expect(result[0].jobId).toBe('job-1');
    });
  });

  describe('cleanupStale', () => {
    it('should delete stale checkpoints and return count', async () => {
      prisma.ensembleReembedCheckpoint.deleteMany.mockResolvedValue({
        count: 3,
      });

      const result = await service.cleanupStale();

      expect(result).toBe(3);
      expect(prisma.ensembleReembedCheckpoint.deleteMany).toHaveBeenCalledWith({
        where: { createdAt: { lt: expect.any(Date) } },
      });
    });

    it('should return 0 when no stale checkpoints', async () => {
      prisma.ensembleReembedCheckpoint.deleteMany.mockResolvedValue({
        count: 0,
      });

      const result = await service.cleanupStale();

      expect(result).toBe(0);
    });
  });
});
