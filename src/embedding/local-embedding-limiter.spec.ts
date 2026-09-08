import { withLocalEmbeddingSlot } from './local-embedding-limiter';

describe('local embedding admission', () => {
  it('serializes different callers through completion and releases after failure', async () => {
    let release!: () => void;
    let active = 0;
    let peak = 0;
    const first = withLocalEmbeddingSlot(async () => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      active--;
      throw new Error('provider failed');
    });
    const failure = expect(first).rejects.toThrow('provider failed');
    const second = withLocalEmbeddingSlot(async () => {
      peak = Math.max(peak, ++active);
      active--;
      return 'recovered';
    });
    release();
    await failure;
    expect(await second).toBe('recovered');
    expect(peak).toBe(1);
  });

  it('expires queued work without stealing a later permit', async () => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      const first = withLocalEmbeddingSlot(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const queuedWork = jest.fn(async () => 1);
      const queued = withLocalEmbeddingSlot(queuedWork);
      const rejected = expect(queued).rejects.toThrow('admission timed out');
      await jest.advanceTimersByTimeAsync(5000);
      await rejected;
      release();
      await first;
      expect(queuedWork).not.toHaveBeenCalled();
      expect(await withLocalEmbeddingSlot(async () => 2)).toBe(2);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects excess pending work with transient backpressure', async () => {
    let release!: () => void;
    const first = withLocalEmbeddingSlot(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = Array.from({ length: 64 }, () =>
      withLocalEmbeddingSlot(async () => 1),
    );
    await expect(withLocalEmbeddingSlot(async () => 2)).rejects.toThrow(
      'admission queue full',
    );
    release();
    await Promise.all([first, ...pending]);
  });
});
