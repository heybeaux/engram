import {
  QueryEmbeddingCache,
  QUERY_EMBED_CACHE_DEFAULT_TTL_MS,
  QUERY_EMBED_CACHE_MAX_SIZE,
} from './query-embedding-cache';
import { EmbeddingService } from './embedding.service';

describe('QueryEmbeddingCache (ENG-36 F4)', () => {
  it('is disabled for size 0, negative, NaN and non-integer sizes', () => {
    for (const size of [0, -1, NaN, 1.5, Infinity]) {
      const cache = new QueryEmbeddingCache(size);
      expect(cache.enabled).toBe(false);
      cache.set('q', [1, 2]);
      expect(cache.get('q')).toBeUndefined();
      expect(cache.stats().size).toBe(0);
    }
  });

  it('clamps oversized caches to the max size', () => {
    expect(new QueryEmbeddingCache(1e9).maxSize).toBe(
      QUERY_EMBED_CACHE_MAX_SIZE,
    );
  });

  it('parses env strictly and stays off when unset or malformed', () => {
    expect(QueryEmbeddingCache.fromEnv({}).enabled).toBe(false);
    for (const v of ['0', '-5', 'abc', '10abc', '']) {
      expect(
        QueryEmbeddingCache.fromEnv({ RECALL_QUERY_EMBED_CACHE_SIZE: v })
          .enabled,
      ).toBe(false);
    }
    const on = QueryEmbeddingCache.fromEnv({
      RECALL_QUERY_EMBED_CACHE_SIZE: '64',
      RECALL_QUERY_EMBED_CACHE_TTL_MS: 'bogus',
    });
    expect(on.maxSize).toBe(64);
    expect(on.ttlMs).toBe(QUERY_EMBED_CACHE_DEFAULT_TTL_MS);
    expect(
      QueryEmbeddingCache.fromEnv({
        RECALL_QUERY_EMBED_CACHE_SIZE: '8',
        RECALL_QUERY_EMBED_CACHE_TTL_MS: '5000',
      }).ttlMs,
    ).toBe(5000);
  });

  it('evicts the least recently used entry and never exceeds maxSize', () => {
    const cache = new QueryEmbeddingCache(2);
    cache.set('a', [1]);
    cache.set('b', [2]);
    expect(cache.get('a')).toEqual([1]); // a is now most recent
    cache.set('c', [3]); // evicts b
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual([1]);
    expect(cache.get('c')).toEqual([3]);
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, [i]);
    expect(cache.stats().size).toBe(2);
  });

  it('works with maxSize 1 (re-set of the same key does not evict others)', () => {
    const cache = new QueryEmbeddingCache(1);
    cache.set('a', [1]);
    cache.set('a', [2]);
    expect(cache.get('a')).toEqual([2]);
    cache.set('b', [3]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.stats().size).toBe(1);
  });

  it('expires entries after the TTL', () => {
    let t = 1000;
    const cache = new QueryEmbeddingCache(4, 100, () => t);
    cache.set('a', [1]);
    t = 1099;
    expect(cache.get('a')).toEqual([1]);
    t = 1100;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });

  it('returns copies so callers cannot corrupt the cached vector', () => {
    const cache = new QueryEmbeddingCache(4);
    const v = [1, 2, 3];
    cache.set('a', v);
    v[0] = 99;
    const got = cache.get('a')!;
    got[1] = 99;
    expect(cache.get('a')).toEqual([1, 2, 3]);
  });

  it('ignores empty embeddings and counts hits/misses', () => {
    const cache = new QueryEmbeddingCache(4);
    cache.set('empty', []);
    expect(cache.get('empty')).toBeUndefined();
    cache.set('a', [1]);
    cache.get('a');
    cache.get('a');
    expect(cache.stats()).toMatchObject({ hits: 2, misses: 1, size: 1 });
  });
});

describe('EmbeddingService.generateForRecall query cache (ENG-36 F4)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function build(provider = 'openai', model = 'text-embedding-3-small') {
    const facade = {
      embedOneWithOptions: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedOne: jest.fn().mockResolvedValue([0.4, 0.5, 0.6]),
      getProviderName: jest.fn().mockReturnValue(provider),
      getModelName: jest.fn().mockReturnValue(model),
    };
    const service = new EmbeddingService(
      { embed: jest.fn() } as any,
      {} as any,
      facade as any,
    );
    return { service, facade };
  }

  it('calls the provider every time when the flag is off (default)', async () => {
    delete process.env.RECALL_QUERY_EMBED_CACHE_SIZE;
    const { service, facade } = build();
    await service.generateForRecall('current priorities');
    await service.generateForRecall('current priorities');
    expect(facade.embedOneWithOptions).toHaveBeenCalledTimes(2);
    expect(service.getQueryEmbeddingCacheStats().enabled).toBe(false);
  });

  it('serves repeated query text from the cache when enabled', async () => {
    process.env.RECALL_QUERY_EMBED_CACHE_SIZE = '16';
    const { service, facade } = build();
    const a = await service.generateForRecall('current priorities');
    const b = await service.generateForRecall('current priorities');
    await service.generateForRecall('something else');
    expect(a).toEqual([0.1, 0.2, 0.3]);
    expect(b).toEqual(a);
    expect(facade.embedOneWithOptions).toHaveBeenCalledTimes(2);
    expect(service.getQueryEmbeddingCacheStats()).toMatchObject({
      hits: 1,
      misses: 2,
      size: 2,
    });
  });

  it('never caches a generate() fallback vector or a failure', async () => {
    process.env.RECALL_QUERY_EMBED_CACHE_SIZE = '16';
    const { service, facade } = build();
    facade.embedOneWithOptions.mockRejectedValue(new Error('timeout'));
    facade.embedOne.mockRejectedValueOnce(new Error('down'));
    await expect(service.generateForRecall('q')).rejects.toThrow('down');
    expect(await service.generateForRecall('q')).toEqual([0.4, 0.5, 0.6]);
    expect(await service.generateForRecall('q')).toEqual([0.4, 0.5, 0.6]);
    expect(facade.embedOne).toHaveBeenCalledTimes(3);
    expect(service.getQueryEmbeddingCacheStats()).toMatchObject({
      hits: 0,
      size: 0,
    });
  });

  it('calls the facade again once it recovers after a fallback', async () => {
    process.env.RECALL_QUERY_EMBED_CACHE_SIZE = '16';
    const { service, facade } = build();
    facade.embedOneWithOptions.mockRejectedValueOnce(new Error('timeout'));
    expect(await service.generateForRecall('q')).toEqual([0.4, 0.5, 0.6]);
    expect(await service.generateForRecall('q')).toEqual([0.1, 0.2, 0.3]);
    expect(await service.generateForRecall('q')).toEqual([0.1, 0.2, 0.3]);
    expect(facade.embedOneWithOptions).toHaveBeenCalledTimes(2);
    expect(service.getQueryEmbeddingCacheStats().hits).toBe(1);
  });

  it('keys on provider and model so vectors never cross models', async () => {
    process.env.RECALL_QUERY_EMBED_CACHE_SIZE = '16';
    const { service, facade } = build('openai', 'small');
    await service.generateForRecall('q');
    facade.getModelName.mockReturnValue('large');
    await service.generateForRecall('q');
    expect(facade.embedOneWithOptions).toHaveBeenCalledTimes(2);
  });
});
