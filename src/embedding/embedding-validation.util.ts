/**
 * Centralized strict embedding validation (adversarial audit H3).
 *
 * One validator, used by every provider AND by the memory-side embedding
 * facade's store() immediately before vector upsert. This is the single
 * gate that prevents malformed vectors (e.g. sparse arrays that serialize
 * to "[,,,,]" and trigger pgvector 22P02) from reaching the database.
 *
 * IMPORTANT: validation iterates by index. `.some()` / `.every()` SKIP
 * holes in sparse arrays (e.g. `new Array(768)` that was never fully
 * populated), so they cannot detect the exact failure mode this guards
 * against. Indexed access reads holes as `undefined`, which fails the
 * finiteness check.
 */

/**
 * Error class for transient, retryable embedding failures (adversarial
 * audit M2) — e.g. a 503 "inference backlog" from engram-embed. Callers
 * (notably the circuit breaker in memory/embedding.service.ts) must NOT
 * count these toward consecutive-failure thresholds.
 */
export class TransientEmbeddingError extends Error {
  /** Marker so the check survives error-wrapping across module boundaries */
  readonly transient = true;

  constructor(message: string) {
    super(message);
    this.name = 'TransientEmbeddingError';
  }
}

/** True if the error represents a transient, retryable embedding failure. */
export function isTransientEmbeddingError(error: unknown): boolean {
  return (
    error instanceof TransientEmbeddingError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { transient?: unknown }).transient === true)
  );
}

export interface EmbeddingValidationOptions {
  /** When provided, the embedding must have exactly this many dimensions */
  expectedDimensions?: number;
  /** Context string included in error messages (e.g. "index 0", "store mem-1") */
  context?: string;
}

/**
 * Strictly validate an embedding vector. Throws on:
 *  - non-array input
 *  - empty array
 *  - dimension mismatch (when expectedDimensions is provided)
 *  - any slot that is not a finite number (including sparse-array holes,
 *    undefined, null, NaN, Infinity, strings)
 *
 * Returns the validated embedding typed as number[].
 */
export function assertValidEmbedding(
  embedding: unknown,
  options?: EmbeddingValidationOptions,
): number[] {
  const ctx = options?.context ? ` (${options.context})` : '';

  if (!Array.isArray(embedding)) {
    throw new Error(
      `Invalid embedding${ctx}: expected array, got ${embedding === null ? 'null' : typeof embedding}`,
    );
  }

  if (embedding.length === 0) {
    throw new Error(`Invalid embedding${ctx}: empty array`);
  }

  if (
    options?.expectedDimensions !== undefined &&
    embedding.length !== options.expectedDimensions
  ) {
    throw new Error(
      `Invalid embedding${ctx}: expected ${options.expectedDimensions} dimensions, got ${embedding.length}`,
    );
  }

  // Index-based loop — deliberately NOT .some()/.every(), which skip holes
  // in sparse arrays and would let "[,,,,]" through to pgvector.
  for (let i = 0; i < embedding.length; i++) {
    const value = embedding[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `Invalid embedding${ctx}: contains non-finite values (index ${i}: ${String(value)})`,
      );
    }
  }

  return embedding as number[];
}
