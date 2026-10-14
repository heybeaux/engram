import { recallQuestion } from '../src/recall';

const ingest = { questionId: 'q1', sessionId: 's', userId: 'u', agentId: 'a', memoryIds: [], chunks: 0 };
const config = {
  apiBase: 'http://x',
  apiKey: 'k',
  anthropicApiKey: '',
  readModel: 'm',
} as any;

describe('recallQuestion referenceDate flag (LME_REFERENCE_DATE)', () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ memories: [] }), { status: 200 }),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.LME_REFERENCE_DATE;
  });

  const body = () => JSON.parse(fetchSpy.mock.calls[0][1].body);

  it('default: no referenceDate', async () => {
    await recallQuestion('q1', 'what 10 days ago', ingest, config, 'temporal-reasoning-ability', '2023/03/25 (Sat) 18:26');
    expect(body()).not.toHaveProperty('referenceDate');
  });

  it('flag on: sends question_date as ISO referenceDate', async () => {
    process.env.LME_REFERENCE_DATE = '1';
    await recallQuestion('q1', 'what 10 days ago', ingest, config, 'temporal-reasoning-ability', '2023/03/25 (Sat) 18:26');
    expect(body().referenceDate).toBe('2023-03-25T18:26:00.000Z');
  });

  it('flag on but no question_date: omitted', async () => {
    process.env.LME_REFERENCE_DATE = '1';
    await recallQuestion('q1', 'x', ingest, config, 'temporal-reasoning-ability');
    expect(body()).not.toHaveProperty('referenceDate');
  });
});
