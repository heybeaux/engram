import {
  assertSanityGate,
  MIN_MEANINGFUL_MEMORY_COUNT,
} from './dream-cycle-sanity-gate';

describe('assertSanityGate', () => {
  it('passes when rowsTouched meets threshold', () => {
    expect(() => assertSanityGate('dedup', 5850, 6500)).not.toThrow();
  });
  it('passes at exactly threshold', () => {
    expect(() => assertSanityGate('dedup', 5850, 6500, 0.9)).not.toThrow();
  });
  it('throws when rowsTouched is below threshold', () => {
    expect(() => assertSanityGate('dedup', 1, 6500)).toThrow(
      'sanity gate FAILED',
    );
  });
  it('throws with informative message', () => {
    expect(() => assertSanityGate('dedup', 1, 6500)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('processed 1 memories'),
      }),
    );
  });
  it('does NOT throw when total memories below MIN_MEANINGFUL_MEMORY_COUNT', () => {
    expect(() =>
      assertSanityGate('dedup', 0, MIN_MEANINGFUL_MEMORY_COUNT - 1),
    ).not.toThrow();
  });
  it('uses custom threshold', () => {
    expect(() => assertSanityGate('dedup', 4000, 6500, 0.5)).not.toThrow();
    expect(() => assertSanityGate('dedup', 2000, 6500, 0.5)).toThrow(
      'sanity gate FAILED',
    );
  });
  it('includes stage name in error', () => {
    expect(() => assertSanityGate('staleness', 1, 6500)).toThrow(
      "stage 'staleness'",
    );
  });
});
