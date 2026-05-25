import { fetchSessionCoverage, waitForSessionReadiness } from '../src/readiness';

describe('LongMemEval readiness gate', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('counts extracted session memories across paginated responses', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 3,
          memories: [{ extraction: { id: 'e1' } }, { extraction: null }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 3,
          memories: [{ extraction: { id: 'e2' } }],
        }),
      });

    global.fetch = fetchMock as typeof fetch;

    await expect(
      fetchSessionCoverage(
        'http://localhost:3000',
        { 'X-AM-API-Key': 'key' },
        'user-1',
        'agent-1',
        'session-1',
      ),
    ).resolves.toEqual({
      total: 3,
      extracted: 2,
    });
  });

  it('waits until scoped session coverage is complete before returning', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 2,
          memories: [{ extraction: { id: 'e1' } }, { extraction: null }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 2,
          memories: [{ extraction: { id: 'e1' } }, { extraction: { id: 'e2' } }],
        }),
      });

    global.fetch = fetchMock as typeof fetch;
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => {
      fn();
      return 0 as any;
    }) as typeof setTimeout);

    await expect(
      waitForSessionReadiness(
        'user-1',
        'agent-1',
        'session-1',
        2,
        { apiBase: 'http://localhost:3000', apiKey: 'key' },
        100,
        1,
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/v1/memories?');
    expect(fetchMock.mock.calls[0]?.[0]).toContain('sessionId=session-1');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/v1/memories?');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('sessionId=session-1');
  });

  it('throws when scoped session coverage never reaches the expected count', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 3,
        memories: [{ extraction: { id: 'e1' } }, { extraction: null }, { extraction: null }],
      }),
    });

    global.fetch = fetchMock as typeof fetch;
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => {
      fn();
      return 0 as any;
    }) as typeof setTimeout);

    await expect(
      waitForSessionReadiness(
        'user-1',
        'agent-1',
        'session-1',
        3,
        { apiBase: 'http://localhost:3000', apiKey: 'key' },
        5,
        1,
      ),
    ).rejects.toThrow(
      'Session readiness timeout for session-1: extracted 1/3 from 3 session memories after 5ms',
    );
  });
});
