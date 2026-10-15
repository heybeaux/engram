import { EmbeddingRetryCron } from './embedding-retry.cron';
import { MemoryPipelineService } from './memory-pipeline.service';

describe('EmbeddingRetryCron (ENG-61)', () => {
  const originalFlag = process.env.EMBEDDING_RETRY_CRON_ENABLED;
  let pipeline: { retryFailedEmbeddings: jest.Mock };
  let cron: EmbeddingRetryCron;

  beforeEach(() => {
    delete process.env.EMBEDDING_RETRY_CRON_ENABLED;
    pipeline = {
      retryFailedEmbeddings: jest.fn().mockResolvedValue({
        retried: 0,
        succeeded: 0,
        failed: 0,
        discovered: 0,
        exhaustedRetries: 0,
      }),
    };
    cron = new EmbeddingRetryCron(pipeline as unknown as MemoryPipelineService);
  });

  afterAll(() => {
    if (originalFlag === undefined)
      delete process.env.EMBEDDING_RETRY_CRON_ENABLED;
    else process.env.EMBEDDING_RETRY_CRON_ENABLED = originalFlag;
  });

  it('runs the retry by default (flag unset)', async () => {
    await cron.handleRetry();
    expect(pipeline.retryFailedEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('runs the retry when EMBEDDING_RETRY_CRON_ENABLED=true', async () => {
    process.env.EMBEDDING_RETRY_CRON_ENABLED = 'true';
    await cron.handleRetry();
    expect(pipeline.retryFailedEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when EMBEDDING_RETRY_CRON_ENABLED=false', async () => {
    process.env.EMBEDDING_RETRY_CRON_ENABLED = 'false';
    await cron.handleRetry();
    expect(pipeline.retryFailedEmbeddings).not.toHaveBeenCalled();
  });

  it('does not throw when the retry run fails', async () => {
    pipeline.retryFailedEmbeddings.mockRejectedValue(new Error('db down'));
    await expect(cron.handleRetry()).resolves.toBeUndefined();
  });
});
