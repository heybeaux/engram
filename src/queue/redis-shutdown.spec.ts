import { flushAndDisconnectRedis } from './redis-shutdown';
import { QueueService } from './queue.service';
import { DeduplicationService } from '../deduplication/deduplication.service';
import { ReembeddingService } from '../reembedding/reembedding.service';

describe.each([QueueService, DeduplicationService, ReembeddingService])(
  '%p Redis ownership',
  (Service) => {
    it('disconnects its private client even when no jobs need persisting', async () => {
      const service = Object.create(Service.prototype);
      const redis = { disconnect: jest.fn() };
      service.redis = redis;
      service.jobs = new Map();
      await service.onModuleDestroy();
      expect(redis.disconnect).toHaveBeenCalledTimes(1);
      expect(service.redis).toBeNull();
      await service.onModuleDestroy();
      expect(redis.disconnect).toHaveBeenCalledTimes(1);
    });
  },
);

it('bounds shutdown when Redis persistence never responds', async () => {
  jest.useFakeTimers();
  try {
    const redis = { disconnect: jest.fn() };
    const closing = flushAndDisconnectRedis(redis, [new Promise(() => {})]);
    await jest.advanceTimersByTimeAsync(5000);
    await closing;
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});
