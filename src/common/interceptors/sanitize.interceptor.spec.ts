import { of } from 'rxjs';
import { SanitizeInterceptor } from './sanitize.interceptor';

// Minimal stubs for NestJS interceptor plumbing
const makeCallHandler = (returnValue: any) => ({
  handle: () => of(returnValue),
});

const makeContext = () => ({}) as any;

describe('SanitizeInterceptor', () => {
  let interceptor: SanitizeInterceptor;

  beforeEach(() => {
    interceptor = new SanitizeInterceptor();
  });

  const collect = async (value: any): Promise<any> => {
    return new Promise((resolve, reject) => {
      interceptor
        .intercept(makeContext(), makeCallHandler(value))
        .subscribe({ next: resolve, error: reject });
    });
  };

  // ── Basic passthrough ────────────────────────────────────────────────────────

  it('should pass through null unchanged', async () => {
    expect(await collect(null)).toBeNull();
  });

  it('should pass through undefined unchanged', async () => {
    expect(await collect(undefined)).toBeUndefined();
  });

  it('should pass through a number unchanged', async () => {
    expect(await collect(42)).toBe(42);
  });

  it('should pass through a plain string unchanged (no html)', async () => {
    expect(await collect('hello world')).toBe('hello world');
  });

  // ── HTML escaping on `raw` field ─────────────────────────────────────────────

  it('should escape < and > in a raw field', async () => {
    const result = await collect({ id: '1', raw: '<script>alert(1)</script>' });
    expect(result.raw).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('should escape & in a raw field', async () => {
    const result = await collect({ raw: 'AT&T' });
    expect(result.raw).toBe('AT&amp;T');
  });

  it('should escape double quotes in a raw field', async () => {
    const result = await collect({ raw: '"quoted"' });
    expect(result.raw).toBe('&quot;quoted&quot;');
  });

  it('should escape single quotes in a raw field', async () => {
    const result = await collect({ raw: "it's fine" });
    expect(result.raw).toBe('it&#x27;s fine');
  });

  it('should not modify non-raw string fields', async () => {
    const result = await collect({
      id: '1',
      title: '<b>bold</b>',
      raw: 'clean',
    });
    expect(result.title).toBe('<b>bold</b>');
    expect(result.raw).toBe('clean');
  });

  // ── Nested objects ───────────────────────────────────────────────────────────

  it('should recursively sanitize raw fields in nested objects', async () => {
    const input = { outer: { raw: '<b>xss</b>' } };
    const result = await collect(input);
    expect(result.outer.raw).toBe('&lt;b&gt;xss&lt;/b&gt;');
  });

  it('should recursively sanitize deeply nested raw fields', async () => {
    const input = { a: { b: { raw: '<img onerror="x">' } } };
    const result = await collect(input);
    expect(result.a.b.raw).toBe('&lt;img onerror=&quot;x&quot;&gt;');
  });

  it('should not mutate the original object', async () => {
    const input = { raw: '<script>' };
    const result = await collect(input);
    expect(input.raw).toBe('<script>');
    expect(result.raw).toBe('&lt;script&gt;');
  });

  // ── Arrays ───────────────────────────────────────────────────────────────────

  it('should sanitize raw fields in an array of objects', async () => {
    const input = [{ raw: '<em>' }, { raw: 'clean' }];
    const result = await collect(input);
    expect(result[0].raw).toBe('&lt;em&gt;');
    expect(result[1].raw).toBe('clean');
  });

  it('should handle arrays of primitives without error', async () => {
    const result = await collect([1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
  });

  it('should handle an empty array', async () => {
    const result = await collect([]);
    expect(result).toEqual([]);
  });

  // ── Date preservation ────────────────────────────────────────────────────────

  it('should preserve Date instances without conversion', async () => {
    const d = new Date('2026-01-01');
    const result = await collect({ createdAt: d });
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.toISOString()).toBe(d.toISOString());
  });

  // ── XSS payload coverage ─────────────────────────────────────────────────────

  it('should neutralise a JS event handler injection', async () => {
    const result = await collect({ raw: '<img src=x onerror=alert(1)>' });
    expect(result.raw).not.toContain('<');
    expect(result.raw).not.toContain('>');
  });

  it('should neutralise a full XSS polyglot in raw', async () => {
    const payload = `"><svg/onload=confirm(1)>'`;
    const result = await collect({ raw: payload });
    expect(result.raw).not.toMatch(/[<>"']/);
  });
});
