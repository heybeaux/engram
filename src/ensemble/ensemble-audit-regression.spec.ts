import { EnsembleService } from './ensemble.service';
import { PgVectorEnsembleProvider } from './pgvector-ensemble.provider';

const vector = (value = 0.1) => Array(768).fill(value);
const result = (model = 'bge-base', value = 0.1) => ({
  model,
  embedding: vector(value),
  dimensions: 768,
  latencyMs: 0,
});

describe('Ensemble audit regressions', () => {
  let service: EnsembleService;
  let storage: any;
  const originalFetch = global.fetch;
  beforeEach(() => {
    storage = {
      upsertEmbeddings: jest.fn(),
      queryWithModelEmbeddings: jest.fn(),
    };
    service = new EnsembleService(
      {
        get: (key: string, fallback: any) =>
          key === 'ENSEMBLE_ENABLED'
            ? true
            : key === 'ENSEMBLE_MODELS'
              ? 'bge-base,nomic'
              : fallback,
      } as any,
      storage,
      {
        memory: {
          findMany: async () =>
            ['a', 'b', 'c'].map((id) => ({ id, raw: id, userId: 'user' })),
        },
      } as any,
      {} as any,
      {} as any,
    );
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each([
    [{ embedding: vector(0.1) }, {}, { embedding: vector(0.3) }],
    [
      { index: 0, embedding: vector() },
      { index: 0, embedding: vector() },
      { index: 2, embedding: vector() },
    ],
    [
      { index: 0, embedding: vector() },
      { index: 2, embedding: vector() },
    ],
    [
      { index: 0, embedding: vector() },
      { embedding: vector() },
      { index: 2, embedding: vector() },
    ],
  ])(
    'rejects ambiguous/missing batch vectors before any write (%#)',
    async (...entries) => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          embeddings: [{ model: 'bge-base', data: entries }],
        }),
      });
      await expect(
        service.embedBatchForMemories(['a', 'b', 'c'], ['bge-base']),
      ).rejects.toThrow();
      expect(storage.upsertEmbeddings).not.toHaveBeenCalled();
    },
  );

  it('reorders explicit indices to preserve memory identity', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        embeddings: [
          {
            model: 'bge-base',
            data: [2, 0, 1].map((index) => ({
              index,
              embedding: vector(index + 1),
            })),
          },
        ],
      }),
    });
    await service.embedBatchForMemories(['a', 'b', 'c'], ['bge-base']);
    expect(
      storage.upsertEmbeddings.mock.calls[0][0].map((row: any) => [
        row.memoryId,
        row.embedding[0],
      ]),
    ).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });

  it('rejects compressed cloud batches before positional assignment', async () => {
    (service as any).useCloud = true;
    (service as any).cloudEnsemble = {
      embedBatch: async () => ({
        embeddings: [result(), result('bge-base', 0.3)],
      }),
    };
    await expect(
      service.embedBatchForMemories(['a', 'b', 'c'], ['bge-base']),
    ).rejects.toThrow('Incomplete batch');
    expect(storage.upsertEmbeddings).not.toHaveBeenCalled();
  });

  it('returns retryable failure for no query or write embeddings', async () => {
    jest
      .spyOn(service, 'embedAll')
      .mockResolvedValue({ embeddings: [], totalMs: 1 });
    await expect(
      service.query({ query: 'fact', userId: 'user' }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      service.upsert({ memoryId: 'a', content: 'fact', userId: 'user' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(storage.upsertEmbeddings).not.toHaveBeenCalled();
    expect(storage.queryWithModelEmbeddings).not.toHaveBeenCalled();
  });

  it('distinguishes degraded successful empty search from total backend failure', async () => {
    jest
      .spyOn(service, 'embedAll')
      .mockResolvedValue({ embeddings: [result() as any], totalMs: 1 });
    storage.queryWithModelEmbeddings.mockResolvedValue(
      new Map([['bge-base', []]]),
    );
    const response = await service.query({ query: 'fact', userId: 'user' });
    expect(response.results).toEqual([]);
    expect(response.metadata).toMatchObject({
      degraded: true,
      failedModels: ['nomic'],
      modelsQueried: ['bge-base'],
    });
    storage.queryWithModelEmbeddings.mockResolvedValue(new Map());
    await expect(
      service.query({ query: 'fact', userId: 'user' }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('honors an explicit model subset', async () => {
    jest.spyOn(service, 'embedAll').mockResolvedValue({
      embeddings: [result() as any, result('nomic') as any],
      totalMs: 1,
    });
    storage.queryWithModelEmbeddings.mockResolvedValue(
      new Map([['bge-base', []]]),
    );
    const response = await service.query({
      query: 'fact',
      userId: 'user',
      models: ['bge-base'],
    });
    expect([
      ...storage.queryWithModelEmbeddings.mock.calls[0][0].keys(),
    ]).toEqual(['bge-base']);
    expect(response.metadata.degraded).toBe(false);
  });
});

describe('Ensemble storage validation', () => {
  let db: any;
  let provider: PgVectorEnsembleProvider;
  beforeEach(() => {
    db = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn(async (fn) => fn(db)),
    };
    provider = new PgVectorEnsembleProvider(db);
  });
  it.each(
    [
      new Array(768),
      vector().map((v, i) => (i === 10 ? NaN : v)),
      vector().map((v, i) => (i === 10 ? Infinity : v)),
      [0.1],
      [],
    ].map((embedding) => [embedding]),
  )(
    'rejects malformed vectors at single and batch storage boundaries (%#)',
    async (embedding) => {
      const record = {
        memoryId: 'm',
        modelId: 'bge-base' as const,
        dimensions: 768,
        embedding,
      };
      await expect(provider.upsertEmbedding(record)).rejects.toThrow();
      await expect(provider.upsertEmbeddings([record])).rejects.toThrow();
      expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects metadata dimensions inconsistent with the model', async () => {
    await expect(
      provider.upsertEmbedding({
        memoryId: 'm',
        modelId: 'bge-base',
        dimensions: 384,
        embedding: vector(),
      }),
    ).rejects.toThrow('Invalid dimensions');
  });
  it('does not call a zero-row write successful', async () => {
    db.$executeRawUnsafe.mockResolvedValue(0);
    const record = {
      memoryId: 'missing',
      modelId: 'bge-base' as const,
      dimensions: 768,
      embedding: vector(),
    };
    await expect(provider.upsertEmbedding(record)).rejects.toMatchObject({
      status: 503,
    });
    await expect(provider.upsertEmbeddings([record])).rejects.toMatchObject({
      status: 503,
    });
  });
});
