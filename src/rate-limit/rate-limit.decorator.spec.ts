import {
  RATE_LIMIT_KEY,
  RateLimit,
  SKIP_RATE_LIMIT_KEY,
  SkipRateLimit,
} from './rate-limit.decorator';

describe('RateLimit Decorators', () => {
  describe('RateLimit', () => {
    it('should set metadata with the given requests per minute', () => {
      const decorator = RateLimit(50);
      // SetMetadata returns a decorator function — apply it to extract metadata
      const target = {};
      decorator(target, undefined as any, undefined as any);
      const metadata = Reflect.getMetadata(RATE_LIMIT_KEY, target);
      expect(metadata).toBe(50);
    });

    it('should work with different rate values', () => {
      const decorator = RateLimit(200);
      const target = {};
      decorator(target, undefined as any, undefined as any);
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, target)).toBe(200);
    });

    it('should handle zero rate limit', () => {
      const decorator = RateLimit(0);
      const target = {};
      decorator(target, undefined as any, undefined as any);
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, target)).toBe(0);
    });

    it('should export the correct metadata key', () => {
      expect(RATE_LIMIT_KEY).toBe('rateLimit');
    });
  });

  describe('SkipRateLimit', () => {
    it('should set skip metadata to true', () => {
      const decorator = SkipRateLimit();
      const target = {};
      decorator(target, undefined as any, undefined as any);
      expect(Reflect.getMetadata(SKIP_RATE_LIMIT_KEY, target)).toBe(true);
    });

    it('should export the correct metadata key', () => {
      expect(SKIP_RATE_LIMIT_KEY).toBe('skipRateLimit');
    });
  });
});
