import { fetchWithRetry } from '../src/ingest';

describe('fetchWithRetry 5xx handling', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('retries a 529 overloaded response and returns the later success', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ status: 529, ok: false, headers: new Headers() })
      .mockResolvedValueOnce({ status: 200, ok: true, headers: new Headers() });
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await fetchWithRetry('http://x', {});
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the last 5xx response after exhausting retries', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 529, ok: false, headers: new Headers() });
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await fetchWithRetry('http://x', {}, 3);
    expect(res.status).toBe(529);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx other than 429', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 400, ok: false, headers: new Headers() });
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await fetchWithRetry('http://x', {});
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
