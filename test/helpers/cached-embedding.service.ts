/**
 * CachedEmbeddingService (test stub)
 *
 * Returns pre-computed vectors for test inputs to avoid hitting real embedding APIs.
 * Vectors are seeded deterministically from the input text so that identical
 * inputs always produce the same vector (important for recall-score assertions).
 *
 * Full fixture file will be wired in ENG-21; for now we generate random-but-stable
 * vectors using a simple hash-based seed.
 */

import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

/** Dimensions matching the local embed provider default (384) */
const DIMS = 384;

/**
 * Generate a deterministic pseudo-random unit vector for a given text.
 * Uses SHA-256 of the text as a seed so the same text always returns the same vector.
 */
function deterministicVector(text: string): number[] {
  const hash = createHash('sha256').update(text).digest();
  const vec: number[] = [];

  // Expand the 32-byte hash into DIMS floats via repeated hashing
  let buf = hash;
  while (vec.length < DIMS) {
    for (let i = 0; i < buf.length && vec.length < DIMS; i++) {
      // Map byte [0, 255] → float [-1, 1]
      vec.push((buf[i] - 128) / 128);
    }
    // Re-hash for more entropy if needed
    buf = createHash('sha256').update(buf).digest();
  }

  // L2-normalize so cosine similarity is well-defined
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

@Injectable()
export class CachedEmbeddingService {
  /**
   * Return a deterministic vector for a single text.
   * Drop-in replacement for EmbeddingService.embedOne().
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async embedOne(text: string): Promise<number[]> {
    return deterministicVector(text);
  }

  /**
   * Return deterministic vectors for multiple texts.
   * Drop-in replacement for EmbeddingService.embed().
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(deterministicVector);
  }

  /** Compatibility shim — always returns 'cached-stub' */
  getModelName(): string {
    return 'cached-stub';
  }

  /** Dimensions of returned vectors */
  getDimensions(): number {
    return DIMS;
  }
}
