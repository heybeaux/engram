import { MemoryJobProcessorService } from './memory-job-processor.service';
import { MemoryJobQueueService, MemoryJob } from './memory-job-queue.service';

describe('MemoryJobProcessorService', () => {
  let processor: MemoryJobProcessorService;
  let queue: MemoryJobQueueService;
  let mockPrisma: any;
  let mockPipeline: any;

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          externalId: 'ext-1',
          displayName: 'Test User',
          accountId: null,
        }),
      },
      $transaction: jest.fn((fn) => fn(mockPrisma)),
      $executeRawUnsafe: jest.fn(),
    };

    mockPipeline = {
      extractAndEmbed: jest.fn().mockResolvedValue(undefined),
    };

    queue = new MemoryJobQueueService();
    processor = new MemoryJobProcessorService(mockPrisma, mockPipeline, queue);
  });

  afterEach(() => {
    queue.onModuleDestroy();
  });

  it('should register processor on module init', () => {
    const spy = jest.spyOn(queue, 'registerProcessor');
    processor.onModuleInit();
    expect(spy).toHaveBeenCalledWith(expect.any(Function));
  });

  it('should call pipeline.extractAndEmbed for a job', async () => {
    const job: MemoryJob = {
      id: 'job-1',
      memoryId: 'mem-1',
      userId: 'user-1',
      raw: 'test memory',
      status: 'pending',
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await processor.processJob(job);

    expect(mockPipeline.extractAndEmbed).toHaveBeenCalledWith(
      'mem-1',
      'test memory',
      'user-1',
      undefined,
    );
  });

  it('should use RLS context when accountId is present', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      externalId: 'ext-1',
      displayName: 'Test',
      accountId: 'acc-123',
    });

    const job: MemoryJob = {
      id: 'job-2',
      memoryId: 'mem-2',
      userId: 'user-1',
      raw: 'test',
      status: 'pending',
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await processor.processJob(job);

    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('SET app.current_account_id'),
    );
  });
});
