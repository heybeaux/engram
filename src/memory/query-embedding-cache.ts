/**
 * ENG-36 F4: bounded LRU of recall query text → embedding.
 *
 * SessionStart hooks send the same query text on every session, so a hit
 * saves one embedding-provider round trip (an OpenAI call in prod). Off by
 * default; RECALL_QUERY_EMBED_CACHE_SIZE > 0 turns it on.
 *
 * Size is validated up front: a non-positive or non-numeric size disables the
 * cache instead of reaching an eviction loop (see the PrefetchCacheService
 * maxSize=0 gotcha in CLAUDE.md), and sizes above MAX_SIZE are clamped.
 */
export const QUERY_EMBED_CACHE_MAX_SIZE = 2048;
// Same text + provider + model always embeds the same, so TTL only bounds memory
// held by one-off queries; long enough that SessionStart repeats across a day hit.
export const QUERY_EMBED_CACHE_DEFAULT_TTL_MS = 24 * 60 * 60_000;

export interface QueryEmbeddingCacheStats {
  enabled: boolean;
  size: number;
  maxSize: number;
  ttlMs: number;
  hits: number;
  misses: number;
}

function positiveInt(value: string | undefined): number {
  if (value === undefined || !/^\s*\d+\s*$/.test(value)) return 0;
  return Number.parseInt(value, 10);
}

export class QueryEmbeddingCache {
  readonly maxSize: number;
  readonly ttlMs: number;
  private readonly entries = new Map<
    string,
    { embedding: number[]; expiresAt: number }
  >();
  private hits = 0;
  private misses = 0;

  constructor(
    maxSize: number,
    ttlMs: number = QUERY_EMBED_CACHE_DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.maxSize =
      Number.isInteger(maxSize) && maxSize > 0
        ? Math.min(maxSize, QUERY_EMBED_CACHE_MAX_SIZE)
        : 0;
    this.ttlMs =
      Number.isInteger(ttlMs) && ttlMs > 0
        ? ttlMs
        : QUERY_EMBED_CACHE_DEFAULT_TTL_MS;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): QueryEmbeddingCache {
    const ttl = positiveInt(env.RECALL_QUERY_EMBED_CACHE_TTL_MS);
    return new QueryEmbeddingCache(
      positiveInt(env.RECALL_QUERY_EMBED_CACHE_SIZE),
      ttl > 0 ? ttl : QUERY_EMBED_CACHE_DEFAULT_TTL_MS,
    );
  }

  get enabled(): boolean {
    return this.maxSize > 0;
  }

  /** Returns a copy so callers can't mutate the cached vector. */
  get(key: string): number[] | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    // Re-insert to mark as most recently used (Map keeps insertion order).
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry.embedding.slice();
  }

  set(key: string, embedding: number[]): void {
    if (!this.enabled || !Array.isArray(embedding) || embedding.length === 0) {
      return;
    }
    this.entries.delete(key);
    // Bounded: at most one eviction per insert because size <= maxSize holds.
    if (this.entries.size >= this.maxSize) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, {
      embedding: embedding.slice(),
      expiresAt: this.now() + this.ttlMs,
    });
  }

  stats(): QueryEmbeddingCacheStats {
    return {
      enabled: this.enabled,
      size: this.entries.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
    };
  }
}
