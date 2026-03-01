import { Test, TestingModule } from '@nestjs/testing';
import { FeedbackService } from './feedback.service';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../prefetch/prefetch-cache.service';
import { AnticipatoryConfig } from '../anticipatory.config';

describe('FeedbackService', () => {
  let service: FeedbackService;
  let prisma: any;
  let redis: any;

  beforeEach(async () => {
    prisma = {
      anticipatoryEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      anticipatoryWeight: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
    };

    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      scanStream: jest.fn().mockReturnValue({
        on: jest.fn((event, cb) => {
          if (event === 'end') cb();
          return redis.scanStream();
        }),
      }),
      pipeline: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeedbackService,
        { provide: PrismaService, useValue: prisma },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = module.get(FeedbackService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('recordEvent', () => {
    it('should buffer events without writing to DB', () => {
      service.recordEvent({
        userId: 'user-1',
        recallId: 'recall-1',
        strategy: 'temporal',
        memoryId: 'mem-1',
        salience: 0.8,
        wasUseful: null,
        latencyMs: 50,
      });

      // No DB call until flush
      expect(prisma.anticipatoryEvent.createMany).not.toHaveBeenCalled();
    });
  });

  describe('flush', () => {
    it('should write buffered events to DB', async () => {
      service.recordEvent({
        userId: 'user-1',
        recallId: 'recall-1',
        strategy: 'temporal',
        memoryId: 'mem-1',
        salience: 0.8,
        wasUseful: null,
        latencyMs: 50,
      });
      service.recordEvent({
        userId: 'user-2',
        recallId: 'recall-2',
        strategy: 'graph',
        memoryId: 'mem-2',
        salience: 0.6,
        wasUseful: true,
        latencyMs: 30,
      });

      const count = await service.flush();

      expect(count).toBe(2);
      expect(prisma.anticipatoryEvent.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ userId: 'user-1', strategy: 'temporal' }),
          expect.objectContaining({ userId: 'user-2', strategy: 'graph' }),
        ]),
      });
    });

    it('should return 0 when buffer is empty', async () => {
      const count = await service.flush();
      expect(count).toBe(0);
      expect(prisma.anticipatoryEvent.createMany).not.toHaveBeenCalled();
    });

    it('should re-buffer events on DB failure', async () => {
      prisma.anticipatoryEvent.createMany.mockRejectedValueOnce(
        new Error('DB down'),
      );
      service.recordEvent({
        userId: 'user-1',
        recallId: 'r1',
        strategy: 'temporal',
        memoryId: 'm1',
        salience: 0.5,
        wasUseful: null,
        latencyMs: 10,
      });

      const count = await service.flush();
      expect(count).toBe(0);

      // Second flush should retry
      prisma.anticipatoryEvent.createMany.mockResolvedValueOnce({ count: 1 });
      const count2 = await service.flush();
      expect(count2).toBe(1);
    });
  });

  describe('recordFeedback', () => {
    it('should update existing event with feedback', async () => {
      prisma.anticipatoryEvent.findFirst.mockResolvedValue({
        id: 'event-1',
        strategy: 'temporal',
      });
      prisma.anticipatoryWeight.upsert.mockResolvedValue({});
      prisma.anticipatoryWeight.findUnique.mockResolvedValue({
        id: 'w-1',
        total: 5,
        successful: 3,
      });

      await service.recordFeedback('mem-1', 'recall-1', true, 'user-1');

      expect(prisma.anticipatoryEvent.update).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        data: { wasUseful: true },
      });
    });

    it('should handle missing event gracefully', async () => {
      prisma.anticipatoryEvent.findFirst.mockResolvedValue(null);

      // Should not throw
      await service.recordFeedback('mem-1', 'recall-1', false, 'user-1');
      expect(prisma.anticipatoryEvent.update).not.toHaveBeenCalled();
    });
  });

  describe('getWeights', () => {
    it('should return defaults when no weights exist', async () => {
      const weights = await service.getWeights('user-1');
      expect(weights).toEqual(AnticipatoryConfig.defaultWeights);
    });

    it('should return cached weights from memory', async () => {
      // Prime cache via getWeights with DB data
      prisma.anticipatoryWeight.findMany.mockResolvedValue([
        { strategy: 'temporal', weight: 0.9, total: 20 },
      ]);
      // Set minSamplesForLearning threshold
      const origMin = AnticipatoryConfig.minSamplesForLearning;
      AnticipatoryConfig.minSamplesForLearning = 10;

      const weights1 = await service.getWeights('user-cached');
      expect(weights1.temporal).toBe(0.9);

      // Second call should use in-memory cache
      prisma.anticipatoryWeight.findMany.mockClear();
      const weights2 = await service.getWeights('user-cached');
      expect(weights2.temporal).toBe(0.9);
      expect(prisma.anticipatoryWeight.findMany).not.toHaveBeenCalled();

      AnticipatoryConfig.minSamplesForLearning = origMin;
    });

    it('should return weights from Redis cache', async () => {
      const cachedWeights = { temporal: 0.75, graph: 0.6 };
      redis.get.mockResolvedValueOnce(JSON.stringify(cachedWeights));

      const weights = await service.getWeights('user-redis');
      expect(weights).toEqual(cachedWeights);
      expect(prisma.anticipatoryWeight.findMany).not.toHaveBeenCalled();
    });

    it('should ignore weights with insufficient samples', async () => {
      prisma.anticipatoryWeight.findMany.mockResolvedValue([
        { strategy: 'temporal', weight: 0.1, total: 1 },
      ]);

      const weights = await service.getWeights('user-lowsample');
      // Should use default, not 0.1
      expect(weights.temporal).toBe(AnticipatoryConfig.defaultWeights.temporal);
    });
  });

  describe('onModuleDestroy', () => {
    it('should clear flush interval and flush remaining', async () => {
      service.recordEvent({
        userId: 'u1',
        recallId: 'r1',
        strategy: 's1',
        memoryId: 'm1',
        salience: 0.5,
        wasUseful: null,
        latencyMs: 10,
      });

      service.onModuleDestroy();

      // Flush is called on destroy (fire-and-forget)
      // Just ensure no error
    });
  });
});
