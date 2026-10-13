import { buildOpsSummary, percentile } from './ops-metrics';

describe('ops-metrics', () => {
  it('interpolates percentiles and handles empty input', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    // rank = 0.95 * 4 = 3.8 → 4 + 0.8 * (100 - 4)
    expect(percentile([3, 1, 2, 4, 100], 0.95)).toBeCloseTo(80.8);
  });

  it('summarizes latency and approximate tokens', () => {
    const summary = buildOpsSummary([
      {
        queryId: 'a',
        latencyMs: 10,
        resultCount: 2,
        contentChars: 400,
        payloadChars: 800,
      },
      {
        queryId: 'b',
        latencyMs: 30,
        resultCount: 0,
        contentChars: 0,
        payloadChars: 2,
      },
    ]);
    expect(summary).toEqual({
      n: 2,
      latencyP50Ms: 20,
      latencyP95Ms: 29,
      latencyMaxMs: 30,
      meanResultCount: 1,
      meanContentTokensApprox: 50,
      meanPayloadTokensApprox: 100,
      tokenMethod: 'chars/4',
    });
  });

  it('returns nulls for no samples', () => {
    expect(buildOpsSummary([]).latencyP95Ms).toBeNull();
    expect(buildOpsSummary([]).meanContentTokensApprox).toBeNull();
  });
});
